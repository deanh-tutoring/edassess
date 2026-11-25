# Changelog

All notable changes to EdAssess are listed here, newest first. Add new entries under Unreleased.

## Unreleased

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
