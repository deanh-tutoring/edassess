# EdAssess — Deployment Notes

EdAssess is a single static page (`index.html`) plus one serverless
function (`netlify/functions/data.js`) that gives it a **shared cloud
database** using [Netlify Blobs](https://docs.netlify.com/blobs/overview/).

## Why this matters

Previously all data (tests, assignments, student submissions) lived only
in `localStorage`, which is private to one browser on one device. That
meant a test created on the teacher's laptop was invisible to students
opening the exam link on their own phones/laptops, and student answers
never made it back to the teacher. This version fixes that: every
read/write goes through `/.netlify/functions/data`, backed by Netlify
Blobs, so the teacher dashboard and every student's device share the
exact same data — fully functional across the internet, not just on
one machine.

## Deploying

1. Push this folder (or drag-and-drop it) to a new Netlify site.
2. Netlify auto-detects `netlify.toml`, installs `@netlify/blobs` from
   `package.json`, and deploys `netlify/functions/data.js` as a
   serverless function. No environment variables or manual database
   setup are required — Netlify Blobs provisions automatically per site.
3. Once deployed, the exam links (`yoursite.netlify.app/?exam=...`) and
   results links (`yoursite.netlify.app/?results=...`) will work from
   any device, anywhere — they all hit the same shared backend.

## Login

The instructor login is `admin` / `deanh` (unchanged from the original
app). This is a simple client-side gate, not real authentication —
suitable for a classroom tool, not for protecting sensitive data.

## What changed in this update

- **Delete student responses**: trash-can buttons were added to the
  Live Monitor, Grade Center list, the grading modal, the dashboard's
  recent submissions, and the student control panel. There's also a
  "delete all responses for this assignment" option in Live Monitor.
  Deleting asks for confirmation and removes the response from the
  shared cloud store (not just the local view).
- **Cloud-backed storage**: `tests`, `assignments`, and `submissions`
  are now persisted via Netlify Blobs through `data.js`, with
  `localStorage` kept only as an instant-paint cache / offline fallback.
  The Live Monitor polls the server every 3 seconds so the teacher sees
  real submissions from real students on other devices.
- **Ultra-Lockdown recordings now upload to Google Drive.** See the
  setup section below — this requires a one-time authorization step.

## Setting up Ultra-Lockdown video uploads to Google Drive

Ultra-Lockdown mode records a heavily compressed webcam/mic feed
(roughly 1-2MB per minute — low resolution, low frame rate, mono
audio) and uploads it directly from the student's browser to your
personal Google Drive, authorized through a Netlify Function that
keeps your credentials private. If this isn't set up, students are
instead offered a local download of the recording so nothing is lost.

### 1. Create a Google Cloud project + enable the Drive API
1. Go to [console.cloud.google.com](https://console.cloud.google.com/), create a project (or reuse one).
2. Go to **APIs & Services → Library**, search "Google Drive API", click **Enable**.

### 2. Configure the OAuth consent screen
1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External**, fill in the required fields (app name, your email).
3. Under **Scopes**, you don't need to add anything manually — `drive.file` is requested at authorization time.
4. Add your own Google account under **Test users**.
5. Once saved, click **Publish App** to move it from "Testing" to "In production." (This is important — apps left in "Testing" get refresh tokens that expire after 7 days. Production status, even unverified, does not expire this way. You'll just see an "unverified app" warning when you authorize it yourself in the next step — click **Advanced → Go to [app name] (unsafe)**, which is expected and fine since it's your own app and only you're using it.)

### 3. Create an OAuth Client ID
1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Desktop app**.
3. Save the **Client ID** and **Client Secret** it gives you.

### 4. Get a refresh token (run once, on your own computer)
This repo includes `drive-setup/get-refresh-token.js` — a script that runs
entirely on your machine. It never sends your credentials anywhere
except directly to Google.

```
node drive-setup/get-refresh-token.js
```

Requires Node.js 18+. It will ask for your Client ID/Secret, print a
URL to open in your browser, and after you approve access, print out
three values.

### 5. Set the three values in Netlify
Go to **Site settings → Environment variables** on your Netlify site and add:

| Key | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from step 3 |
| `GOOGLE_CLIENT_SECRET` | from step 3 |
| `GOOGLE_REFRESH_TOKEN` | printed by the script in step 4 |

Redeploy the site (or trigger a redeploy) after adding these. Recordings will then upload into a folder named **"EdAssess Exam Recordings"** in your Drive automatically (created on first use), and a link to each recording appears in the Grade Center next to that student's desk-check/noise-flag review.

If these variables aren't set, Ultra-Lockdown still works — recordings just fall back to a local download for the student instead of uploading.
