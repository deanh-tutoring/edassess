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
