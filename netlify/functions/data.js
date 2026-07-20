// EdAssess shared data store — Netlify Function backed by Netlify Blobs.
// This is what makes the platform work across the internet instead of
// being trapped in a single browser's localStorage: the teacher's
// dashboard and every student's browser all read/write the SAME store.
//
// ── Safety net (added after a draft test got wiped by a stale save) ──
// 1. VERSION HISTORY: every time `tests` or `assignments` changes, the
//    PREVIOUS value is snapshotted into a rolling history log before being
//    overwritten. Up to 40 versions are kept per collection. This means an
//    accidental overwrite is always recoverable via 'restoreVersion' below
//    — nothing is silently gone forever anymore.
// 2. WIPE GUARD: if a save would shrink `tests` from N existing tests down
//    to 0 (or assignments down to 0) without an explicit `force: true`
//    flag, it's rejected with a 409 instead of silently accepted. This
//    catches the classic "stale browser tab sends an empty array" bug
//    before it destroys anything.
// 3. Still fully undo-able even if you don't catch it right away — history
//    entries are kept, not just the single most recent version.

const { getStore } = require('@netlify/blobs');

const KEY = 'state';
const MAX_HISTORY_PER_COLLECTION = 40;
const EMPTY_STATE = { tests: [], submissions: [], assignments: [] };

function mainStore() {
  return getStore({ name: 'edassess-data', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN, consistency: 'strong' });
}
function historyStore() {
  return getStore({ name: 'edassess-history', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN, consistency: 'strong' });
}

async function readState() {
  const s = mainStore();
  const data = await s.get(KEY, { type: 'json' });
  if (!data) return { ...EMPTY_STATE };
  return {
    tests: Array.isArray(data.tests) ? data.tests : [],
    submissions: Array.isArray(data.submissions) ? data.submissions : [],
    assignments: Array.isArray(data.assignments) ? data.assignments : [],
  };
}

async function writeState(state) {
  await mainStore().setJSON(KEY, state);
}

async function readHistory(collection) {
  const h = await historyStore().get(collection, { type: 'json' });
  return Array.isArray(h) ? h : [];
}

async function pushHistory(collection, previousValue) {
  // Don't bother snapshotting an empty-to-empty no-op.
  if (Array.isArray(previousValue) && previousValue.length === 0) return;
  const list = await readHistory(collection);
  list.push({ ts: new Date().toISOString(), data: previousValue });
  while (list.length > MAX_HISTORY_PER_COLLECTION) list.shift();
  await historyStore().setJSON(collection, list);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  try {
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      if (params.history) {
        // ?history=tests or ?history=assignments
        const list = await readHistory(params.history);
        const summary = list
          .map((entry, idx) => ({
            index: idx,
            ts: entry.ts,
            count: Array.isArray(entry.data) ? entry.data.length : 0,
          }))
          .reverse();
        return json(200, { collection: params.history, versions: summary });
      }
      const state = await readState();
      return json(200, state);
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch (e) {
        return json(400, { error: 'Invalid JSON body' });
      }

      const action = body.action;
      const state = await readState();

      switch (action) {
        case 'saveTests': {
          const incoming = Array.isArray(body.tests) ? body.tests : null;
          if (incoming === null) break;
          if (incoming.length === 0 && state.tests.length > 0 && !body.force) {
            return json(409, {
              error: `Refused to overwrite ${state.tests.length} existing test(s) with an empty list. If this is really intentional, resend with { force: true }.`,
              currentCount: state.tests.length,
            });
          }
          await pushHistory('tests', state.tests);
          state.tests = incoming;
          break;
        }
        case 'saveAssignments': {
          const incoming = Array.isArray(body.assignments) ? body.assignments : null;
          if (incoming === null) break;
          if (incoming.length === 0 && state.assignments.length > 0 && !body.force) {
            return json(409, {
              error: `Refused to overwrite ${state.assignments.length} existing assignment(s) with an empty list. If this is really intentional, resend with { force: true }.`,
              currentCount: state.assignments.length,
            });
          }
          await pushHistory('assignments', state.assignments);
          state.assignments = incoming;
          break;
        }
        case 'upsertSubmission': {
          const sub = body.submission;
          if (sub && sub.id) {
            const idx = state.submissions.findIndex((s) => s.id === sub.id);
            if (idx === -1) state.submissions.push(sub);
            else state.submissions[idx] = sub;
          }
          break;
        }
        case 'deleteSubmission': {
          const id = body.id;
          state.submissions = state.submissions.filter((s) => s.id !== id);
          break;
        }
        case 'deleteSubmissions': {
          const ids = Array.isArray(body.ids) ? body.ids : [];
          state.submissions = state.submissions.filter((s) => !ids.includes(s.id));
          break;
        }
        case 'deleteTest': {
          const id = body.id;
          await pushHistory('tests', state.tests);
          state.tests = state.tests.filter((t) => t.id !== id);
          break;
        }
        case 'deleteAssignment': {
          const id = body.id;
          await pushHistory('assignments', state.assignments);
          state.assignments = state.assignments.filter((a) => a.id !== id);
          break;
        }
        case 'restoreVersion': {
          // { collection: 'tests'|'assignments', index: <index from GET ?history=...> }
          const collection = body.collection;
          if (collection !== 'tests' && collection !== 'assignments') {
            return json(400, { error: 'collection must be "tests" or "assignments"' });
          }
          const list = await readHistory(collection);
          const entry = list[body.index];
          if (!entry) return json(404, { error: 'That version was not found (it may have aged out).' });
          // Snapshot the CURRENT value too, so restoring is itself undo-able.
          await pushHistory(collection, state[collection]);
          state[collection] = entry.data;
          break;
        }
        case 'fullSave': {
          // Full overwrite — used sparingly (e.g. manual "reset everything").
          if (Array.isArray(body.tests)) {
            await pushHistory('tests', state.tests);
            state.tests = body.tests;
          }
          if (Array.isArray(body.assignments)) {
            await pushHistory('assignments', state.assignments);
            state.assignments = body.assignments;
          }
          if (Array.isArray(body.submissions)) state.submissions = body.submissions;
          break;
        }
        default:
          return json(400, { error: 'Unknown action: ' + action });
      }

      await writeState(state);
      return json(200, { ok: true, state });
    }

    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return json(500, { error: err.message || 'Server error' });
  }
};
