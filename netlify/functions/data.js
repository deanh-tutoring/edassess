// EdAssess shared data store — Netlify Function backed by Netlify Blobs.
// This is what makes the platform work across the internet instead of
// being trapped in a single browser's localStorage: the teacher's
// dashboard and every student's browser all read/write the SAME store.

const { getStore } = require('@netlify/blobs');

const KEY = 'state';
const EMPTY_STATE = { tests: [], submissions: [], assignments: [] };

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
          break;
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
