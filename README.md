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

---

## Multi-section tests, adaptive routing, custom grading, save & continue later

Open any test in the builder → **Sections & Grading**. (Or tick *Multiple sections* when creating a test.)
Turning sections on puts your existing questions in "Section 1" — nothing is renumbered, and existing submissions keep working.

### Sections tab
Each section has its own **directions** (Markdown), **time limit**, **navigation** (free, or forward-only), **calculator** (inherit / always / never), **reference sheet** on/off, **shuffle** overrides, an optional timed **break** afterwards, and a **branch-only** flag (a module that is skipped unless routing sends a student there). Questions live in a section; use the picker in the question editor to move one (this never changes answer keys).

### Adaptive routing tab
After a student finishes a section, its rules are checked top-to-bottom; the first match decides the next section, otherwise "otherwise" is used. A rule reads *this section*, *overall so far*, or any earlier section's **% correct / points / questions correct**, and sends the student to a section, the next section, or the end. The tab includes a flow map, validation, and a **path simulator** (drag a score, see where a student lands).
- Routing scores count **auto-graded** questions only (MC, multi-select, short answer) — essays can't be graded in time.
- A student never takes a section twice; a route back to a taken section ends the test. Finished sections are locked so routing can't be gamed.

### Grading tab
- **Total points** (sum of sections taken) or **Weighted by section** (each section's % × its weight, normalized over the sections the student actually took, reported out of a total you choose).
- Per-section: counts toward grade (off = practice/ungraded), weight, **credit range** (e.g. easy module 0–70%, hard module 40–100%), **minimum % to pass**.
- Passing score, letter-grade scale, scaled score (e.g. 200–800), what students see, and a **what-if calculator** that uses the same math as real grading.
- Saving offers to **re-score existing submissions**; manual essay grades are never overwritten.
- Sections a student was never routed to are excluded everywhere (grader, results, analytics, skill stats). If a test ends early (force-submit, violations) unreached *core* sections count as zero (switchable).

### Save & resume tab
Students get a **Save & continue later** button (between sections only, or any time). The timer can **pause** or **keep running** while they're away. Saved state includes every answer, the exact section/question, flags, highlights and notes, and works on **any device** with the same link + name. "Saved" is only shown after the server confirms it by reading the data back; if the connection fails the student is told and stays in the exam. Students also see a live *Progress saved / Saving… / Not saved — retrying* indicator. If a timed section expires while a student is away, it is auto-submitted (with routing) when they return.

### Assigning
The assign dialog adds per-section **time overrides**, a **time multiplier** (extended-time accommodations — make a separate link), and a switch to disable save-&-continue for that assignment. In the Live Monitor, open a student's **···** menu to add 5/10/15 minutes or end their current section.

### ⚠️ Deploying
1. Replace **both** `index.html` **and** `netlify/functions/data.js`. The only server change is additive (a new `instructorOp` action, and `upsertSubmission` keeps server-owned `instructorOps`). If you've customised `data.js`, merge just those two blocks. Everything else — including Save & continue — works without it; only the Live Monitor's +time / end-section buttons need it.
2. No new dependencies, nothing changes in `package.json`.

### Also fixed along the way
- **Shuffle questions scored wrong.** Answers were keyed by shuffled position but graded by original position, so a perfect paper could score ~1/12. Order is now stored separately and keys are always canonical.
- **Hot retry loop when offline.** A failed background save re-called itself with no delay; it now waits for the existing 8-second timer.
- Unsaved-work warning on tab close now also covers student submissions; the exam-flag button now persists.

### Tests
`cd tests && npm install && npm test` — ~260 browser-free checks (jsdom) that run the real `index.html` against the real `data.js` on an in-memory store, including resume-on-another-device, offline saves, timeouts, adaptive paths, grading math, and a snapshot proving non-sectioned tests score exactly as before. (They don't check visual layout.)
