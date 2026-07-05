// Mints a short-lived Google Drive access token for the browser to use for
// a direct, resumable upload straight to Google's servers. The refresh
// token / client secret NEVER leave this function — only a token that
// typically expires in ~1 hour is sent to the browser, and it only has the
// 'drive.file' scope (access solely to files this app creates, not your
// whole Drive).
//
// Required Netlify environment variables (Site settings → Environment
// variables in the Netlify dashboard — never commit these to the repo):
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//
// Optional:
//   GOOGLE_DRIVE_FOLDER_NAME   (default: "EdAssess Exam Recordings")

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const FOLDER_NAME = process.env.GOOGLE_DRIVE_FOLDER_NAME || 'EdAssess Exam Recordings';

async function getAccessToken() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Token refresh failed: ' + text);
  }
  return res.json(); // { access_token, expires_in, ... }
}

async function ensureFolder(accessToken) {
  // Look for an existing folder with this name that the app already created.
  const q = encodeURIComponent(
    `name='${FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (listRes.ok) {
    const data = await listRes.json();
    if (data.files && data.files.length) return data.files[0].id;
  }
  // Not found — create it.
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error('Folder creation failed: ' + text);
  }
  const folder = await createRes.json();
  return folder.id;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      body: JSON.stringify({ error: 'Google Drive is not configured on this site yet. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in Netlify environment variables.' }),
    };
  }
  try {
    const { access_token, expires_in } = await getAccessToken();
    const folderId = await ensureFolder(access_token);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      body: JSON.stringify({ accessToken: access_token, expiresIn: expires_in, folderId }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      body: JSON.stringify({ error: err.message || 'Server error' }),
    };
  }
};
