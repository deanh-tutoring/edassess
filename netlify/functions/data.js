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
// Google Docs / Sheets / Slides / Forms / Drive links: recognised from the URL alone, so a teacher can also just paste one.
function googleInfo(u) {
  try {
    const x = new URL(u), h = x.hostname;
    if (h === 'docs.google.com') {
      const m = /^\/(document|spreadsheets|presentation|forms)\/d\/(?:e\/)?([\w-]{10,120})/.exec(x.pathname);
      return m ? { kind: m[1], id: m[2] } : null;
    }
    if (h === 'drive.google.com') {
      let m = /^\/file\/d\/([\w-]{10,120})/.exec(x.pathname); if (m) return { kind: 'file', id: m[1] };
      m = /^\/drive\/(?:u\/\d+\/)?folders\/([\w-]{10,120})/.exec(x.pathname); if (m) return { kind: 'folder', id: m[1] };
    }
  } catch (e) { /* not a URL */ }
  return null;
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
  const own = ownerOf(kind === 'test' ? cur.data : cur);
  if (own !== lc(user.username) && lc(user.username) !== ADMIN_USER) return bad('Only the owner can delete this.', 403);
  dropAsgCache();
  await putJ(`${P.trash}${kind}/${id}`, { deletedAt: new Date().toISOString(), rec: cur });
  if (kind === 'test') { try { await snapshot(id, cur); } catch (e) { /* trash copy already written */ } }
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
  return { tests, assignments: asgs, peerSessions: peers, teachers: names, classes: await classesForTeacher(user) };
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
async function upsertSubmission(sub, user, student) {
  if (!sub || !okId(sub.id)) return bad('Submission needs a valid id.');
  const aid = okId(sub.assignmentId) ? sub.assignmentId : '_';
  const clean = JSON.parse(JSON.stringify(sub));
  await externalizeImages(clean);
  const key = P.sub + aid + '/' + sub.id;
  const prev = await getJ(key);
  delete clean.gradedBy; delete clean.commentBy; delete clean.studentKey;
  if (!user) { delete clean.graded; delete clean.gradedAt; if (prev && prev.graded) { clean.graded = true; clean.gradedAt = prev.gradedAt || null; } }
  if (!user) {
    const asg0 = okId(clean.assignmentId) ? await getJ(P.asg + clean.assignmentId) : null;
    if (student && student._ro) return bad('This is a preview. Open student view as a specific student to take or submit work.', 403);
    const deny = await accessCheckAssignment(asg0, student);
    if (deny) return deny;
    if (prev && prev.studentKey && (!student || student.key !== prev.studentKey)) return reply(403, { error: 'This submission belongs to another account.' });
    if (student && student._imp) clean.viaTeacher = student._imp;
    if (student) { clean.studentKey = student.key; if (asg0 && asg0.requireAccount) clean.studentName = student.name; }
  } else if (prev && prev.studentKey) clean.studentKey = prev.studentKey;
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
  if (clean.studentKey) await putJ(SS_PREFIX + clean.studentKey + '/' + clean.id, { id: clean.id, aid, at: new Date().toISOString() });
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
    {
      const mine = (await allClasses()).filter((c) => classRole(c, user)).map((c) => c.id);
      clean.classIds = (Array.isArray(clean.classIds) ? clean.classIds : []).filter((id) => mine.includes(id));
      clean.requireAccount = !!clean.requireAccount;
      clean.dueAt = clean.dueAt ? String(clean.dueAt).slice(0, 40) : null;
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
function signToken(u, ttl, extra) {
  const p = b64u(JSON.stringify({ u, exp: Date.now() + (ttl || TOKEN_TTL_MS), ...(extra || {}) }));
  return p + '.' + b64u(crypto.createHmac('sha256', secret()).update(p).digest());
}
function tokenMeta(tok) {   // payload of a valid token (used for teacher "student view" sessions)
  const u = readToken(tok); if (!u) return null;
  try { return JSON.parse(Buffer.from(tok.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch (e) { return null; }
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
  if (!name || name.startsWith('s:')) return null;
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
    if (body.agree !== true) return bad('Please confirm you are 13 or older and agree to the Terms of Service and Privacy Policy.');
    if (!sameStr(lc(body.keyword), lc(kw))) return bad('That keyword is not right.', 403);
    const username = String(body.username || '').trim(), name = String(body.name || '').trim().slice(0, 60);
    if (!USER_RE.test(username)) return bad('Username: 3–30 letters, numbers, . _ -');
    if (!name) return bad('Enter the name students should see.');
    if (String(body.password || '').length < 8) return bad('Password needs at least 8 characters.');
    await ensureAdmin();
    if (await getJ(U_PREFIX + lc(username))) return bad('That username is taken.', 409);
    const u = { username, name, role: 'teacher', createdAt: new Date().toISOString(), termsAt: new Date().toISOString(), termsV: TERMS_V };
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

/* ═══════════════ STUDENT ACCOUNTS & CLASSES ═══════════════
   A student account is just "First L" (first name + last initial) and a password.
   Teachers own classes; students join with a code or accept a teacher's invite by name.          */
const S_PREFIX = 'v2/stu/', C_PREFIX = 'v2/class/', SS_PREFIX = 'v2/stusub/';
const capWord = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
function normStudentName(raw) {
  const m = /^([A-Za-z][A-Za-z'’-]{0,23})\s+([A-Za-z])\.?([2-9]?)$/.exec(String(raw || '').trim().replace(/\s+/g, ' '));
  if (!m) return null;
  const first = m[1].split('-').map(capWord).join('-');
  const name = `${first} ${m[2].toUpperCase()}${m[3]}`;
  return { name, key: name.toLowerCase().replace(/[’']/g, '').replace(/\s/g, '_') };
}
const NAME_HELP = 'Use your first name and last initial, like “Sam K”. If a classmate has the same name, add a number after your initial (Sam K2).';
const pubStudent = (s) => ({ key: s.key, name: s.name, mustChange: !!s.mustChange, role: 'student' });
async function setStudentPw(s, pw, mustChange) {
  s.salt = crypto.randomBytes(16).toString('hex'); s.hash = hashPw(pw, s.salt); s.mustChange = !!mustChange;
  s.fails = 0; s.lockUntil = 0; s.pwAt = new Date().toISOString();
  await putJ(S_PREFIX + s.key, s);
}
async function studentFromEvent(event) {
  const h = event.headers || {};
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || h.Authorization || '');
  const t = m && readToken(m[1]);
  if (!t || !t.startsWith('s:')) return null;
  const meta = tokenMeta(m[1]) || {};
  let s;
  if (meta.pv) s = { key: 'preview~' + meta.imp, name: 'Student view', preview: true, cid: meta.cid || null, owner: meta.imp };   // virtual, never stored
  else s = await getJ(S_PREFIX + t.slice(2));
  if (!s || s.disabled) return null;
  if (s.teacher) { const tu = await getJ(U_PREFIX + s.teacher); if (!tu || tu.disabled) return null; }   // a teacher's own student identity dies with the teacher account
  if (meta.imp) { s = { ...s }; Object.defineProperty(s, '_imp', { value: meta.imp }); Object.defineProperty(s, '_ro', { value: !!meta.pv }); }   // non-enumerable: never saved
  return s;
}
const STU_ERR = () => reply(401, { error: 'Please sign in to your student account.', needAccount: true });
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function newClassCode() {
  for (let i = 0; i < 30; i++) {
    let c = ''; for (let k = 0; k < 6; k++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    const taken = (await allClasses()).some((x) => x.joinCode === c) || (await allAsgs()).some((a) => String(a.code || '').toUpperCase() === c);
    if (!taken) return c;
  }
  throw new Error('code');
}
let _clsCache = { t: 0, vals: [] };
async function allClasses() {
  if (Date.now() - _clsCache.t < 2500) return _clsCache.vals;
  const vals = (await mapLimit(await listKeys(C_PREFIX), 24, getJ)).filter(Boolean);
  _clsCache = { t: Date.now(), vals };
  return vals;
}
const dropClsCache = () => { _clsCache = { t: 0, vals: [] }; };
async function saveClass(c) { await putJ(C_PREFIX + c.id, c); dropClsCache(); }
function classRole(c, user) {
  if (!user || !c) return null;
  const me = lc(user.username);
  if (ownerOf(c) === me) return 'owner';
  return (c.coTeachers || []).map(lc).includes(me) ? 'edit' : null;
}
const clsClean = (c) => ({ id: c.id, name: c.name, subject: c.subject || '', period: c.period || '', ownerId: ownerOf(c), coTeachers: c.coTeachers || [], joinCode: c.joinCode, archived: !!c.archived, createdAt: c.createdAt, students: c.students || [], invites: c.invites || [], announcements: c.announcements || [], materials: c.materials || [], topics: c.topics || [] });
async function classesForTeacher(user) {
  const mine = (await allClasses()).filter((c) => classRole(c, user));
  const out = [];
  for (const c of mine) {
    const x = clsClean(c);
    x.invites = await Promise.all((c.invites || []).map(async (i) => ({ ...i, registered: !!(await getJ(S_PREFIX + i.key)) })));
    out.push(x);
  }
  return out;
}
/* ── peer review for student accounts ── */
function peerSafeSession(ps, subId) {
  // what a reviewee may see: their own completed, un-hidden reviews — never who wrote them
  const pairs = (ps.pairs || []).filter((p) => p.revieweeSubId === subId && p.status === 'completed' && !p.hiddenFromStudent)
    .map((p) => ({ id: p.id, revieweeSubId: p.revieweeSubId, status: 'completed', rubricScores: p.rubricScores || {}, feedback: p.feedback || {}, hiddenFromStudent: false, completedAt: p.completedAt || null }));
  return pairs.length ? { id: ps.id, testId: ps.testId, essayKeys: ps.essayKeys || [], status: ps.status, pairs } : null;
}
async function peerSummary(s, subs) {
  const ids = new Set(subs.map((x) => x.id));
  const sessions = (await readAll(P.peer)).vals.filter(Boolean);
  const tasks = [], feedback = {};
  for (const ps of sessions) {
    const mine = (ps.pairs || []).filter((p) => ids.has(p.reviewerSubId));
    if (mine.length) {
      const done = mine.filter((p) => p.status === 'completed').length;
      if (ps.status === 'active' || done === mine.length) {
        const r = okId(ps.testId) ? await getJ(P.test + ps.testId) : null;
        tasks.push({ sessionId: ps.id, testId: ps.testId, title: (r && r.data && r.data.title) || 'Peer review', status: ps.status, total: mine.length, done, createdAt: ps.createdAt || null });
      }
    }
    for (const p of ps.pairs || []) if (ids.has(p.revieweeSubId) && p.status === 'completed' && !p.hiddenFromStudent) feedback[p.revieweeSubId] = (feedback[p.revieweeSubId] || 0) + 1;
  }
  return { tasks, feedback };
}
async function mySubIds(s) {
  const keys = await listKeys(SS_PREFIX + s.key + '/');
  return new Set((await mapLimit(keys, 12, getJ)).filter(Boolean).map((i) => i.id));
}
async function studentPeerTask(body, s) {
  const ps = okId(body.sessionId) ? await getJ(P.peer + body.sessionId) : null;
  if (!ps) return bad('That peer review no longer exists.', 404);
  const ids = await mySubIds(s);
  const mine = (ps.pairs || []).filter((p) => ids.has(p.reviewerSubId));
  if (!mine.length) return bad('You are not part of this peer review.', 403);
  const pending = mine.filter((p) => p.status !== 'completed');
  const pair = pending.find((p) => p.id === body.pairId) || pending[0] || null;
  const r = okId(ps.testId) ? await getJ(P.test + ps.testId) : null;
  const out = { ok: true, session: { id: ps.id, status: ps.status, essayKeys: ps.essayKeys || [] }, total: mine.length, done: mine.length - pending.length, test: r ? unwrapTest(r) : null, pair: null, answers: {} };
  if (pair && ps.status === 'active') {
    out.pair = { id: pair.id, rubricScores: pair.rubricScores || {}, feedback: pair.feedback || {} };
    const sub = await findSub(pair.revieweeSubId);
    for (const k of ps.essayKeys || []) if (sub && sub.answers && sub.answers[k] !== undefined) out.answers[k] = sub.answers[k];
  }
  return reply(200, out);
}
async function studentPeerSave(body, s) {
  const key = P.peer + String(body.sessionId || '');
  const ps = okId(body.sessionId) ? await getJ(key) : null;
  if (!ps) return bad('That peer review no longer exists.', 404);
  if (ps.status !== 'active') return bad('This peer review is closed.', 409);
  const ids = await mySubIds(s);
  const pair = (ps.pairs || []).find((p) => p.id === body.pairId && ids.has(p.reviewerSubId));
  if (!pair) return bad('That review is not assigned to you.', 403);
  if (pair.status === 'completed') return reply(200, { ok: true, already: true });
  const sc = body.rubricScores && typeof body.rubricScores === 'object' ? body.rubricScores : {};
  const fb = body.feedback && typeof body.feedback === 'object' ? body.feedback : {};
  const cs = {}, cf = {};
  for (const k of Object.keys(sc).slice(0, 50)) { cs[k] = {}; for (const ri of Object.keys(sc[k] || {}).slice(0, 30)) { const v = Number(sc[k][ri]); if (Number.isFinite(v) && v >= 0 && v <= 1000) cs[k][ri] = v; } }
  for (const k of Object.keys(fb).slice(0, 50)) cf[k] = String(fb[k] || '').slice(0, 4000);
  pair.rubricScores = cs; pair.feedback = cf;
  if (!pair.startedAt) pair.startedAt = new Date().toISOString();
  if (body.complete) { pair.status = 'completed'; pair.completedAt = new Date().toISOString(); }
  await putJ(key, ps);
  const mine = ps.pairs.filter((p) => ids.has(p.reviewerSubId));
  return reply(200, { ok: true, total: mine.length, done: mine.filter((p) => p.status === 'completed').length });
}
const TERMS_V = '2026-11-17';
const testMax = (t) => (t && t.kind === 'survey') ? 0 : ((t && t.questions) || []).reduce((a, q) => a + (Number(q.points) || 1), 0);
async function studentHome(s) {
  const classes = (await allClasses()).filter((c) => !c.archived || s.preview || (c.students || []).some((x) => x.key === s.key));
  const mine = s.preview ? classes.filter((c) => (ownerOf(c) === s.owner || (c.coTeachers || []).map(lc).includes(s.owner)) && (!s.cid || c.id === s.cid)) : classes.filter((c) => (c.students || []).some((x) => x.key === s.key));
  const invites = classes.filter((c) => !c.archived && (c.invites || []).some((i) => i.key === s.key));
  const ids = new Set(mine.map((c) => c.id));
  const asgAll = await allAsgs();
  const subKeys = await listKeys(SS_PREFIX + s.key + '/');
  const idx = (await mapLimit(subKeys, 12, getJ)).filter(Boolean);
  const subs = (await mapLimit(idx.map((i) => i.id), 12, findSub)).filter(Boolean);
  const wanted = new Map();
  asgAll.filter((a) => (a.classIds || []).some((id) => ids.has(id))).forEach((a) => wanted.set(a.id, a));
  for (const sub of subs) if (okId(sub.assignmentId) && !wanted.has(sub.assignmentId)) { const a = asgAll.find((x) => x.id === sub.assignmentId); if (a) wanted.set(a.id, a); }
  const tcache = {};
  const assignments = [];
  for (const a of wanted.values()) {
    if (!(a.testId in tcache)) { const r = okId(a.testId) ? await getJ(P.test + a.testId) : null; tcache[a.testId] = r ? r.data : null; }
    const t = tcache[a.testId];
    assignments.push({ id: a.id, title: a.title || (t && t.title) || 'Assessment', testId: a.testId, code: a.code, classIds: (a.classIds || []).filter((id) => ids.has(id)), requireAccount: !!a.requireAccount, dueAt: a.dueAt || null, opensAt: a.opensAt || null, closesAt: a.closesAt || null, closedAt: a.closedAt || null, timed: !!a.timed, maxMinutes: a.maxMinutes || null, releaseScores: !!a.releaseScores, survey: !!(a.survey || (t && t.kind === 'survey')), questions: ((t && t.questions) || []).length, maxPoints: testMax(t), satSubject: (t && t.satSubject) || null, createdAt: a.createdAt || null, ownerId: ownerOf(a), coTeachers: a.coTeachers || [] });
  }
  const subOut = subs.map((x) => ({ id: x.id, assignmentId: x.assignmentId, status: x.status, score: x.score == null ? null : x.score, submittedAt: x.submittedAt || null, startedAt: x.startedAt || null, gradedBy: x.gradedBy || null, graded: !!x.graded, maxScore: x.maxScore > 0 ? x.maxScore : null, curved: x.curvedScore == null ? null : x.curvedScore }));
  const set = new Set();
  for (const c of [...mine, ...invites]) { set.add(ownerOf(c)); (c.coTeachers || []).forEach((u) => set.add(lc(u))); }
  assignments.forEach((a) => set.add(a.ownerId));
  subs.forEach((x) => x.gradedBy && set.add(lc(x.gradedBy)));
  const strip = (c) => ({ id: c.id, name: c.name, subject: c.subject || '', period: c.period || '', ownerId: ownerOf(c), coTeachers: c.coTeachers || [], announcements: (c.announcements || []).slice(-15).reverse(), materials: c.materials || [], topics: c.topics || [], joinedAt: ((c.students || []).find((x) => x.key === s.key) || {}).joinedAt || null, archived: !!c.archived, size: (c.students || []).length });
  const peer = await peerSummary(s, subs);
  return { peer, student: pubStudent(s), classes: mine.map(strip), invites: invites.map((c) => ({ id: c.id, name: c.name, ownerId: ownerOf(c), invitedAt: ((c.invites || []).find((i) => i.key === s.key) || {}).at || null })), assignments, submissions: subOut, teachers: await namesFor(set), serverTime: new Date().toISOString() };
}
async function studentAction(body, student) {
  const a = body.action;
  if (a === 'studentSignup' || a === 'studentLogin') {
    if (!secret()) return bad('Accounts are not configured yet: the site owner must set EA_AUTH_SECRET.', 500);
    const n = normStudentName(body.name);
    if (!n) return bad(NAME_HELP);
    const pw = String(body.password || '');
    if (a === 'studentSignup') {
      if (body.agree !== true) return bad('Please confirm you are 13 or older, or that a parent or guardian said it is OK, and agree to the Terms of Service.');
      if (pw.length < 6) return bad('Choose a password with at least 6 characters.');
      if (await getJ(S_PREFIX + n.key)) return bad('There is already an account named ' + n.name + '. Sign in instead — or, if you are a different student, add a number after your initial (for example ' + n.name.replace(/\d*$/, '') + '2).', 409);
      const s = { key: n.key, name: n.name, createdAt: new Date().toISOString(), termsAt: new Date().toISOString(), termsV: TERMS_V };
      await setStudentPw(s, pw, false);
      return reply(200, { token: signToken('s:' + s.key), student: pubStudent(s), created: true });
    }
    const s = await getJ(S_PREFIX + n.key);
    if (!s) { hashPw(pw, 'x'.repeat(16)); return bad('No account with that name yet. Tap “Create my account” to set one up.', 404); }
    if (s.lockUntil && s.lockUntil > Date.now()) return bad('Too many attempts. Wait a minute and try again.', 429);
    if (s.disabled || !sameStr(hashPw(pw, s.salt), s.hash)) {
      s.fails = (s.fails || 0) + 1;
      if (s.fails >= 5) { s.fails = 0; s.lockUntil = Date.now() + 60000; }
      await putJ(S_PREFIX + s.key, s);
      return bad('Wrong name or password. Forgot it? Ask your teacher to have the administrator reset it.', 401);
    }
    s.fails = 0; s.lockUntil = 0; s.lastLogin = new Date().toISOString();
    await putJ(S_PREFIX + s.key, s);
    return reply(200, { token: signToken('s:' + s.key), student: pubStudent(s) });
  }
  const SA = ['studentPeerTask', 'studentPeerSave', 'studentMe', 'studentChangePassword', 'joinClass', 'respondInvite', 'leaveClass'];
  if (!SA.includes(a)) return null;
  if (!student) return STU_ERR();
  if (student._imp && ['studentChangePassword', 'joinClass', 'respondInvite', 'leaveClass'].includes(a)) return bad('Not available in student view.', 403);
  if (student._ro && a === 'studentPeerSave') return bad('Preview only: pick a student to act as them.', 403);
  if (a === 'studentMe') return reply(200, await studentHome(student));
  if (a === 'studentPeerTask') return studentPeerTask(body, student);
  if (a === 'studentPeerSave') return studentPeerSave(body, student);
  if (a === 'studentChangePassword') {
    if (String(body.newPassword || '').length < 6) return bad('Choose a password with at least 6 characters.');
    if (!sameStr(hashPw(body.oldPassword || '', student.salt), student.hash)) return bad('Current password is wrong.', 403);
    await setStudentPw(student, body.newPassword, false);
    return reply(200, { ok: true, student: pubStudent(student) });
  }
  if (a === 'joinClass') {
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const c = (await allClasses()).find((x) => x.joinCode === code && !x.archived);
    if (!c) return bad('No class has that code. Check it with your teacher.', 404);
    c.students = c.students || [];
    if (!c.students.some((x) => x.key === student.key)) c.students.push({ key: student.key, name: student.name, joinedAt: new Date().toISOString() });
    c.invites = (c.invites || []).filter((i) => i.key !== student.key);
    await saveClass(c);
    return reply(200, { ok: true, classId: c.id, name: c.name });
  }
  const c = okId(body.classId) ? await getJ(C_PREFIX + body.classId) : null;
  if (!c) return bad('Class not found.', 404);
  if (a === 'respondInvite') {
    if (!(c.invites || []).some((i) => i.key === student.key)) return bad('That invitation is no longer there.', 404);
    c.invites = c.invites.filter((i) => i.key !== student.key);
    if (body.accept) { c.students = c.students || []; if (!c.students.some((x) => x.key === student.key)) c.students.push({ key: student.key, name: student.name, joinedAt: new Date().toISOString() }); }
    await saveClass(c);
    return reply(200, { ok: true });
  }
  if (a === 'leaveClass') { c.students = (c.students || []).filter((x) => x.key !== student.key); await saveClass(c); return reply(200, { ok: true }); }
  return null;
}
async function classAction(body, user) {
  const a = body.action;
  const CA = ['createClass', 'updateClass', 'deleteClass', 'setClassCoTeachers', 'inviteStudents', 'cancelInvite', 'removeStudent', 'regenClassCode', 'postAnnouncement', 'deleteAnnouncement', 'postMaterial', 'deleteMaterial', 'setClasswork', 'listClasses', 'adminListStudents', 'adminResetStudentPassword', 'adminSetStudentDisabled', 'impersonateStudent'];
  if (!CA.includes(a)) return null;
  if (!user) return AUTH_ERR();
  if (a === 'listClasses') return reply(200, { classes: await classesForTeacher(user) });
  if (a.startsWith('admin')) {
    if (user.role !== 'admin') return bad('Admin only.', 403);
    if (a === 'adminListStudents') {
      const ss = (await mapLimit(await listKeys(S_PREFIX), 12, getJ)).filter((x) => x && !x.teacher);
      const cls = await allClasses();
      const out = [];
      for (const s of ss) {
        const mine = cls.filter((c) => (c.students || []).some((x) => x.key === s.key));
        const n = (await listKeys(SS_PREFIX + s.key + '/')).length;
        out.push({ key: s.key, name: s.name, createdAt: s.createdAt, lastLogin: s.lastLogin || null, disabled: !!s.disabled, mustChange: !!s.mustChange, submissions: n, classes: mine.map((c) => ({ id: c.id, name: c.name, teacher: ownerOf(c) })) });
      }
      const names = await namesFor(new Set(out.flatMap((s) => s.classes.map((c) => c.teacher))));
      out.forEach((s) => s.classes.forEach((c) => { c.teacherName = names[c.teacher] || c.teacher; }));
      return reply(200, { students: out.sort((x, y) => x.name.localeCompare(y.name)) });
    }
    const s = await getJ(S_PREFIX + String(body.key || ''));
    if (!s) return bad('No such student.', 404);
    if (a === 'adminSetStudentDisabled') { s.disabled = !!body.disabled; await putJ(S_PREFIX + s.key, s); return reply(200, { ok: true }); }
    if (String(body.newPassword || '').length < 6) return bad('Password needs at least 6 characters.');
    await setStudentPw(s, body.newPassword, true);
    return reply(200, { ok: true });
  }
  if (a === 'createClass') {
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return bad('Give the class a name.');
    const c = { id: crypto.randomBytes(8).toString('hex'), name, subject: String(body.subject || '').trim().slice(0, 40), period: String(body.period || '').trim().slice(0, 20), ownerId: lc(user.username), coTeachers: [], joinCode: await newClassCode(), students: [], invites: [], announcements: [], createdAt: new Date().toISOString() };
    await saveClass(c);
    return reply(200, { ok: true, class: clsClean(c) });
  }
  const c = okId(body.id || body.classId) ? await getJ(C_PREFIX + (body.id || body.classId)) : null;
  const role = classRole(c, user);
  if (!c || !role) return bad('Class not found.', 404);
  if ((a === 'deleteClass' || a === 'setClassCoTeachers') && role !== 'owner') return bad('Only the class owner can do that.', 403);
  if (a === 'impersonateStudent') {
    if (!secret()) return bad('Accounts are not configured yet.', 500);
    const TTL = 2 * 3600 * 1000, me = lc(user.username);
    if (!body.studentKey) return reply(200, { ok: true, preview: true, token: signToken('s:preview~' + me, TTL, { imp: me, pv: 1, cid: c.id }), student: { key: 'preview~' + me, name: 'Student view', role: 'student' }, className: c.name });
    const st = (c.students || []).find((x) => x.key === String(body.studentKey));
    const rec = st && (await getJ(S_PREFIX + st.key));
    if (!rec) return bad('That student is not in this class.', 404);
    return reply(200, { ok: true, token: signToken('s:' + rec.key, TTL, { imp: me }), student: pubStudent(rec), className: c.name });
  }
  if (a === 'deleteClass') { await delK(C_PREFIX + c.id); dropClsCache(); return reply(200, { ok: true }); }
  if (a === 'setClassCoTeachers') { c.coTeachers = await cleanCoTeachers(body.coTeachers, ownerOf(c)); await saveClass(c); return reply(200, { ok: true, coTeachers: c.coTeachers }); }
  if (a === 'updateClass') {
    if (body.name !== undefined) { const n = String(body.name).trim().slice(0, 60); if (n) c.name = n; }
    if (body.subject !== undefined) c.subject = String(body.subject).trim().slice(0, 40);
    if (body.period !== undefined) c.period = String(body.period).trim().slice(0, 20);
    if (body.archived !== undefined) c.archived = !!body.archived;
    await saveClass(c); return reply(200, { ok: true, class: clsClean(c) });
  }
  if (a === 'regenClassCode') { c.joinCode = await newClassCode(); await saveClass(c); return reply(200, { ok: true, joinCode: c.joinCode }); }
  if (a === 'inviteStudents') {
    const res = { invited: [], already: [], bad: [] };
    c.students = c.students || []; c.invites = c.invites || [];
    for (const raw of Array.isArray(body.names) ? body.names.slice(0, 80) : []) {
      let n = normStudentName(raw);
      if (!n && /^@[A-Za-z0-9._-]{2,40}$/.test(String(raw).trim())) {   // invite a teacher to join as a student
        const tu = await getJ(U_PREFIX + lc(String(raw).trim().slice(1)));
        if (tu && !tu.disabled) n = { key: 't~' + lc(tu.username), name: tu.name || tu.username };
      }
      if (!n) { if (String(raw).trim()) res.bad.push(String(raw).trim()); continue; }
      if (c.students.some((x) => x.key === n.key) || c.invites.some((i) => i.key === n.key)) { res.already.push(n.name); continue; }
      c.invites.push({ key: n.key, name: n.name, at: new Date().toISOString(), by: lc(user.username) });
      res.invited.push(n.name);
    }
    await saveClass(c);
    return reply(200, { ok: true, ...res });
  }
  if (a === 'cancelInvite') { c.invites = (c.invites || []).filter((i) => i.key !== body.key); await saveClass(c); return reply(200, { ok: true }); }
  if (a === 'removeStudent') { c.students = (c.students || []).filter((x) => x.key !== body.key); await saveClass(c); return reply(200, { ok: true }); }
  if (a === 'postAnnouncement') {
    const text = String(body.text || '').trim().slice(0, 1000);
    if (!text) return bad('Write something first.');
    c.announcements = c.announcements || [];
    c.announcements.push({ id: crypto.randomBytes(6).toString('hex'), text, by: lc(user.username), at: new Date().toISOString() });
    c.announcements = c.announcements.slice(-40);
    await saveClass(c); return reply(200, { ok: true });
  }
  if (a === 'postMaterial') {
    const title = String(body.title || '').trim().slice(0, 120);
    if (!title) return bad('Give the material a title.');
    const links = [];
    for (const l of (Array.isArray(body.links) ? body.links : []).slice(0, 10)) {
      let u = String((l && l.url) || '').trim().slice(0, 600);
      if (!u) continue;
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      try { const x = new URL(u); if (!/^https?:$/.test(x.protocol) || !x.hostname.includes('.')) continue; u = x.href; } catch (e) { continue; }
      const g = googleInfo(u);
      links.push({ url: u, label: String((l && l.label) || '').trim().slice(0, 120), ...(g && l && l.embed === true ? { embed: true } : {}) });
    }
    c.materials = c.materials || [];
    const base = { title, body: String(body.body || '').trim().slice(0, 4000), topic: String(body.topic || '').trim().slice(0, 40), links };
    const old = body.matId ? c.materials.find((m) => m.id === body.matId) : null;
    if (old) Object.assign(old, base, { editedAt: new Date().toISOString() });
    else { if (base.topic) { c.topics = c.topics || []; if (!c.topics.includes(base.topic)) c.topics.push(base.topic); } c.materials.push({ id: crypto.randomBytes(6).toString('hex'), ...base, by: lc(user.username), at: new Date().toISOString() }); c.materials = c.materials.slice(-100); }
    await saveClass(c); return reply(200, { ok: true });
  }
  if (a === 'setClasswork') {
    const names = [];
    for (const t of (Array.isArray(body.topics) ? body.topics : []).slice(0, 30)) { const n = String(t || '').trim().slice(0, 40); if (n && !names.includes(n)) names.push(n); }
    const byId = new Map((c.materials || []).map((m) => [m.id, m]));
    const next = [];
    for (const it of (Array.isArray(body.materials) ? body.materials : []).slice(0, 200)) {
      const m = it && byId.get(it.id); if (!m) continue; byId.delete(it.id);
      const t = String((it && it.topic) || '').trim().slice(0, 40); m.topic = t;
      if (t && !names.includes(t) && names.length < 30) names.push(t);
      next.push(m);
    }
    for (const m of byId.values()) next.push(m);
    c.materials = next; c.topics = names;
    await saveClass(c); return reply(200, { ok: true });
  }
  if (a === 'deleteMaterial') { c.materials = (c.materials || []).filter((x) => x.id !== body.matId); await saveClass(c); return reply(200, { ok: true }); }
  if (a === 'deleteAnnouncement') { c.announcements = (c.announcements || []).filter((x) => x.id !== body.annId); await saveClass(c); return reply(200, { ok: true }); }
  return null;
}
async function accessCheckAssignment(asg, student) {
  // returns an error reply when this assignment needs an account the caller doesn't have
  if (!asg || !asg.requireAccount) return null;
  if (!student) return STU_ERR();
  if ((asg.classIds || []).length) {
    const cls = await allClasses();
    const ok = cls.some((c) => asg.classIds.includes(c.id) && (c.students || []).some((x) => x.key === student.key));
    if (!ok) return reply(403, { error: 'This assessment is for a class you are not in yet.', notInClass: true });
  }
  return null;
}


/* ── GET ── */
async function handleGet(q, user, student) {
  await ensureMigrated();
  if (q.gcfg) {
    // public values only: these identify the app to Google's picker, they are not secrets
    return reply(200, { ok: true, clientId: process.env.GOOGLE_CLIENT_ID || '', apiKey: process.env.GOOGLE_API_KEY || '', appId: process.env.GOOGLE_APP_ID || '' });
  }
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
    if (a) return reply(200, { id: a.id });
    const cl = (await allClasses()).find((x) => x.joinCode === c && !x.archived);
    return cl ? reply(200, { classCode: true, name: cl.name, teacher: (await namesFor(new Set([ownerOf(cl)])))[ownerOf(cl)] }) : bad('Not found', 404);
  }
  if (q.part === 'student') { if (!student) return STU_ERR(); return reply(200, await studentHome(student)); }
  if (q.part === 'classes' && user) return reply(200, { classes: await classesForTeacher(user) });
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
  if (q.asg) {
    // lightweight read of just the assignment record (used to confirm a save without downloading every submission)
    if (!user) return AUTH_ERR();
    if (!okId(q.asg)) return bad('Bad id.');
    const one = await getJ(P.asg + q.asg);
    return reply(200, { assignments: one ? [one] : [] });
  }
  if (q.exam) {
    if (!okId(q.exam)) return bad('Bad id.');
    const asg = await getJ(P.asg + q.exam);
    const deny = (user ? null : await accessCheckAssignment(asg, student));
    if (deny) return deny;
    const test = asg && okId(asg.testId) ? await getJ(P.test + asg.testId) : null;
    const page = asg ? await readSubsPage(P.sub + q.exam + '/', null) : { submissions: [], next: null };
    if (asg && asg.requireAccount) page.submissions = page.submissions.filter((x) => x.studentKey === student.key);
    return reply(200, { tests: test ? [unwrapTest(test)] : [], assignments: asg ? [asg] : [], submissions: page.submissions, peerSessions: [], teachers: await teachersForStudent(asg, test, page.submissions), scoped: 'exam', truncated: !!page.next });
  }
  if (q.results) {
    const sub = await findSub(q.results);
    if (!sub) return reply(200, { tests: [], assignments: [], submissions: [], peerSessions: [], scoped: 'results' });
    const asg = okId(sub.assignmentId) ? await getJ(P.asg + sub.assignmentId) : null;
    const tid = asg ? asg.testId : sub.testId;
    const test = okId(tid) ? await getJ(P.test + tid) : null;
    const peers = (await readAll(P.peer)).vals.filter(Boolean).map((ps) => peerSafeSession(ps, sub.id)).filter(Boolean);
    return reply(200, { tests: test ? [unwrapTest(test)] : [], assignments: asg ? [asg] : [], submissions: [sub], peerSessions: peers, teachers: await teachersForStudent(asg, test, [sub]), scoped: 'results' });
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
async function handlePost(body, user, student) {
  await ensureMigrated();
  const au = await authAction(body, user);
  if (au) return au;
  if (body.action === 'teacherStudentSession') {
    if (!user) return AUTH_ERR();
    const me = lc(user.username), key = 't~' + me;
    let rec = await getJ(S_PREFIX + key);
    if (!rec) { rec = { key, name: user.name || user.username, teacher: me, createdAt: new Date().toISOString() }; await putJ(S_PREFIX + key, rec); }
    else if (rec.name !== (user.name || user.username)) { rec.name = user.name || user.username; await putJ(S_PREFIX + key, rec); }
    return reply(200, { ok: true, token: signToken('s:' + key, 12 * 3600 * 1000, { self: 1 }), student: pubStudent(rec) });
  }
  const sa = await studentAction(body, student);
  if (sa) return sa;
  const ca = await classAction(body, user);
  if (ca) return ca;
  const PUBLIC = ['upsertSubmission', 'putImage', 'upsertPeerSession', 'putPeerSession'];
  const publicOp = body.action === 'instructorOp' && body.op && body.op.type === 'upload';
  if (!user && !PUBLIC.includes(body.action) && !publicOp) return AUTH_ERR();
  switch (body.action) {
    case 'putTest': return putTest(body.test, body.baseRev, !!body.force, user);
    case 'putAssignment': return putSimple(P.asg, body.assignment, user);
    case 'putPeerSession':
    case 'upsertPeerSession': return putSimple(P.peer, body.peerSession, user);
    case 'upsertSubmission': return upsertSubmission(body.submission, user, student);
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
    const student = await studentFromEvent(event);
    if (event.httpMethod === 'GET') return await handleGet(event.queryStringParameters || {}, user, student);
    if (event.httpMethod === 'POST') {
      if ((event.body || '').length > MAX_BODY) return bad('That save is too large (over 5.5 MB). Remove or shrink large images and try again.', 413);
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return bad('Invalid JSON body'); }
      return await handlePost(body, user, student);
    }
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    if (err instanceof MigrationPending) {
      return reply(503, { error: 'Upgrading your data store — this takes a moment. Retrying automatically…', migrating: true }, { 'Retry-After': '3' });
    }
    return reply(500, { error: err.message || 'Server error' });
  }
};
