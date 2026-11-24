# Contributing to EdAssess

Thank you for helping. EdAssess is open source under the MIT License, and fixes, ideas and new features are all welcome.

## How the project is laid out

- `index.html` is the whole front end: markup, styles and scripts in one file.
- `netlify/functions/data.js` is the whole back end: one serverless function that stores data in Netlify Blobs.
- `sw.js` is the service worker for push notifications. It must sit next to `index.html`.
- `docs/` holds the screenshots used in the README.
- `tests/` holds the test scripts. Run them with `node tests/run-all.js`.

## Running it locally

1. Install dependencies with `npm install`.
2. Run `netlify dev` from the project folder (the Netlify CLI is the easiest way to get the function and Blobs working together).
3. Set `EA_AUTH_SECRET` and `EA_TEACHER_KEYWORD` in a local `.env` file.

## Sending a change

1. Fork the repository and make a branch.
2. Keep changes focused, and describe what you changed and why in the pull request.
3. Add a line to `CHANGELOG.md` under Unreleased.
4. Check your change in light and night themes and at phone width. Nothing should overlap or run off the screen.

## House rules for the interface

- Light mode is the default and accent blue is the main color.
- Text must stay readable in both themes.
- Clicking an answer choice must never re-render the whole page.
- Interface text is formal and plain. Avoid em dashes.
- Please do not collect more student data than the app needs.

## Reporting problems

Open an issue with what you did, what you expected and what happened. For anything involving student privacy or security, please say so in the title and avoid posting real student names.
