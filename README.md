# LearnPool

LearnPool is a role-based learning platform for students, instructors, and administrators. This rebuild uses the MERN stack only: MongoDB, Express, React, and Node.js.

## Included workflows

- Account registration, sign-in, bcrypt password storage, instructor approval, and role-based access
- Course catalogue, enrollment management, modules, lessons, assessments, completion tracking, and course progress
- Class scheduling, meeting links, and recordings
- Assignment publishing, learner submissions by file or link, grading, and feedback
- A private file library with validated uploads and authorized downloads
- Internal messages, in-app notifications, and announcements
- Personal to-dos, progress reports, study-time tracking, learning points, and a leaderboard
- Completion certificates, authorized PDF downloads, public verification, revocation, and audit history
- Admin account access management, enrollment oversight, announcements, audit logs, and system settings

The PDF includes older descriptions and multiple proposed stacks. This rewrite follows the requested MERN stack and carries over the documented product workflows and security rules. It does not use PHP or Firebase.


## Role access

- Students can create an account, optionally link to an approved instructor, browse courses, and enroll.
- Instructors can request an account; an administrator approves it before instructor access is enabled.
- Administrators sign in with the account created by `backend/scripts/createAdmin.js`. Admin accounts cannot be self-registered.
- The sign-in screen lets each person choose the role they are using. The API also verifies the account role.
## Requirements

- Node.js 20 or newer
- MongoDB 6 or newer, local or Atlas

## Run locally

1. Copy `backend/.env.example` to `backend/.env` and set `MONGO_URI` and a unique random `JWT_SECRET` of at least 32 characters. Keep `.env` private.
2. In `backend`, run `npm install`, then `npm run dev`.
3. In a second terminal, in `frontend`, run `npm install`, then `npm run dev`.
4. Open the Vite URL shown in the frontend terminal (usually `http://localhost:5173`).
5. To create the first administrator, set `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` (at least 12 characters) in the backend environment and run `node scripts/createAdmin.js` from `backend`. This is a one-time setup command; the password is stored as a bcrypt hash.

The client expects the API at `http://localhost:5000/api`. For another API host, set `VITE_API_URL` in `frontend/.env` to the API base URL including `/api`. Configure `CLIENT_ORIGIN` and `PUBLIC_APP_URL` for your deployment host. Build the static client with `npm run build` from `frontend`.

## Project layout

- `frontend/` - React single-page application built with Vite
- `backend/` - Express API, Mongoose models, authentication middleware, and local file storage
- `backend/routes/` - resource-specific API routes
- `backend/models/` - MongoDB schemas

## Security notes

- Never put production secrets in source control. The original ZIP included an `.env`; it is omitted from this rebuilt archive. Use your own local values from `.env.example`.
- Roles are checked by API middleware and resource ownership checks. The browser only controls which navigation items are shown.
- Instructor accounts wait for administrator approval. An administrator can approve the account from User management.
- Library and assignment uploads are limited to 20 MB. Lesson uploads are limited to 100 MB. File extensions are validated on the server.
- Library, lesson, and submission files are served through authenticated endpoints.
- Certificate issue and revocation are admin-only. Course certificates require a learner to be enrolled and complete every course lesson. Public verification returns only fields intended for public display.

## Integration notes

Live and recorded classes use instructor-provided meeting and recording URLs; LearnPool does not connect directly to a conferencing vendor. Email delivery is optional and requires SMTP settings. Uploaded files are stored locally under `backend/uploads`; use persistent disk or move the storage adapter to object storage before deploying multiple API instances.
