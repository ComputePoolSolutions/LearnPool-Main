# LearnPool

LearnPool is a role-based learning platform for students, instructors, and administrators. This version uses Express, React, Node.js and **Firebase Firestore** as the database (it was MongoDB before).

## Included workflows

- One common sign-in page for everyone, accounts created by an administrator, bcrypt password storage, first-login password change, profile pictures, and role-based access
- Course catalogue, enrollment management, modules, lessons, assessments, completion tracking, and course progress
- Class scheduling, meeting links, and recordings
- Assignment publishing, learner submissions by file or link, grading, and feedback
- A private file library with validated uploads and authorized downloads
- Internal messages, in-app notifications, and announcements
- Personal to-dos, progress reports, study-time tracking, learning points, and a leaderboard
- Completion certificates, authorized PDF downloads, public verification, revocation, and audit history
- Admin account access management, enrollment oversight, announcements, audit logs, and system settings



## Accounts, roles and sign-in

- Everybody signs in on **one page** with email and password. The role (student, instructor, admin) is read from the database, never from the page or the email, and decides the dashboard: `/student/dashboard`, `/instructor/dashboard` or `/admin/dashboard`.
- **Automatic student accounts:** a valid `@mlrit.ac.in` email that has no account yet is signed in with the email username as the password (`24r21a05fy@mlrit.ac.in` / `24r21a05fy`). LearnPool then creates the Student account, stores only a bcrypt hash and asks for a new password straight away. Existing accounts are never overwritten or duplicated, simultaneous first sign-ins create exactly one account, and other domains are refused (the exact domain is checked on the backend). Set `AUTO_PROVISION_STUDENTS=false` in `backend/.env` to switch this off.
- **Instructors and admins are never created automatically.** An email address alone never grants either role. Admins create accounts and change roles in **Admin > User Management** (Add new user, change Student/Instructor, activate/deactivate, reset password, edit details, delete). Administrators are created with `npm run create-admin`.
- After the first sign-in the backend blocks every other request until the initial password has been changed. The initial password is never regenerated.
- Every user can upload, replace and remove a profile picture in Settings (JPG, PNG or WebP, up to 2 MB).
- Existing accounts keep working and keep their roles.
- `frontend/` is the maintained app. The older `client/` folder is not updated.

> Security note: automatic accounts rely on a predictable password. Anyone who knows a roll number can claim that account first. The forced password change limits the exposure, but if that matters to you, turn the feature off and let administrators create accounts instead.

## Which emails can be students and instructors

Any valid email address can hold a Student or Instructor account. Admins create accounts in **User Management** and choose the role; the initial password is the part of the email before `@`, and the user must change it at first sign-in. An admin can turn any student into an instructor (and back) whatever the email domain.

Optional rules in `backend/.env`:

| Setting | Meaning |
|---|---|
| `ALLOWED_EMAIL_DOMAINS=*` | any email (default). Use `@mlrit.ac.in,@gmail.com` to restrict accounts to those domains |
| `AUTO_PROVISION_STUDENTS=true` | a first sign-in with the email username as the password creates a Student, but only for `AUTO_PROVISION_DOMAINS` (default `@mlrit.ac.in`) |

## Demo login mode

For testing and demos you can let anyone in with **any valid email and any non-empty password**. In `backend/.env`:

```
DEMO_LOGIN_MODE=true
DEMO_ALLOW_INSTRUCTORS=true
```

- An email with no account becomes a **Student**. An existing account signs in with its **real role from the database**, so an admin can promote a demo student to instructor.
- With `DEMO_ALLOW_INSTRUCTORS=true`, instructors can also sign in with any password. **Administrator accounts always need their real password**, so demo mode cannot take over an admin account (`DEMO_ALLOW_PRIVILEGED_ACCOUNTS=true` removes that, not recommended).
- Demo users cannot reach Admin features, and only an admin can change roles.
- It is **always off when `NODE_ENV=production`**. The login page shows a banner while it is on. Restart the backend after changing `.env`.

## Certificates

Certificates are issued only after the course instructor verifies completion.

1. **Student:** finishes every lesson, then opens **Certificates** and clicks **Request certificate**. The status shows as Not eligible, Eligible, Pending verification, Approved or Rejected. A rejected request can be sent again.
2. **Instructor (or admin):** opens **Certificates > Requests**, sees student name, email, course, completion % and completion date, and clicks **Review**. The review window re-checks the learner's real lesson progress, then the instructor approves (with optional remarks) or rejects (a reason is required). Only the course's own instructor or an admin can decide.
3. **Approval** automatically creates certificate **LP-<year>-001**, **LP-<year>-002**, ... and a real **PDF** (A4 landscape, green border, LearnPool logo, student, course, instructor, completion and issue dates, certificate ID, verification link). The student is notified.
4. **Student:** sees it under **My Certificates** (course, ID, issue date, View / Download). It is still there after signing out and in.
5. **Verification:** `/verify-certificate/LP-2026-001` is public and shows validity, ID, student, course, instructor, issue date and status. It shows **Revoked** for revoked certificates and never shows email addresses.
6. **Admin:** **Certificates** shows every request and certificate with search by student, course or certificate ID, status filters, details, full history, and **Revoke** (a reason is required). Revoked certificates can't be downloaded.

Duplicates are prevented: one open request per learner and course, one certificate per learner and course, and two simultaneous approvals issue only one. PDFs are kept in `backend/storage/certificates/` (not publicly served; downloads go through a signed-in check) and are rebuilt from the saved record if a file is missing. The old "admin issues a certificate manually" button is retired so that every certificate goes through instructor approval.

## Editing and updating content

Anything you can create can be edited later, and saves go to the **same record** (the id never changes, nothing is duplicated). The backend checks the user's role and ownership on every update, and records `updatedAt` / `updatedBy`.

| Content | Who can edit | Notes |
|---|---|---|
| Courses (name, description, subject, level, duration, status, cover image) | the course's instructor, admin | Delete archives the course; lessons, submissions and results are kept |
| Modules, lessons (title, link, replacement upload), topics | course instructor, admin | |
| Assessments and questions | course instructor, admin | After learners have attempted it, questions can only be reworded |
| Assignments (title, instructions, due date, points, status, course) | course instructor, admin | Submissions are kept; points are locked once something is graded; assignments with submissions cannot be deleted; learners are told when the due date changes |
| Classes, announcements (admin), files (name, category, description), to-dos | owner / instructor / admin | |
| Report notes (title, summary, period, course) | the author, admin | The progress figures on the Reports page are calculated automatically and stay read-only; students cannot change instructor reports |
| Student / instructor details (name, email, phone) | admin | Email must stay on `@mlrit.ac.in` |

Forms open pre-filled, warn before you discard unsaved changes, and deletions ask for confirmation.

**Backups:** run `npm run backup` in `backend` to save every collection to `backend/backups/` before big changes. No data migration is needed for this version: new fields are optional.

## Requirements

- Node.js 20 or newer
- A Firebase project with Cloud Firestore enabled (Firebase console > Build > Firestore Database > Create database)

## Run locally

1. Firebase setup: in the Firebase console open Project settings > Service accounts > Generate new private key. Save the file as `backend/serviceAccountKey.json` (it is git-ignored). Hosting providers can use `FIREBASE_SERVICE_ACCOUNT_JSON` instead; see `backend/.env.example`.
2. Copy `backend/.env.example` to `backend/.env` and set a unique random `JWT_SECRET` of at least 32 characters. Keep `.env` private.
3. In `backend`, run `npm install`, then `npm run dev`. You should see `Firestore connected`.
4. In a second terminal, in `frontend`, run `npm install`, then `npm run dev`.
5. Open the Vite URL shown in the frontend terminal (usually `http://localhost:5173`).
6. To create the first administrator, set `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` (at least 12 characters) in the backend environment and run `npm run create-admin` from `backend`. This is a one-time setup command; the password is stored as a bcrypt hash.

The client expects the API at `http://localhost:5000/api`. For another API host, set `VITE_API_URL` in `frontend/.env` to the API base URL including `/api`. Configure `CLIENT_ORIGIN` and `PUBLIC_APP_URL` for your deployment host. Build the static client with `npm run build` from `frontend`.

## Project layout

- `frontend/` - React single-page application built with Vite
- `backend/` - Express API, Firestore data layer and models, authentication middleware, and local file storage
- `backend/routes/` - resource-specific API routes
- `backend/models/` - model definitions (same schemas as before)
- `backend/db/` - the Firestore data layer (see below)
- `firestore.rules` - deny-all client rules (all access goes through the backend)

## Security notes

- Never put production secrets in source control. The original ZIP included an `.env`; it is omitted from this rebuilt archive. Use your own local values from `.env.example`.
- Roles are checked by API middleware and resource ownership checks. The browser only controls which navigation items are shown.
- Instructor accounts wait for administrator approval. An administrator can approve the account from User management.
- Library and assignment uploads are limited to 20 MB. Lesson uploads are limited to 100 MB. File extensions are validated on the server.
- Library, lesson, and submission files are served through authenticated endpoints.
- Certificate issue and revocation are admin-only. Course certificates require a learner to be enrolled and complete every course lesson. Public verification returns only fields intended for public display.

## Integration notes

Live and recorded classes use instructor-provided meeting and recording URLs; LearnPool does not connect directly to a conferencing vendor. Email delivery is optional and requires SMTP settings. Uploaded files are still stored locally under `backend/uploads` (Firebase Storage is not used); use persistent disk or move the storage adapter to object storage before deploying multiple API instances.

## Firestore data layer

`backend/db/` is a small Mongoose-compatible layer on top of `firebase-admin`, so the routes and models read the same as before (`find`, `findOne`, `findById`, `create`, `save`, `populate`, `select`, `sort`, `limit`, `lean`, `updateOne`, ...). Each model is stored in a collection named like the old MongoDB one (`users`, `courses`, `modules`, `lectures`, `livesessions`, `topics`, `tests`, `results`, `progresses`, `discussions`, `lmsitems`).

Things that differ from MongoDB and are worth knowing:

- Firestore has no joins, so `populate()` reads the referenced documents by id and attaches them.
- Only one simple condition of a query is sent to Firestore; the rest of the filter is applied in the backend. This avoids composite indexes and works well for classroom-sized data. For very large collections, add dedicated queries or indexes.
- Unique rules (email, teacher code, live-session room, one progress row per lesson, one active certificate per course) are checked before saving, which is not atomic under heavy simultaneous writes. Counters such as points use atomic increments.
- Regular-expression search runs in the backend (it scans the matching collection).
- IDs are still 24-character hex strings.

Run `npm test` in `backend` for an offline smoke test of the data layer (no Firebase needed). To try everything locally without a cloud project, use the Firestore emulator (`firebase emulators:start --only firestore`, then set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` and `FIREBASE_PROJECT_ID=learnpool-local`).

### Moving existing MongoDB data

If your old database has data worth keeping, run once from `backend`: `npm install --no-save mongodb`, then `MONGO_URI="mongodb://..." npm run migrate:mongo`. MongoDB is only read; references keep working because ids are preserved.
