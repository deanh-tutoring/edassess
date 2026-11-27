# Changelog

All notable changes to EdAssess are listed here, newest first. Add new entries under Unreleased.

## Unreleased

## 2.3.1 (2026-11-27)

### Changed
- The Collaboration tab shows who created each file by name instead of by username, even when the class owner now owns the copy. For a file a co-teacher added, the name comes from Drive's display name for the original owner. Only that name is requested, never an email address. Notes also show names.

## 2.3.0 (2026-11-27)

### Changed
- Collaboration no longer needs anyone to be signed in. Once the class owner has connected Google one time, the server does the Drive work with that stored grant: a scheduled function (`collab-sweep`, every minute) and a `collabAdopt` call (every 10 seconds while a teacher has the Collaboration tab open).
- The ownership swap from 2.2.0 now runs on the server instead of in the owner's browser. Co-teacher files and folders are copied into the owner's Drive and the originals are deleted (or taken out of the folder when Drive does not allow a delete).
- Blank Doc, Slides and Sheet are created in the class owner's Drive in the teacher folder, whoever clicks the button.
- Posting something to classwork moves its files to the student folder automatically, right away for live posts and at publish time for scheduled ones. A file the owner does not own gets an owner copy in the student folder, and the material links to that copy.
- Pick from Drive copies files the picker does not own into the teacher folder so the owner's copy replaces them.

### Added
- An Upload file button next to Create. The file goes straight to the owner's teacher folder in Drive, up to 200 MB, started by the server and sent directly to Google.
- `@netlify/functions` is a new dependency so the sweep can be scheduled. Netlify installs it on deploy.

### Notes
- The class owner still approves Google once. After that nothing else needs a sign-in. No email addresses are read or stored, and only the ownedByMe flag is requested from Drive.

## 2.2.0 (2026-11-27)

### Added
- Co-teachers without an EdAssess account. On the Files or Collaboration tab the class owner creates a co-teacher link (an edit-by-link teacher folder) and shares it however they like. No email address or account is needed.
- Automatic ownership. While the owner has EdAssess open and signed in to Google, every 10 seconds the owner's session looks in the teacher folder for files someone else owns, makes its own copy, and removes the original (it deletes it when Drive allows, and otherwise takes it out of the folder). Folders are copied with their contents. The owner is the only name on files in the class folder.

### Privacy
- The sync asks Drive only whether the owner owns a file (`ownedByMe`). It never requests or stores owner, editor or email details of anyone. The only email EdAssess may touch is the owner's own Google sign-in, which is discarded after sign-in.

### Notes
- This runs from the owner's open session, so a co-teacher's file stays theirs until the owner next has EdAssess open. A co-teacher who is signed in to Google appears under their own Google account in Drive until the swap happens.

## 2.1.1 (2026-11-26)

### Fixed
- A block of code text appeared at the bottom of every page and slowed the site down. The tour script had been inserted into the middle of the print code by mistake. The build now inserts it in its own place, so the page is clean and fast again.

## 2.1.0 (2026-11-26)

### Added
- A guided tour for teachers. It starts once for every teacher, new and existing, and can be replayed from Search (Ctrl K), Take the tour. Students never see it. The tour creates a practice class named Tour Class (practice) with sample students, a material, an announcement and a sample test (Tour Quiz: Photosynthesis) so every step has something real to point at.
- The tour covers the navigation, Search, the dashboard, building questions, math, every assignment setting including Secure Mode, strikes and Ultra Lockdown, an illustration of what students see when locked, a full preview inside a test, the live monitor, grading, peer review, analytics, classes, classwork and topics, People, Student view, Collaboration and Files, joining a class as a student, and backup.
- Two small server actions, `tourState` and `tourSet`, remember each teacher's progress. Raise `TV` in `tour.js` to show the tour to everyone again after a major change.

### Fixed
- The page no longer asks you to refresh repeatedly. It asks once per update per tab and never during a tour or an exam.
- Insert math, Message instructor and the time zone picker were dark on dark in some themes. They are readable in light and dark.
- Speed: background checks run less often, and the class list only redraws when something actually changed, so typing is never interrupted.

## 2.0.0 (2026-11-26)

### Changed
- A complete visual refresh in the spirit of Pear Assessment: a white sidebar with a green active state, a bright page with clean white cards, Pear-style green buttons, crisper type and calmer tables, in light and dark mode.
- Update notices are gone. The What's new pop-up no longer opens on its own and lives under Search (Ctrl K), What's new.
- When a new version is deployed, EdAssess asks every open page to refresh. The check reads a tiny `version.json` file, so keep it and the BUILD constant in `shell.js` in step when you release.

### Fixed
- The Collaboration and Files tab was dark on dark and light on light because a new banner style reused its class name. The banner has its own classes now.

## 1.9.0 (2026-11-26)

### Changed
- Class pages follow the familiar classroom layout. The Stream opens with a full-width banner in the class color that carries the class code (teachers) or the teachers' names (students), a collapsed New announcement button that expands into the composer, and stream rows with round icons for announcements, materials and assignments.
- Classwork has a Topic filter dropdown, large collapsible topic headings, Collapse all and Add topic, and thin-ruled rows with the posted date on the right. The old side list of topics is gone.
- Your classes are listed under Classes in the left sidebar as colored initials, with the open class highlighted.

## 1.8.1 (2026-11-26)

### Changed
- The Dashboard opens with a greeting and a row of your classes, each showing what is waiting for review. The stat cards use one consistent color scheme.
- The class People tab is a clean list with initials avatars in the class color, a completion bar, the average and clear actions, and it adapts to phone width.

## 1.8.0 (2026-11-26)

### Added
- Class identity colors. Every class keeps one color across its card, header, tabs and topic headings.
- Class cards show submissions waiting for review and the next due date.
- Search (Ctrl K) now finds students and assignments, matches loosely so small typos still work, and has a Search button in the sidebar.

## 1.7.0 (2026-11-25)

### Added
- Student view, in place. The class page has a Teacher and Student switch, like Google Classroom. Student shows the Stream and Classwork exactly as students see them, in the same tab, with no separate student mode. Pick a student in Viewing as to check what they can see, including items limited to groups. Taking work as a student is still one click away.

- Teachers who are students in someone else's class no longer need Student mode. Classes has a Teaching and My student classes switch, and the second one shows invites, classes, classwork and grades right inside the normal teacher interface. The Student mode button in the sidebar is gone.

### Fixed
- Topic names that are limited to certain students are no longer listed for students who cannot see them.

## 1.6.1 (2026-11-25)

### Changed
- Instant moves are on by default. The class owner can turn them off with Deny instant moves on the Collaboration tab, and co-teacher moves then wait for the owner again.
- Google sign-in is remembered. After the first sign-in EdAssess keeps an encrypted long-term grant on the server, so opening the Collaboration tab no longer asks you to sign in again. This needs GOOGLE_CLIENT_SECRET; without it the old popup still works.

## 1.6.0 (2026-11-25)

### Added
- Share with part of a class. Any topic, material or assignment can be limited to groups you create or to students you pick by hand, from Who can see this. Groups are managed in one place and reused. Students only ever receive what they are allowed to see, and a restricted assignment cannot be opened by guessing its link. Rows show a small tag naming the audience.
- A What's new pop-up inside EdAssess that appears once per release.
- A GitHub link in the site footer next to Terms and Privacy.

### Changed
- A calmer classroom. The class page now has consistent side spacing, smaller and quieter icons, lighter topic headings, tidier rows and fewer competing colors, on desktop and phone.

### Fixed
- Moving an assignment to a topic saves in a single step on the server and the list removes duplicate entries, so an assignment never shows up twice.

### Changed
- Solo teachers see a **Files** tab instead of Collaboration. Their class has one Drive folder that anyone with the link can view, and posting a material simply makes its file available. Files are listed as Published to students and Not published yet. The tab becomes Collaboration, with separate teacher and student folders and lists, as soon as a co-teacher is added.
- Posting a material moves its files into the student folder. A scheduled material moves at the time it goes live, and until a file is in place students see the material without the link.
- Smoother Collaboration tab: gentle entrance animation, notes that slide open, a highlight on files that just moved, spinners on busy buttons, and clearer button labels (Move to student folder, Make teachers only, Post to classwork, Remove from list).

### Added
- Instant moves. The class owner approves once with Allow instant moves, and from then on a co-teacher's Move places the file in the student folder immediately, with no waiting on the owner. EdAssess keeps an encrypted long-term Google token for this, never an email address. The owner can turn it off at any time, which also revokes the token. Without it, co-teacher moves still queue until the owner's tab syncs.

### Changed
- The Collaboration list now mirrors the Drive folders exactly. Every sync compares the two folders with the list and removes files that were deleted, renames files that were renamed and notices files that moved. It checks every 15 seconds while the tab is open and again whenever you return to the window.
- Only the class owner can place files in the student folder, so the owner holds ownership of everything students see. When the owner presses Move, a file they do not own is copied into the student folder so the owner owns the copy. When a co-teacher presses Move, the request is queued and the owner's session completes it automatically, and the file shows Waiting for owner until then.

### Fixed
- Moving a file between the teacher and student folders no longer fails with "Increasing the number of parents is not allowed". If Google still refuses because another teacher owns the file, a copy is placed in the destination folder instead.

### Fixed
- Deleting the Drive folders no longer breaks Collaboration. The tab now syncs on its own every time it opens and once a minute while it stays open, with no button to press. It rebuilds missing or trashed class folders, replaces stale shortcuts, drops list entries for deleted files and re-syncs everything.

### Changed
- Class folders no longer share with anyone by name or email. Each class has a teacher folder (anyone with the link can edit) and a student folder (anyone with the link can view), shown as shortcuts under EdAssess, then the class name, for every teacher. Google sign-in no longer asks for the account email, and any email saved earlier is deleted.

### Added
- Move files between the teacher folder and the student folder, and pause or restore student access while editing.
- Students see a link to the class files folder in Classwork while access is on.

### Added
- Every material shows who posted it, for teachers and students.

### Fixed
- After an administrator resets a password, the new password screen no longer asks for the temporary password again. You are already signed in with it, so you just choose a new one.

## 1.5.0 (2026-11-23)

### Added
- Drafts and scheduled posting for materials and assignments. Students never see a draft, and a draft assignment's link will not open.
- Collaboration tab in every class, for teachers only: a shared list of the class folder's files, a Create menu for blank Docs, Slides and Sheets, notes on each file, and Push to classwork (live, draft or scheduled).
- Google sign-in for teachers. It creates the EdAssess folder and a folder per class, shares each with co-teachers, adds each co-teacher's shortcut automatically, and syncs existing materials and folder contents.
- Share tests with every co-teacher of a class in one step.
- Permanent six digit student IDs shown on the student home screen, and four digit class IDs shown on class pages.
- Pre-printed or blank class name, class ID, student name and student ID on answer sheets. Versions are always bubbled by the student.
- Timing rectangles beside every column of answer bubbles so scans stay accurate on curved or tilted photos.
- Scans match the right student by ID and fill in the score automatically.

### Fixed
- QR codes and share links built from an odd page address now always point to the site root, and any path serves the app.
- Menu button overlapping the class header on phones, and tabs and buttons running off narrow screens.

## 1.4.0

### Added
- Print Center: paper tests with up to four shuffled versions, answer keys, bubble sheets, student and class results, class summary, gradebook, roster and attendance sheets, rubrics and survey results.
- Sections with STOP pages that always land on odd pages, special instructions and images in print.
- Photo scanning of bubble sheets by teachers, with faint and double marks flagged for review.
- Fully customizable answer sheets saved with each test.
- Students can turn in a paper sheet by photo without opening the test, through a turn-in QR code, a phone friendly scan page, or an assignment code. Nothing is shown to them until every answer is confirmed.

## 1.3.0

### Added
- Classwork in the style of Google Classroom with topics, drag-to-order materials and push notifications for new posts.
- Peer review for students who did not take the test, teacher-written sample responses and one review screen shared by teachers and students.
- Extensive rubrics: scored criteria, checklists, deductions, bonuses, more than twenty templates and a personal library.
- Full-page forms, exact-location routing, a grader workspace and a command palette.
- A bolder look using Inter, with no grey panels.

## 1.2.0

### Added
- New question types: ranking, matching, fill in the blanks, number, rating, grid and an availability calendar with time zones.
- Survey analytics for the new question types.
- Surveys: a question set with no scores, keys or lockdown.
- Terms of Service with age rules and a parent permission step for students 12 and under.

## 1.1.0

### Added
- Student view and student mode, so teachers can preview a class or use the app as a student.
- Google Drive attachments and embeds in class materials.
- Teachers can join another teacher's class as a student.
- A longer, plainer privacy policy.

## 1.0.0

### Added
- Tests, assignments and join codes, the live monitor, grading, the Grade Center and analytics.
- Classes with streams, materials, rosters and class codes.
- Student accounts, a focused exam room, tools such as the line reader and notepad, autosave and offline recovery.
- Backup and history.
