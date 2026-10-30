// Test harness: boots a project's index.html in jsdom, wired to the project's REAL
// netlify/functions/data.js running over an in-memory fake of @netlify/blobs.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { JSDOM, VirtualConsole } = require('jsdom');

function makeServer(projectDir) {
  const blobs = new Map();
  const fakeBlobs = {
    getStore() {
      return {
        async get(key) { return blobs.has(key) ? JSON.parse(blobs.get(key)) : null; },
        async setJSON(key, val) { blobs.set(key, JSON.stringify(val)); },
      };
    },
  };
  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    if (req === '@netlify/blobs') return fakeBlobs;
    return origLoad.call(this, req, ...rest);
  };
  const file = path.join(projectDir, 'netlify/functions/data.js');
  delete require.cache[require.resolve(file)];
  const { handler } = require(file);
  const server = {
    blobs,
    online: true,
    latencyMs: 0,
    postCount: 0,
    failNextPosts: 0,
    async call(method, body) {
      if (!server.online) throw new TypeError('Failed to fetch (offline)');
      if (server.latencyMs) await new Promise(r => setTimeout(r, server.latencyMs));
      if (method === 'POST') {
        server.postCount++;
        if (server.failNextPosts > 0) { server.failNextPosts--; throw new TypeError('Failed to fetch (injected)'); }
      }
      const res = await handler({ httpMethod: method, body: body || '' });
      return {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        json: async () => JSON.parse(res.body || 'null'),
      };
    },
    state() { return blobs.has('state') ? JSON.parse(blobs.get('state')) : { tests: [], submissions: [], assignments: [], peerSessions: [] }; },
    seed(state) { blobs.set('state', JSON.stringify(state)); },
  };
  return server;
}

async function boot({ projectDir, server, query = '', beforeScripts } = {}) {
  const html = fs.readFileSync(path.join(projectDir, 'index.html'), 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e && e.stack || e)));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  const dom = new JSDOM(html, {
    url: 'http://localhost/' + query,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.katex = { renderToString: c => '<span class="katex">' + c + '</span>' };
      win.renderMathInElement = () => {};
      win.Quill = class FakeQuill {
        constructor(el) { const doc = (el && el.ownerDocument) || win.document; this.root = doc.createElement('div'); this.root.className = 'ql-editor'; (el && el.nodeType ? el : doc.body).appendChild(this.root); this._h = {}; this.clipboard = { dangerouslyPasteHTML: h => { this.root.innerHTML = h; } }; }
        on(ev, fn) { this._h[ev] = fn; }
      };
      win.confirm = () => true;
      win.alert = () => {};
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = () => {};
      win.navigator.clipboard = { writeText: async () => {} };
      win.fetch = async (url, opts) => {
        if (String(url).includes('/.netlify/functions/data')) {
          return server.call((opts && opts.method) || 'GET', opts && opts.body);
        }
        throw new Error('unexpected fetch ' + url);
      };
      if (beforeScripts) beforeScripts(win);
    },
  });
  const win = dom.window;
  // wait for DOMContentLoaded boot (loadState) to finish
  for (let i = 0; i < 200; i++) {
    if (!win.document.getElementById('ea-loading-overlay')) break;
    await new Promise(r => setTimeout(r, 10));
  }
  return { dom, win, errors, ev: code => win.eval(code), sleep: ms => new Promise(r => setTimeout(r, ms)) };
}

module.exports = { makeServer, boot };
