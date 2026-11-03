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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
async function putTest(test, baseRev, force, user) {
  if (!test || !okId(test.id)) return bad('Test needs a valid id.');
  const cleaned = JSON.parse(JSON.stringify(test)); delete cleaned.rev;
  const externalized = await externalizeImages(cleaned);
  const key = P.test + test.id;
  const cur = await getJ(key);
  let role = 'owner';
  if (cur) {
    role = testRole(cur.data, user);
    if (!role) return bad('You do not have access to this test.', 403);
    if (role === 'view') return bad('This test is shared with you as view-only.', 403);
    cleaned.ownerId = ownerOf(cur.data);
    cleaned.sharedWith = cur.data.sharedWith || [];       // sharing only changes through the shareTest action
  } else {
    cleaned.ownerId = lc(user.username);
    cleaned.sharedWith = [];
  }
  cleaned.ownerName = undefined; delete cleaned.ownerName;
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
async function deleteEntity(kind, id, user) {
  if (!okId(id)) return null;
  const key = (kind === 'test' ? P.test : P.asg) + id;
  const cur = await getJ(key);
  if (!cur) return null;
  if (ownerOf(kind === 'test' ? cur.data : cur) !== lc(user.username)) return bad('Only the owner can delete this.', 403);
  dropAsgCache();
  await putJ(`${P.trash}${kind}/${id}`, { deletedAt: new Date().toISOString(), rec: cur });
  if (kind === 'test') await snapshot(id, cur);
  await delK(key);
  return null;
}

/* ── reads ── */
async function readAll(prefix) {
  const keys = (await listKeys(prefix)).sort();
  return { keys, vals: await mapLimit(keys, 24, getJ) };
}
async function readCore(user) {
  const [t, a, p] = await Promise.all([readAll(P.test), readAll(P.asg), readAll(P.peer)]);
  const asgs = a.vals.filter(Boolean).filter((x) => asgRole(x, user));
  const viaAsg = new Set(asgs.map((x) => x.testId));
  const tests = t.vals.filter(Boolean).filter((r) => testRole(r.data, user) || viaAsg.has(r.data.id)).map(unwrapTest);
  const ids = new Set(tests.map((x) => x.id));
  const peers = p.vals.filter(Boolean).filter((x) => ownerOf(x) === lc(user.username) || (ids.has(x.testId) && asgs.some((g) => g.testId === x.testId)));
  const names = await namesFor(new Set([...tests.map((x) => ownerOf(x)), ...tests.flatMap((x) => (x.sharedWith || []).map((s) => s.u)), ...asgs.map(ownerOf), ...asgs.flatMap((x) => x.coTeachers || [])]));
  return { tests, assignments: asgs, peerSessions: peers, teachers: names };
}
// Submissions come in pages that respect the response-size cap.
async function readSubsPage(prefix, after, keyOk) {
  const keys = (await listKeys(prefix)).sort().filter((k) => (!after || k > after) && (!keyOk || keyOk(k)));
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
async function readFull(user) {
  const core = await readCore(user);
  const ok = await subKeyFilter(user);
  const page = await readSubsPage(P.sub, null, ok);
  return { ...core, submissions: page.submissions, truncated: !!page.next };
}
async function subKeyFilter(user) {
  const ids = await myAsgIds(user);
  const me = lc(user.username);
  return (k) => { const aid = subAid(k); return ids.has(aid) || (aid === '_' && me === ADMIN_USER); };
}
async function canTouchSub(sub, user) {
  if (!sub) return false;
  if (okId(sub.assignmentId)) { const a = await getJ(P.asg + sub.assignmentId); return !!asgRole(a, user); }
  return lc(user.username) === ADMIN_USER;
}
// names the students may see: assignment/test owners, co-teachers, graders, commenters, op senders
async function teachersForStudent(asg, test, subs) {
  const set = new Set();
  if (asg) { set.add(ownerOf(asg)); (asg.coTeachers || []).forEach((x) => set.add(lc(x))); }
  if (test) set.add(ownerOf(test.data || test));
  for (const s of subs || []) {
    if (s.gradedBy) set.add(lc(s.gradedBy));
    Object.values(s.commentBy || {}).forEach((x) => set.add(lc(x)));
    (s.instructorOps || []).forEach((o) => { if (o.by) set.add(lc(o.by)); });
  }
  return namesFor(set);
}
async function findSub(id) {
  if (!okId(id)) return null;
  const aid = await getJ(P.subidx + id);
  if (aid) { const s = await getJ(P.sub + aid + '/' + id); if (s) return s; }
  for (const k of await listKeys(P.sub)) if (k.endsWith('/' + id)) return getJ(k);
  return null;
}

/* ── submissions / peer / assignments ── */
async function upsertSubmission(sub, user) {
  if (!sub || !okId(sub.id)) return bad('Submission needs a valid id.');
  const aid = okId(sub.assignmentId) ? sub.assignmentId : '_';
  const clean = JSON.parse(JSON.stringify(sub));
  await externalizeImages(clean);
  const key = P.sub + aid + '/' + sub.id;
  const prev = await getJ(key);
  delete clean.gradedBy; delete clean.commentBy;
  if (user) {
    if (!(await canTouchSub(clean, user)) && !(prev && (await canTouchSub(prev, user)))) return bad('You do not have access to this assignment.', 403);
    const me = lc(user.username);
    clean.gradedBy = me; clean.commentBy = { ...((prev && prev.commentBy) || {}) };
    const before = (prev && prev.comments) || {};
    for (const k of Object.keys(clean.comments || {})) if (clean.comments[k] !== before[k]) clean.commentBy[k] = me;
  } else if (prev) {
    if (prev.gradedBy) clean.gradedBy = prev.gradedBy;
    if (prev.commentBy) clean.commentBy = prev.commentBy;
  }
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
async function deleteSubs(ids, user) {
  for (const id of ids) {
    if (!okId(id)) continue;
    if (!(await canTouchSub(await findSub(id), user))) return bad('You do not have access to delete that.', 403);
    const aid = await getJ(P.subidx + id);
    if (aid) await delK(P.sub + aid + '/' + id);
    else for (const k of await listKeys(P.sub)) if (k.endsWith('/' + id)) await delK(k);
    await delK(P.subidx + id);
  }
  return null;
}
async function putSimple(prefix, obj, user) {
  if (!obj || !okId(obj.id)) return bad('Record needs a valid id.');
  const clean = JSON.parse(JSON.stringify(obj));
  await externalizeImages(clean);
  const cur = await getJ(prefix + obj.id);
  if (prefix === P.asg) {
    if (!user) return AUTH_ERR();
    if (cur) {
      const r = asgRole(cur, user);
      if (!r) return bad('You do not have access to this assignment.', 403);
      clean.ownerId = ownerOf(cur);
      clean.coTeachers = cur.coTeachers || [];            // changes only through the setCoTeachers action
    } else {
      clean.ownerId = lc(user.username);
      clean.coTeachers = await cleanCoTeachers(clean.coTeachers, clean.ownerId);
      if (okId(clean.testId)) {
        const t = await getJ(P.test + clean.testId);
        if (!t || !testRole(t.data, user)) return bad('You do not have access to that test.', 403);
      }
    }
    dropAsgCache();
  } else if (prefix === P.peer) {
    // students submit peer reviews through this too, so it is open — but ownership can never be changed
    if (cur) { if (cur.ownerId) clean.ownerId = cur.ownerId; else delete clean.ownerId; }
    else if (user) clean.ownerId = lc(user.username);
    else return AUTH_ERR();
  }
  await putJ(prefix + obj.id, clean);
  return reply(200, { ok: true, ...(prefix === P.asg ? { assignment: clean } : {}) });
}

/* ═══════════════ ACCOUNTS & ACCESS ═══════════════
   Secrets live ONLY in Netlify environment variables (never in the page or the repo):
     EA_AUTH_SECRET       long random string used to sign login tokens
     EA_ADMIN_PASSWORD    first password for the DeanH admin account (changed at first sign-in)
     EA_TEACHER_KEYWORD   keyword required to create a teacher account
     EA_ADMIN_RESET       optional; set/change this value to reset DeanH back to EA_ADMIN_PASSWORD
   Passwords are stored only as scrypt hashes.                                                     */
const U_PREFIX = 'v2/user/';
const ADMIN_USER = 'deanh';
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const USER_RE = /^[A-Za-z0-9_.-]{3,30}$/;
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const lc = (s) => String(s || '').trim().toLowerCase();
function secret() { return process.env.EA_AUTH_SECRET || ''; }
function signToken(u) {
  const p = b64u(JSON.stringify({ u, exp: Date.now() + TOKEN_TTL_MS }));
  return p + '.' + b64u(crypto.createHmac('sha256', secret()).update(p).digest());
}
function readToken(tok) {
  if (!secret() || typeof tok !== 'string') return null;
  const [p, sig] = tok.split('.');
  if (!p || !sig) return null;
  const good = b64u(crypto.createHmac('sha256', secret()).update(p).digest());
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); return d.exp > Date.now() ? d.u : null; } catch (e) { return null; }
}
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function sameStr(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const pubUser = (u) => ({ username: u.username, name: u.name, role: u.role, mustChange: !!u.mustChange });
async function setPassword(u, pw, mustChange) {
  u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(pw, u.salt); u.mustChange = !!mustChange;
  u.fails = 0; u.lockUntil = 0; u.pwAt = new Date().toISOString();
  await putJ(U_PREFIX + lc(u.username), u);
}
async function ensureAdmin() {
  const pw = process.env.EA_ADMIN_PASSWORD;
  let u = await getJ(U_PREFIX + ADMIN_USER);
  if (!pw) return u;
  const mark = process.env.EA_ADMIN_RESET || '';
  if (!u) { u = { username: 'DeanH', name: 'Dean H', role: 'admin', createdAt: new Date().toISOString(), resetMark: mark }; await setPassword(u, pw, true); }
  else if (mark && u.resetMark !== mark) { u.resetMark = mark; await setPassword(u, pw, true); }
  return u;
}
async function userFromEvent(event) {
  const h = event.headers || {};
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || h.Authorization || '');
  const name = m && readToken(m[1]);
  if (!name) return null;
  const u = await getJ(U_PREFIX + name);
  return u && !u.disabled ? u : null;
}
const AUTH_ERR = () => reply(401, { error: 'Please sign in.', auth: true });
async function namesFor(set) {
  const out = {};
  await mapLimit([...set].filter(Boolean), 8, async (k) => {
    const u = await getJ(U_PREFIX + lc(k));
    out[lc(k)] = u ? u.name : k;
  });
  return out;
}
async function authAction(body, user) {
  const a = body.action;
  if (a === 'login') {
    if (!secret()) return bad('Sign-in is not configured yet: the site owner must set EA_AUTH_SECRET.', 500);
    await ensureAdmin();
    const key = U_PREFIX + lc(body.username);
    const u = USER_RE.test(String(body.username || '')) ? await getJ(key) : null;
    if (!u) { hashPw(body.password || '', 'x'.repeat(16)); return bad('Wrong username or password.', 401); }
    if (u.lockUntil && u.lockUntil > Date.now()) return bad('Too many attempts. Wait a minute and try again.', 429);
    if (u.disabled || !sameStr(hashPw(body.password || '', u.salt), u.hash)) {
      u.fails = (u.fails || 0) + 1;
      if (u.fails >= 5) { u.fails = 0; u.lockUntil = Date.now() + 60000; }
      await putJ(key, u);
      return bad('Wrong username or password.', 401);
    }
    if (u.fails || u.lockUntil) { u.fails = 0; u.lockUntil = 0; await putJ(key, u); }
    return reply(200, { token: signToken(lc(u.username)), user: pubUser(u) });
  }
  if (a === 'signup') {
    if (!secret()) return bad('Sign-up is not configured yet: the site owner must set EA_AUTH_SECRET.', 500);
    const kw = process.env.EA_TEACHER_KEYWORD;
    if (!kw) return bad('Teacher sign-up is not configured yet.', 500);
    if (!sameStr(lc(body.keyword), lc(kw))) return bad('That keyword is not right.', 403);
    const username = String(body.username || '').trim(), name = String(body.name || '').trim().slice(0, 60);
    if (!USER_RE.test(username)) return bad('Username: 3–30 letters, numbers, . _ -');
    if (!name) return bad('Enter the name students should see.');
    if (String(body.password || '').length < 8) return bad('Password needs at least 8 characters.');
    await ensureAdmin();
    if (await getJ(U_PREFIX + lc(username))) return bad('That username is taken.', 409);
    const u = { username, name, role: 'teacher', createdAt: new Date().toISOString() };
    await setPassword(u, body.password, false);
    return reply(200, { token: signToken(lc(username)), user: pubUser(u) });
  }
  if (!['me', 'changePassword', 'updateProfile', 'listTeachers', 'adminListUsers', 'adminResetPassword', 'adminSetDisabled'].includes(a)) return null;
  if (!user) return AUTH_ERR();
  if (a === 'me') return reply(200, { user: pubUser(user) });
  if (a === 'changePassword') {
    if (String(body.newPassword || '').length < 8) return bad('New password needs at least 8 characters.');
    if (!sameStr(hashPw(body.oldPassword || '', user.salt), user.hash)) return bad('Current password is wrong.', 403);
    await setPassword(user, body.newPassword, false);
    return reply(200, { ok: true, user: pubUser(user) });
  }
  if (a === 'updateProfile') {
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return bad('Name is empty.');
    user.name = name; await putJ(U_PREFIX + lc(user.username), user);
    return reply(200, { ok: true, user: pubUser(user) });
  }
  if (a === 'listTeachers') {
    const keys = await listKeys(U_PREFIX);
    const us = (await mapLimit(keys, 12, getJ)).filter((u) => u && !u.disabled);
    return reply(200, { teachers: us.map((u) => ({ username: u.username, name: u.name })).sort((x, y) => x.name.localeCompare(y.name)) });
  }
  if (user.role === 'admin') {
    if (a === 'adminListUsers') {
      const us = (await mapLimit(await listKeys(U_PREFIX), 12, getJ)).filter(Boolean);
      return reply(200, { users: us.map((u) => ({ ...pubUser(u), disabled: !!u.disabled, createdAt: u.createdAt })) });
    }
    if (a === 'adminResetPassword' || a === 'adminSetDisabled') {
      const t = await getJ(U_PREFIX + lc(body.username));
      if (!t) return bad('No such user.', 404);
      if (a === 'adminSetDisabled') {
        if (lc(t.username) === ADMIN_USER) return bad('The admin account cannot be disabled.');
        t.disabled = !!body.disabled; await putJ(U_PREFIX + lc(t.username), t);
      } else {
        if (String(body.newPassword || '').length < 8) return bad('Password needs at least 8 characters.');
        await setPassword(t, body.newPassword, true);
      }
      return reply(200, { ok: true });
    }
  }
  return null;
}

/* ownership: records with no owner predate accounts and belong to the admin */
const ownerOf = (d) => lc((d && d.ownerId) || ADMIN_USER);
function testRole(data, user) {
  if (!user) return null;
  const me = lc(user.username);
  if (ownerOf(data) === me) return 'owner';
  const s = (data.sharedWith || []).find((x) => lc(x.u) === me);
  return s ? (s.role === 'edit' ? 'edit' : 'view') : null;
}
function asgRole(a, user) {
  if (!user || !a) return null;
  const me = lc(user.username);
  if (ownerOf(a) === me) return 'owner';
  return (a.coTeachers || []).map(lc).includes(me) ? 'edit' : null;
}
let _asgCache = { t: 0, vals: [] };
async function allAsgs() {
  if (Date.now() - _asgCache.t < 4000) return _asgCache.vals;
  const keys = await listKeys(P.asg);
  const vals = (await mapLimit(keys, 24, getJ)).filter(Boolean);
  _asgCache = { t: Date.now(), vals };
  return vals;
}
const dropAsgCache = () => { _asgCache = { t: 0, vals: [] }; };
async function myAsgIds(user) {
  return new Set((await allAsgs()).filter((a) => asgRole(a, user)).map((a) => a.id));
}
const subAid = (key) => key.slice(P.sub.length).split('/')[0];
async function cleanSharing(list, owner) {
  const seen = new Set(), out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const u = lc(s && s.u);
    if (!u || u === lc(owner) || seen.has(u) || !USER_RE.test(u)) continue;
    if (!(await getJ(U_PREFIX + u))) continue;
    seen.add(u); out.push({ u, role: s.role === 'edit' ? 'edit' : 'view' });
  }
  return out;
}
async function cleanCoTeachers(list, owner) {
  return (await cleanSharing((Array.isArray(list) ? list : []).map((u) => ({ u })), owner)).map((s) => s.u);
}

/* ── GET ── */
async function handleGet(q, user) {
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
  if (q.code) {
    // short join code -> assignment id (students type the code on the main page)
    const c = String(q.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 4 || c.length > 10) return bad('Bad code.');
    const keys = await listKeys(P.asg);
    const vals = await mapLimit(keys, 24, getJ);
    const a = vals.find((v) => v && String(v.code || '').toUpperCase() === c);
    return a ? reply(200, { id: a.id }) : bad('Not found', 404);
  }
  if (q.peer) {
    // student peer-review page: only the session, its test and the submissions it covers
    if (!okId(q.peer)) return bad('Bad id.');
    const ps = await getJ(P.peer + q.peer);
    if (!ps) return reply(200, { tests: [], assignments: [], submissions: [], peerSessions: [], scoped: 'peer' });
    const test = okId(ps.testId) ? await getJ(P.test + ps.testId) : null;
    const subs = (await mapLimit((ps.includedSubmissionIds || []).filter(okId), 12, findSub)).filter(Boolean);
    return reply(200, { tests: test ? [unwrapTest(test)] : [], assignments: [], submissions: subs, peerSessions: [ps], teachers: await teachersForStudent(null, test, subs), scoped: 'peer' });
  }
  if (!user && !q.sub && !q.exam && !q.results) return AUTH_ERR();
  if (q.test) {
    if (!okId(q.test)) return bad('Bad id.');
    const rec = await getJ(P.test + q.test);
    if (rec && !testRole(rec.data, user)) return bad('Not found', 404);
    return rec ? reply(200, { test: unwrapTest(rec) }) : bad('Not found', 404);
  }
  if (q.sub) {
    const sub = await findSub(q.sub);
    if (!sub) return bad('Not found', 404);
    const out = { submission: sub, serverTime: new Date().toISOString() };
    out.teachers = await teachersForStudent(okId(sub.assignmentId) ? await getJ(P.asg + sub.assignmentId) : null, null, [sub]);
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
    return reply(200, { tests: test ? [unwrapTest(test)] : [], assignments: asg ? [asg] : [], submissions: page.submissions, peerSessions: [], teachers: await teachersForStudent(asg, test, page.submissions), scoped: 'exam', truncated: !!page.next });
  }
  if (q.results) {
    const sub = await findSub(q.results);
    if (!sub) return reply(200, { tests: [], assignments: [], submissions: [], peerSessions: [], scoped: 'results' });
    const asg = okId(sub.assignmentId) ? await getJ(P.asg + sub.assignmentId) : null;
    const tid = asg ? asg.testId : sub.testId;
    const test = okId(tid) ? await getJ(P.test + tid) : null;
    return reply(200, { tests: test ? [unwrapTest(test)] : [], assignments: asg ? [asg] : [], submissions: [sub], peerSessions: [], teachers: await teachersForStudent(asg, test, [sub]), scoped: 'results' });
  }
  if (q.part === 'core') return reply(200, { ...(await readCore(user)), serverTime: new Date().toISOString() });
  if (q.part === 'subs') {
    if (q.assignment && okId(q.assignment)) {
      if (!asgRole(await getJ(P.asg + q.assignment), user)) return bad('No access.', 403);
      return reply(200, await readSubsPage(P.sub + q.assignment + '/', q.after || null));
    }
    return reply(200, await readSubsPage(P.sub, q.after || null, await subKeyFilter(user)));
  }
  if (q.history) {
    if (!okId(q.id)) return bad('Pass ?id=<testId>.');
    { const cur = await getJ(P.test + q.id); if (cur && !testRole(cur.data, user)) return bad('No access.', 403); }
    const keys = (await listKeys(`${P.hist}${q.id}/`)).sort().reverse();
    const recs = await mapLimit(keys, 12, getJ);
    return reply(200, { versions: recs.filter(Boolean).map((r) => ({ index: r.rev, rev: r.rev, ts: r.ts, count: r.count, title: r.title })) });
  }
  if (q.historyItem) {
    if (!okId(q.id) || !okRev(q.rev)) return bad('Bad request.');
    { const cur = await getJ(P.test + q.id); if (cur && !testRole(cur.data, user)) return bad('No access.', 403); }
    const rec = await getJ(`${P.hist}${q.id}/${String(q.rev).padStart(8, '0')}`);
    return rec ? reply(200, { test: rec.data, rev: rec.rev, ts: rec.ts }) : bad('Version has aged out.', 404);
  }
  if (q.trash) {
    const kind = q.trash === 'assignments' ? 'asg' : 'test';
    const keys = await listKeys(`${P.trash}${kind}/`);
    const recs = await mapLimit(keys, 12, getJ);
    return reply(200, { items: recs.filter(Boolean).filter((r) => ownerOf(r.rec.data || r.rec) === lc(user.username)).map((r) => {
      const d = r.rec.data || r.rec;
      return { id: d.id, title: d.title || '', count: (d.questions || []).length, deletedAt: r.deletedAt };
    }).sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1)) });
  }
  return reply(200, { ...(await readFull(user)), serverTime: new Date().toISOString() });
}

/* ── POST ── */
// Old cached pages verify a save by comparing the `state` echoed in the reply with what they sent.
// Echo exactly the records we just wrote (small), never the whole database.
function legacyReply(echo) { return reply(200, { ok: true, state: echo || {} }); }
async function handlePost(body, user) {
  await ensureMigrated();
  const au = await authAction(body, user);
  if (au) return au;
  const PUBLIC = ['upsertSubmission', 'putImage', 'upsertPeerSession', 'putPeerSession'];
  const publicOp = body.action === 'instructorOp' && body.op && body.op.type === 'upload';
  if (!user && !PUBLIC.includes(body.action) && !publicOp) return AUTH_ERR();
  switch (body.action) {
    case 'putTest': return putTest(body.test, body.baseRev, !!body.force, user);
    case 'putAssignment': return putSimple(P.asg, body.assignment, user);
    case 'putPeerSession':
    case 'upsertPeerSession': return putSimple(P.peer, body.peerSession, user);
    case 'upsertSubmission': return upsertSubmission(body.submission, user);
    case 'putImage': {
      const m = /^data:(image\/(?:png|jpe?g|gif|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl || '');
      if (!m) return bad('Not a supported image or PDF.');
      const hash = crypto.createHash('sha1').update(m[2]).digest('hex');
      if (!(await getJ(P.img + hash))) await putJ(P.img + hash, { t: m[1], b: m[2] });
      return reply(200, { ok: true, url: '/.netlify/functions/data?img=' + hash });
    }
    case 'shareTest': {
      const cur = okId(body.id) ? await getJ(P.test + body.id) : null;
      if (!cur || ownerOf(cur.data) !== lc(user.username)) return bad('Only the owner can share this test.', 403);
      cur.data.ownerId = ownerOf(cur.data);
      cur.data.sharedWith = await cleanSharing(body.sharedWith, cur.data.ownerId);
      await putJ(P.test + body.id, cur);
      return reply(200, { ok: true, rev: cur.rev, sharedWith: cur.data.sharedWith });
    }
    case 'setCoTeachers': {
      const cur = okId(body.id) ? await getJ(P.asg + body.id) : null;
      if (!cur || ownerOf(cur) !== lc(user.username)) return bad('Only the owner can change co-teachers.', 403);
      cur.ownerId = ownerOf(cur);
      cur.coTeachers = await cleanCoTeachers(body.coTeachers, cur.ownerId);
      await putJ(P.asg + body.id, cur); dropAsgCache();
      return reply(200, { ok: true, coTeachers: cur.coTeachers });
    }
    case 'deleteTest': return (await deleteEntity('test', body.id, user)) || reply(200, { ok: true });
    case 'deleteAssignment': return (await deleteEntity('asg', body.id, user)) || reply(200, { ok: true });
    case 'deleteSubmission': return (await deleteSubs([body.id], user)) || reply(200, { ok: true });
    case 'deleteSubmissions': return (await deleteSubs(Array.isArray(body.ids) ? body.ids : [], user)) || reply(200, { ok: true });
    case 'deletePeerSession': {
      const ps = okId(body.id) ? await getJ(P.peer + body.id) : null;
      if (ps && ownerOf(ps) !== lc(user.username)) return bad('Only the owner can delete this.', 403);
      if (ps) await delK(P.peer + body.id);
      return reply(200, { ok: true });
    }
    case 'restoreTestVersion': {
      if (!okId(body.id) || !okRev(body.rev)) return bad('Bad request.');
      const hist = await getJ(`${P.hist}${body.id}/${String(body.rev).padStart(8, '0')}`);
      if (!hist) return bad('That version has aged out.', 404);
      const cur = await getJ(P.test + body.id);
      if (cur) { const r = testRole(cur.data, user); if (r !== 'owner' && r !== 'edit') return bad('No edit access.', 403); }
      if (cur) await snapshot(body.id, cur);               // today's version goes to history first → restoring is always undoable
      const rev = (cur ? cur.rev : 0) + 1;
      await putJ(P.test + body.id, { rev, updatedAt: new Date().toISOString(), snapTs: Date.now(), data: { ...hist.data, ownerId: ownerOf(cur ? cur.data : hist.data), sharedWith: cur ? cur.data.sharedWith || [] : [] } });
      return reply(200, { ok: true, rev, test: { ...hist.data, rev } });
    }
    case 'restoreTrash': {
      if (!okId(body.id)) return bad('Bad request.');
      const kind = body.kind === 'assignments' ? 'asg' : 'test';
      const tr = await getJ(`${P.trash}${kind}/${body.id}`);
      if (!tr) return bad('Not found in trash.', 404);
      if (ownerOf(tr.rec.data || tr.rec) !== lc(user.username)) return bad('Not yours to restore.', 403);
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
        await putTest(t, cur ? cur.rev : null, true, user);       // upsert only — never deletes tests that aren't in the list
      }
      return legacyReply({ tests: list });
    }
    case 'saveAssignments': {
      const list = Array.isArray(body.assignments) ? body.assignments : [];
      for (const a of list) if (a && okId(a.id)) await putSimple(P.asg, a, user);
      return legacyReply({ assignments: list });
    }
    case 'syncSubs': {
      // Incremental refresh for the live monitor: one list call (record fingerprints), then only the
      // records whose fingerprint differs from what the client already has.
      const prefix = body.assignment && okId(body.assignment) ? P.sub + body.assignment + '/' : P.sub;
      let keyOk = null;
      if (body.assignment && okId(body.assignment)) { if (!asgRole(await getJ(P.asg + body.assignment), user)) return bad('No access.', 403); }
      else keyOk = await subKeyFilter(user);
      const known = body.known && typeof body.known === 'object' ? body.known : {};
      const listing = ((await store().list({ prefix })).blobs || []).filter((b) => !keyOk || keyOk(b.key));
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
      if (op.type !== 'upload' && !(await canTouchSub(sub, user))) return bad('You do not have access to this assignment.', 403);
      const OPS = ['addTime', 'endSection', 'pause', 'resume', 'announce', 'upload', 'sched', 'closeExam'];
      if (!OPS.includes(op.type)) return bad('Unknown op type');
      const clean = {
        id: 'op_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        type: op.type, sectionId: typeof op.sectionId === 'string' ? op.sectionId : null, at: new Date().toISOString(),
      };
      if (user && op.type !== 'upload') clean.by = lc(user.username);
      if (op.type === 'addTime') {
        const secs = Number(op.secs);
        if (!(secs > 0 && secs <= 7200)) return bad('secs must be between 1 and 7200');
        clean.secs = Math.round(secs);
      } else if (op.type === 'announce') {
        const text = String(op.text || '').trim().slice(0, 600);
        if (!text) return bad('Announcement is empty');
        clean.text = text; clean.reply = !!op.reply;
      } else if (op.type === 'sched') {
        if (op.closesAt === null || op.closesAt === undefined || op.closesAt === '') clean.closesAt = null;
        else if (Number.isFinite(Date.parse(op.closesAt))) clean.closesAt = new Date(op.closesAt).toISOString();
        else return bad('Bad closesAt');
      } else if (op.type === 'upload') {
        // sent from a student's phone: only accept a photo that was stored through putImage
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(op.key || ''))) return bad('Bad upload key');
        if (!/^\/\.netlify\/functions\/data\?img=[a-f0-9]{40}$/.test(String(op.url || ''))) return bad('Bad upload url');
        clean.key = String(op.key); clean.url = String(op.url);
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
    const user = await userFromEvent(event);
    if (event.httpMethod === 'GET') return await handleGet(event.queryStringParameters || {}, user);
    if (event.httpMethod === 'POST') {
      if ((event.body || '').length > MAX_BODY) return bad('That save is too large (over 5.5 MB). Remove or shrink large images and try again.', 413);
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return bad('Invalid JSON body'); }
      return await handlePost(body, user);
    }
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    if (err instanceof MigrationPending) {
      return reply(503, { error: 'Upgrading your data store — this takes a moment. Retrying automatically…', migrating: true }, { 'Retry-After': '3' });
    }
    return reply(500, { error: err.message || 'Server error' });
  }
};
