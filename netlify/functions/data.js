// EdAssess shared data store — Netlify Function backed by Netlify Blobs.
// This is what makes the platform work across the internet instead of
// being trapped in a single browser's localStorage: the teacher's
// dashboard and every student's browser all read/write the SAME store.

const { getStore } = require('@netlify/blobs');

const KEY = 'state';
const EMPTY_STATE = { tests: [], submissions: [], assignments: [], peerSessions: [] };

function store() {
  return getStore({
    name: 'edassess-data',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
    consistency: 'strong'
  });
}
async function readState() {
  const s = store();
  const data = await s.get(KEY, { type: 'json' });
  if (!data) return { ...EMPTY_STATE };
  return {
    tests: Array.isArray(data.tests) ? data.tests : [],
    submissions: Array.isArray(data.submissions) ? data.submissions : [],
    assignments: Array.isArray(data.assignments) ? data.assignments : [],
    peerSessions: Array.isArray(data.peerSessions) ? data.peerSessions : [],
  };
}

async function writeState(state) {
  await store().setJSON(KEY, state);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  try {
    if (event.httpMethod === 'GET') {
      const state = await readState();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        body: JSON.stringify(state),
      };
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch (e) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          body: JSON.stringify({ error: 'Invalid JSON body' }),
        };
      }

      const action = body.action;
      const state = await readState();

      switch (action) {
        case 'saveTests': {
          state.tests = Array.isArray(body.tests) ? body.tests : state.tests;
          break;
        }
        case 'saveAssignments': {
          state.assignments = Array.isArray(body.assignments) ? body.assignments : state.assignments;
          break;
        }
        case 'upsertSubmission': {
          const sub = body.submission;
          if (sub && sub.id) {
            const idx = state.submissions.findIndex((s) => s.id === sub.id);
            if (idx === -1) state.submissions.push(sub);
            else {
              // `instructorOps` is owned by the server (see 'instructorOp'). A student's routine
              // autosave must never erase an instructor's pending "+5 minutes" / "end section".
              const prevOps = state.submissions[idx].instructorOps;
              if (Array.isArray(prevOps) && prevOps.length) {
                const have = new Set((sub.instructorOps || []).map((o) => o.id));
                sub.instructorOps = (sub.instructorOps || []).concat(prevOps.filter((o) => !have.has(o.id)));
              }
              state.submissions[idx] = sub;
            }
          }
          break;
        }
        case 'instructorOp': {
          // Instructor → live student channel (sectioned tests): add time to a section, or end it.
          // Appended server-side so it can't be lost to a concurrent student autosave; the
          // student's browser applies each op exactly once.
          const op = body.op || {};
          const sub = state.submissions.find((s) => s.id === body.submissionId);
          if (!sub) {
            return {
              statusCode: 404,
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
              body: JSON.stringify({ error: 'Submission not found' }),
            };
          }
          if (op.type !== 'addTime' && op.type !== 'endSection') {
            return {
              statusCode: 400,
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
              body: JSON.stringify({ error: 'Unknown op type' }),
            };
          }
          const clean = {
            id: 'op_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            type: op.type,
            sectionId: typeof op.sectionId === 'string' ? op.sectionId : null,
            at: new Date().toISOString(),
          };
          if (op.type === 'addTime') {
            const secs = Number(op.secs);
            if (!(secs > 0 && secs <= 7200)) {
              return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
                body: JSON.stringify({ error: 'secs must be between 1 and 7200' }),
              };
            }
            clean.secs = Math.round(secs);
          }
          sub.instructorOps = (sub.instructorOps || []).concat(clean);
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
        case 'upsertPeerSession': {
          const ps = body.peerSession;
          if (ps && ps.id) {
            const idx = state.peerSessions.findIndex((p) => p.id === ps.id);
            if (idx === -1) state.peerSessions.push(ps);
            else state.peerSessions[idx] = ps;
          }
          break;
        }
        case 'deletePeerSession': {
          const id = body.id;
          state.peerSessions = state.peerSessions.filter((p) => p.id !== id);
          break;
        }
        case 'deleteTest': {
          const id = body.id;
          state.tests = state.tests.filter((t) => t.id !== id);
          break;
        }
        case 'deleteAssignment': {
          const id = body.id;
          state.assignments = state.assignments.filter((a) => a.id !== id);
          break;
        }
        case 'fullSave': {
          // Full overwrite — used sparingly (e.g. manual "reset everything").
          if (Array.isArray(body.tests)) state.tests = body.tests;
          if (Array.isArray(body.assignments)) state.assignments = body.assignments;
          if (Array.isArray(body.submissions)) state.submissions = body.submissions;
          if (Array.isArray(body.peerSessions)) state.peerSessions = body.peerSessions;
          break;
        }
        case 'importBackup': {
          const backup = body.backup;
        
          if (
            !backup ||
            !Array.isArray(backup.tests) ||
            !Array.isArray(backup.assignments) ||
            !Array.isArray(backup.submissions)
          ) {
            return {
              statusCode: 400,
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
              body: JSON.stringify({ error: 'Invalid backup file.' }),
            };
          }
        
          await writeState({
            tests: backup.tests,
            assignments: backup.assignments,
            submissions: backup.submissions,
            peerSessions: Array.isArray(backup.peerSessions) ? backup.peerSessions : [],
          });
        
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            body: JSON.stringify({ ok: true }),
          };
        }
        default:
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            body: JSON.stringify({ error: 'Unknown action: ' + action }),
          };
      }

      await writeState(state);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        body: JSON.stringify({ ok: true, state }),
      };
    }

    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      body: JSON.stringify({ error: err.message || 'Server error' }),
    };
  }
};
