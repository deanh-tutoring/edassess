// EdAssess shared data store — Netlify Function backed by Netlify Blobs.
//
// v2 STORAGE MODEL (replaces the old single "state" blob)
// ─────────────────────────────────────────────────────────────────────────────
// The old design kept EVERY test, assignment and student submission in ONE blob and
// rewrote the whole thing on every request. That caused:
//   • lost updates  — two overlapping requests (e.g. a student's autosave and your Save)
//                     each read the old blob and the last writer silently erased the other
//   • oversize failures — requests/responses are capped at ~6 MB, and a single photo
//                     pasted into a test could push every save over the limit
//   • slow saves    — each save read + rewrote megabytes of unrelated data
//
// Now every record is its own blob, so writes can't collide across records:
//   v2/test/<id>                 { rev, updatedAt, snapTs, data }   one per test
//   v2/asg/<id>                  assignment
//   v2/sub/<assignmentId>/<id>   student submission
//   v2/subidx/<id>               → assignmentId (lookup by submission id)
//   v2/peer/<id>                 peer-review session
//   v2/img/<sha1>                { t, b }  images, stored once, served by URL
//   v2/hist/<testId>/<rev>       automatic snapshots of every test
//   v2/trash/test|asg/<id>       deleted items, recoverable
//   v2/meta                      migration marker
// The legacy "state" blob is NEVER modified or deleted — it stays as a permanent backup.
//
// Test writes carry the revision the client last saw ("baseRev"). If someone else saved
// in between, the server answers 409 + their copy instead of silently overwriting.

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const LEGACY_KEY = 'state';
const P = {
  test: 'v2/test/', asg: 'v2/asg/', sub: 'v2/sub/', subidx: 'v2/subidx/', peer: 'v2/peer/',
  img: 'v2/img/', hist: 'v2/hist/', trash: 'v2/trash/', meta: 'v2/meta',
};
const MAX_BODY = 5.5 * 1024 * 1024;       // stay under the platform's ~6 MB request cap
const RESP_BUDGET = 4.5 * 1024 * 1024;    // stay under the ~6 MB response cap (headroom for headers)
const SNAP_EVERY_MS = 3 * 60 * 1000;      // at most one automatic snapshot per test per 3 minutes…
const SNAP_KEEP = 60;                     // …keeping the most recent 60
const INLINE_IMG_MIN = 4000;              // data-URIs smaller than this stay inline
const MIGRATE_BUDGET_MS = +process.env.EA_MIGRATE_BUDGET_MS || 7000;   // one invocation migrates for at most this long, then resumes next call
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS };

function store() {
  return getStore({
    name: 'edassess-data',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
    consistency: 'strong',
  });
}
const getJ = (key) => store().get(key, { type: 'json' });
const putJ = (key, val) => store().setJSON(key, val);
const delK = (key) => store().delete(key);
async function listKeys(prefix) {
  const out = await store().list({ prefix });
  return (out.blobs || []).map((b) => b.key);
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
function reply(statusCode, obj, extra) {
  return { statusCode, headers: { ...JSON_HEADERS, ...(extra || {}) }, body: JSON.stringify(obj) };
}
const bad = (msg, code = 400, more) => reply(code, { error: msg, ...(more || {}) });
const okId = (id) => typeof id === 'string' && ID_RE.test(id);
const okRev = (r) => /^\d{1,9}$/.test(String(r));
class MigrationPending extends Error {}

/* ── images: data-URIs are pulled out of records and stored once, by content hash ── */
const DATA_URI = /data:(image\/(?:png|jpe?g|gif|webp|svg\+xml)|application\/pdf);base64,([A-Za-z0-9+/=]+)/g;
async function externalizeImages(root) {
  const holders = [];
  (function walk(node) {
    if (Array.isArray(node)) {
      node.forEach((v, i) => { if (typeof v === 'string') { if (v.includes('data:image/') || v.includes('data:application/pdf')) holders.push([node, i]); } else if (v && typeof v === 'object') walk(v); });
    } else if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === 'string') { if (v.includes('data:image/') || v.includes('data:application/pdf')) holders.push([node, k]); }
        else if (v && typeof v === 'object') walk(v);
      }
    }
  })(root);
  let count = 0;
  const jobs = new Map();
  for (const [parent, key] of holders) {
    const str = parent[key];
    const next = str.replace(DATA_URI, (m, mime, b64) => {
      if (b64.length < INLINE_IMG_MIN) return m;
      const hash = crypto.createHash('sha1').update(b64).digest('hex');
      jobs.set(hash, { mime, b64 });
      count++;
      return '/.netlify/functions/data?img=' + hash;
    });
    if (next !== str) parent[key] = next;
  }
  await mapLimit([...jobs.entries()], 6, async ([hash, v]) => {
    const key = P.img + hash;
    if (!(await getJ(key))) await putJ(key, { t: v.mime, b: v.b64 });
  });
  return count;
}

/* ── migration: legacy single blob → per-record blobs (idempotent, resumable, non-destructive) ──
   Each invocation migrates for at most MIGRATE_BUDGET_MS, saves a progress cursor, and answers
   503 "retry" until done, so a function timeout can never corrupt or restart the work. */
let _migrated = false;
async function ensureMigrated() {
  if (_migrated) return;
  if (await getJ(P.meta)) { _migrated = true; return; }
  const legacy = await getJ(LEGACY_KEY);
  const deadline = Date.now() + MIGRATE_BUDGET_MS;
  const prog = (await getJ('v2/migrating')) || { tests: 0, assignments: 0, submissions: 0, peerSessions: 0 };
  const steps = [
    ['tests', async (t) => {
      if (!(await getJ(P.test + t.id))) {
        const data = JSON.parse(JSON.stringify(t));
        await externalizeImages(data);
        await putJ(P.test + t.id, { rev: 1, updatedAt: t.updatedAt || new Date().toISOString(), snapTs: 0, data });
      }
    }],
    ['assignments', async (a) => { if (!(await getJ(P.asg + a.id))) await putJ(P.asg + a.id, a); }],
    ['submissions', async (s) => {
      const aid = okId(s.assignmentId) ? s.assignmentId : '_';
      if (!(await getJ(P.sub + aid + '/' + s.id))) {
        const clean = JSON.parse(JSON.stringify(s));
        delete clean._orderedQuestions;          // old shuffle bookkeeping: a full copy of the test (with images) per student
        await externalizeImages(clean);
        await putJ(P.sub + aid + '/' + s.id, clean);
      }
      await putJ(P.subidx + s.id, aid);
    }],
    ['peerSessions', async (p) => { if (!(await getJ(P.peer + p.id))) await putJ(P.peer + p.id, p); }],
  ];
  if (legacy) {
    for (const [name, fn] of steps) {
      const list = Array.isArray(legacy[name]) ? legacy[name] : [];
      while (prog[name] < list.length) {
        const rec = list[prog[name]];
        if (rec && okId(rec.id)) await fn(rec);
        prog[name]++;
        if (Date.now() > deadline && prog[name] < list.length || (Date.now() > deadline && name !== 'peerSessions')) {
          await putJ('v2/migrating', prog);            // always made progress ≥ 1 item before yielding
          throw new MigrationPending('migrating');
        }
      }
    }
  }
  const counts = legacy ? { tests: (legacy.tests || []).length, assignments: (legacy.assignments || []).length, submissions: (legacy.submissions || []).length, peerSessions: (legacy.peerSessions || []).length } : { tests: 0, assignments: 0, submissions: 0, peerSessions: 0 };
  await putJ(P.meta, { migratedAt: new Date().toISOString(), from: legacy ? LEGACY_KEY : null, counts });
  await delK('v2/migrating');
  _migrated = true;
}

/* ── tests ── */
const unwrapTest = (rec) => (rec ? { ...rec.data, rev: rec.rev } : null);
async function snapshot(id, rec) {
  await putJ(`${P.hist}${id}/${String(rec.rev).padStart(8, '0')}`, {
    rev: rec.rev, ts: rec.updatedAt, title: rec.data.title || '', count: (rec.data.questions || []).length, data: rec.data,
  });
  const keys = (await listKeys(`${P.hist}${id}/`)).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - SNAP_KEEP))) await delK(k);
}
async function putTest(test, baseRev, force) {
  if (!test || !okId(test.id)) return bad('Test needs a valid id.');
  const cleaned = JSON.parse(JSON.stringify(test)); delete cleaned.rev;
  const externalized = await externalizeImages(cleaned);
  const key = P.test + test.id;
  const cur = await getJ(key);
  if (!force) {
    if (cur && (baseRev === null || baseRev === undefined || cur.rev !== baseRev)) {
      return bad('This test was changed somewhere else since you opened it.', 409, { conflict: true, serverRev: cur.rev, server: unwrapTest(cur) });
    }
    if (!cur && baseRev !== null && baseRev !== undefined) {
      const trashed = await getJ(P.trash + 'test/' + test.id);
      return bad(trashed ? 'This test was deleted somewhere else.' : 'This test no longer exists on the server.', 409, { conflict: true, deleted: true, serverRev: null });
    }
  }
  const now = new Date().toISOString();
  const rev = (cur ? cur.rev : 0) + 1;
  let snapTs = cur ? cur.snapTs || 0 : 0;
  if (cur) {
    const shrank = (cleaned.questions || []).length < (cur.data.questions || []).length;
    if (shrank || Date.now() - snapTs > SNAP_EVERY_MS) { await snapshot(test.id, cur); snapTs = Date.now(); }
  }
  await putJ(key, { rev, updatedAt: now, snapTs, data: cleaned });
  return reply(200, { ok: true, rev, externalized, test: externalized ? { ...cleaned, rev } : undefined, serverTime: now });
}
async function deleteEntity(kind, id) {
  if (!okId(id)) return;
  const key = (kind === 'test' ? P.test : P.asg) + id;
  const cur = await getJ(key);
  if (!cur) return;
  await putJ(`${P.trash}${kind}/${id}`, { deletedAt: new Date().toISOString(), rec: cur });
  if (kind === 'test') await snapshot(id, cur);
  await delK(key);
}

/* ── reads ── */
async function readAll(prefix) {
  const keys = (await listKeys(prefix)).sort();
  return { keys, vals: await mapLimit(keys, 24, getJ) };
}
async function readCore() {
  const [t, a, p] = await Promise.all([readAll(P.test), readAll(P.asg), readAll(P.peer)]);
  return { tests: t.vals.filter(Boolean).map(unwrapTest), assignments: a.vals.filter(Boolean), peerSessions: p.vals.filter(Boolean) };
}
// Submissions come in pages that respect the response-size cap.
async function readSubsPage(prefix, after) {
  const keys = (await listKeys(prefix)).sort().filter((k) => !after || k > after);
  const out = [];
  let bytes = 0, last = null;
  for (let i = 0; i < keys.length; i += 12) {
    const chunk = keys.slice(i, i + 12);
    const vals = await Promise.all(chunk.map(getJ));
    for (let j = 0; j < chunk.length; j++) {
      const v = vals[j]; if (!v) continue;
      const sz = JSON.stringify(v).length;
      if (out.length && bytes + sz > RESP_BUDGET) return { submissions: out, next: last };
      out.push(v); bytes += sz; last = chunk[j];
    }
  }
  return { submissions: out, next: null };
}
async function readFull() {
  const core = await readCore();
  const page = await readSubsPage(P.sub, null);
  return { ...core, submissions: page.submissions, truncated: !!page.next };
}
async function findSub(id) {
  if (!okId(id)) return null;
  const aid = await getJ(P.subidx + id);
  if (aid) { const s = await getJ(P.sub + aid + '/' + id); if (s) return s; }
  for (const k of await listKeys(P.sub)) if (k.endsWith('/' + id)) return getJ(k);
  return null;
}

/* ── submissions / peer / assignments ── */
async function upsertSubmission(sub) {
  if (!sub || !okId(sub.id)) return bad('Submission needs a valid id.');
  const aid = okId(sub.assignmentId) ? sub.assignmentId : '_';
  const clean = JSON.parse(JSON.stringify(sub));
  await externalizeImages(clean);
  const key = P.sub + aid + '/' + sub.id;
  const prev = await getJ(key);
  // a request that was delayed in transit must not overwrite a newer one (two devices, retries…)
  if (prev && Number.isFinite(prev._v) && Number.isFinite(clean._v) && clean._v < prev._v) {
    return reply(200, { ok: true, stale: true, serverTime: new Date().toISOString() });
  }
  if (prev && Array.isArray(prev.instructorOps) && prev.instructorOps.length) {
    // `instructorOps` is owned by the server so a student's routine autosave can never erase
    // an instructor's pending "+5 minutes" / "end section".
    const have = new Set((clean.instructorOps || []).map((o) => o.id));
    clean.instructorOps = (clean.instructorOps || []).concat(prev.instructorOps.filter((o) => !have.has(o.id)));
  }
  await putJ(key, clean);
  if (!prev) await putJ(P.subidx + sub.id, aid);
  return reply(200, { ok: true, serverTime: new Date().toISOString() });
}
async function deleteSubs(ids) {
  for (const id of ids) {
    if (!okId(id)) continue;
    const aid = await getJ(P.subidx + id);
    if (aid) await delK(P.sub + aid + '/' + id);
    else for (const k of await listKeys(P.sub)) if (k.endsWith('/' + id)) await delK(k);
    await delK(P.subidx + id);
  }
}
async function putSimple(prefix, obj) {
  if (!obj || !okId(obj.id)) return bad('Record needs a valid id.');
  const clean = JSON.parse(JSON.stringify(obj));
  await externalizeImages(clean);
  await putJ(prefix + obj.id, clean);
  return reply(200, { ok: true });
}

/* ── GET ── */
async function handleGet(q) {
  await ensureMigrated();
  if (q.img) {
    if (!/^[a-f0-9]{40}$/.test(q.img)) return bad('Bad image id.', 400);
    const rec = await getJ(P.img + q.img);
    if (!rec) return { statusCode: 404, headers: CORS_HEADERS, body: 'Not found' };
    const isPdf = rec.t === 'application/pdf';
    return {
      statusCode: 200, isBase64Encoded: true, body: rec.b,
      headers: { 'Content-Type': rec.t, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
        // images/SVG are locked down so a hostile file can't run script if opened directly; PDFs need their viewer
        ...(isPdf ? { 'Content-Disposition': 'inline' } : { 'Content-Security-Policy': "default-src 'none'; sandbox" }), ...CORS_HEADERS },
    };
  }
  if (q.test) {
    if (!okId(q.test)) return bad('Bad id.');
    const rec = await getJ(P.test + q.test);
    return rec ? reply(200, { test: unwrapTest(rec) }) : bad('Not found', 404);
  }
  if (q.sub) {
    const sub = await findSub(q.sub);
    if (!sub) return bad('Not found', 404);
    const out = { submission: sub, serverTime: new Date().toISOString() };
    if (q.testId && okId(q.testId)) {
      const rec = await getJ(P.test + q.testId);
      if (rec && String(rec.rev) !== String(q.testRev)) out.test = unwrapTest(rec);
      if (rec) out.testRev = rec.rev;
    }
    return reply(200, out);
  }
  if (q.exam) {
    if (!okId(q.exam)) return bad('Bad id.');
    const asg = await getJ(P.asg + q.exam);
    const test = asg && okId(asg.testId) ? await getJ(P.test + asg.testId) : null;
    const page = asg ? await readSubsPage(P.sub + q.exam + '/', null) : { submissions: [], next: null };
    return reply(200, { tests: test ? [unwrapTest(test)] : [], assignments: asg ? [asg] : [], submissions: page.submissions, peerSessions: [], scoped: 'exam', truncated: !!page.next });
  }
  if (q.results) {
    const sub = await findSub(q.results);
    if (!sub) return reply(200, { tests: [], assignments: [], submissions: [], peerSessions: [], scoped: 'results' });
    const asg = okId(sub.assignmentId) ? await getJ(P.asg + sub.assignmentId) : null;
    const tid = asg ? asg.testId : sub.testId;
    const test = okId(tid) ? await getJ(P.test + tid) : null;
    return reply(200, { tests: test ? [unwrapTest(test)] : [], assignments: asg ? [asg] : [], submissions: [sub], peerSessions: [], scoped: 'results' });
  }
  if (q.part === 'core') return reply(200, { ...(await readCore()), serverTime: new Date().toISOString() });
  if (q.part === 'subs') {
    const page = await readSubsPage(q.assignment && okId(q.assignment) ? P.sub + q.assignment + '/' : P.sub, q.after || null);
    return reply(200, page);
  }
  if (q.history) {
    if (!okId(q.id)) return bad('Pass ?id=<testId>.');
    const keys = (await listKeys(`${P.hist}${q.id}/`)).sort().reverse();
    const recs = await mapLimit(keys, 12, getJ);
    return reply(200, { versions: recs.filter(Boolean).map((r) => ({ index: r.rev, rev: r.rev, ts: r.ts, count: r.count, title: r.title })) });
  }
  if (q.historyItem) {
    if (!okId(q.id) || !okRev(q.rev)) return bad('Bad request.');
    const rec = await getJ(`${P.hist}${q.id}/${String(q.rev).padStart(8, '0')}`);
    return rec ? reply(200, { test: rec.data, rev: rec.rev, ts: rec.ts }) : bad('Version has aged out.', 404);
  }
  if (q.trash) {
    const kind = q.trash === 'assignments' ? 'asg' : 'test';
    const keys = await listKeys(`${P.trash}${kind}/`);
    const recs = await mapLimit(keys, 12, getJ);
    return reply(200, { items: recs.filter(Boolean).map((r) => {
      const d = r.rec.data || r.rec;
      return { id: d.id, title: d.title || '', count: (d.questions || []).length, deletedAt: r.deletedAt };
    }).sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1)) });
  }
  return reply(200, { ...(await readFull()), serverTime: new Date().toISOString() });
}

/* ── POST ── */
// Old cached pages verify a save by comparing the `state` echoed in the reply with what they sent.
// Echo exactly the records we just wrote (small), never the whole database.
function legacyReply(echo) { return reply(200, { ok: true, state: echo || {} }); }
async function handlePost(body) {
  await ensureMigrated();
  switch (body.action) {
    case 'putTest': return putTest(body.test, body.baseRev, !!body.force);
    case 'putAssignment': return putSimple(P.asg, body.assignment);
    case 'putPeerSession':
    case 'upsertPeerSession': return putSimple(P.peer, body.peerSession);
    case 'upsertSubmission': return upsertSubmission(body.submission);
    case 'putImage': {
      const m = /^data:(image\/(?:png|jpe?g|gif|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl || '');
      if (!m) return bad('Not a supported image or PDF.');
      const hash = crypto.createHash('sha1').update(m[2]).digest('hex');
      if (!(await getJ(P.img + hash))) await putJ(P.img + hash, { t: m[1], b: m[2] });
      return reply(200, { ok: true, url: '/.netlify/functions/data?img=' + hash });
    }
    case 'deleteTest': await deleteEntity('test', body.id); return reply(200, { ok: true });
    case 'deleteAssignment': await deleteEntity('asg', body.id); return reply(200, { ok: true });
    case 'deleteSubmission': await deleteSubs([body.id]); return reply(200, { ok: true });
    case 'deleteSubmissions': await deleteSubs(Array.isArray(body.ids) ? body.ids : []); return reply(200, { ok: true });
    case 'deletePeerSession': if (okId(body.id)) await delK(P.peer + body.id); return reply(200, { ok: true });
    case 'restoreTestVersion': {
      if (!okId(body.id) || !okRev(body.rev)) return bad('Bad request.');
      const hist = await getJ(`${P.hist}${body.id}/${String(body.rev).padStart(8, '0')}`);
      if (!hist) return bad('That version has aged out.', 404);
      const cur = await getJ(P.test + body.id);
      if (cur) await snapshot(body.id, cur);               // today's version goes to history first → restoring is always undoable
      const rev = (cur ? cur.rev : 0) + 1;
      await putJ(P.test + body.id, { rev, updatedAt: new Date().toISOString(), snapTs: Date.now(), data: hist.data });
      return reply(200, { ok: true, rev, test: { ...hist.data, rev } });
    }
    case 'restoreTrash': {
      if (!okId(body.id)) return bad('Bad request.');
      const kind = body.kind === 'assignments' ? 'asg' : 'test';
      const tr = await getJ(`${P.trash}${kind}/${body.id}`);
      if (!tr) return bad('Not found in trash.', 404);
      if (kind === 'test') {
        const cur = await getJ(P.test + body.id);
        const rev = (cur ? cur.rev : tr.rec.rev || 0) + 1;
        await putJ(P.test + body.id, { rev, updatedAt: new Date().toISOString(), snapTs: 0, data: tr.rec.data });
        await delK(`${P.trash}test/${body.id}`);
        return reply(200, { ok: true, test: { ...tr.rec.data, rev } });
      }
      await putJ(P.asg + body.id, tr.rec); await delK(`${P.trash}asg/${body.id}`);
      return reply(200, { ok: true, assignment: tr.rec });
    }
    // ── legacy bulk actions, kept so older cached pages keep working — but now NON-destructive ──
    case 'saveTests': {
      const list = Array.isArray(body.tests) ? body.tests : [];
      if (!list.length) {
        const have = (await listKeys(P.test)).length;
        if (have) return bad('Refusing to overwrite existing tests with an empty list.', 409, { currentCount: have });
      }
      for (const t of list) {
        if (!t || !okId(t.id)) continue;
        const cur = await getJ(P.test + t.id);
        await putTest(t, cur ? cur.rev : null, true);       // upsert only — never deletes tests that aren't in the list
      }
      return legacyReply({ tests: list });
    }
    case 'saveAssignments': {
      const list = Array.isArray(body.assignments) ? body.assignments : [];
      for (const a of list) if (a && okId(a.id)) await putJ(P.asg + a.id, a);
      return legacyReply({ assignments: list });
    }
    case 'fullSave': {
      if (Array.isArray(body.tests)) for (const t of body.tests) { if (t && okId(t.id)) { const cur = await getJ(P.test + t.id); await putTest(t, cur ? cur.rev : null, true); } }
      if (Array.isArray(body.assignments)) for (const a of body.assignments) if (a && okId(a.id)) await putJ(P.asg + a.id, a);
      if (Array.isArray(body.submissions)) for (const s of body.submissions) if (s && okId(s.id)) await upsertSubmission(s);
      if (Array.isArray(body.peerSessions)) for (const p of body.peerSessions) if (p && okId(p.id)) await putJ(P.peer + p.id, p);
      return legacyReply({ tests: body.tests, assignments: body.assignments, submissions: body.submissions, peerSessions: body.peerSessions });
    }
    case 'syncSubs': {
      // Incremental refresh for the live monitor: one list call (record fingerprints), then only the
      // records whose fingerprint differs from what the client already has.
      const prefix = body.assignment && okId(body.assignment) ? P.sub + body.assignment + '/' : P.sub;
      const known = body.known && typeof body.known === 'object' ? body.known : {};
      const listing = (await store().list({ prefix })).blobs || [];
      const changed = listing.filter((b) => known[b.key] !== b.etag).sort((a, b) => (a.key < b.key ? -1 : 1));
      const subs = [], etags = {};
      let bytes = 0, more = false;
      for (let i = 0; i < changed.length; i += 12) {
        const chunk = changed.slice(i, i + 12);
        const vals = await Promise.all(chunk.map((b) => getJ(b.key)));
        for (let j = 0; j < chunk.length; j++) {
          if (!vals[j]) continue;
          const sz = JSON.stringify(vals[j]).length;
          if (subs.length && bytes + sz > RESP_BUDGET) { more = true; break; }
          subs.push(vals[j]); etags[chunk[j].key] = chunk[j].etag; bytes += sz;
        }
        if (more) break;
      }
      return reply(200, { ok: true, submissions: subs, etags, keys: listing.map((b) => b.key), more });
    }
    case 'instructorOp': {
      // Instructor → live student channel (sectioned tests): add time to a section, or end it.
      const op = body.op || {};
      const sub = await findSub(body.submissionId);
      if (!sub) return bad('Submission not found', 404);
      if (op.type !== 'addTime' && op.type !== 'endSection') return bad('Unknown op type');
      const clean = {
        id: 'op_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        type: op.type, sectionId: typeof op.sectionId === 'string' ? op.sectionId : null, at: new Date().toISOString(),
      };
      if (op.type === 'addTime') {
        const secs = Number(op.secs);
        if (!(secs > 0 && secs <= 7200)) return bad('secs must be between 1 and 7200');
        clean.secs = Math.round(secs);
      }
      const aid = okId(sub.assignmentId) ? sub.assignmentId : '_';
      const fresh = (await getJ(P.sub + aid + '/' + sub.id)) || sub;
      fresh.instructorOps = (fresh.instructorOps || []).concat(clean);
      await putJ(P.sub + aid + '/' + sub.id, fresh);
      return reply(200, { ok: true });
    }
    default:
      return bad('Unknown action: ' + body.action);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  try {
    if (event.httpMethod === 'GET') return await handleGet(event.queryStringParameters || {});
    if (event.httpMethod === 'POST') {
      if ((event.body || '').length > MAX_BODY) return bad('That save is too large (over 5.5 MB). Remove or shrink large images and try again.', 413);
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return bad('Invalid JSON body'); }
      return await handlePost(body);
    }
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    if (err instanceof MigrationPending) {
      return reply(503, { error: 'Upgrading your data store — this takes a moment. Retrying automatically…', migrating: true }, { 'Retry-After': '3' });
    }
    return reply(500, { error: err.message || 'Server error' });
  }
};
