# Nexora Academy Student Portal API

The API uses the existing MySQL database configured in `.env`. On startup it creates the portal account, assessment question and attempt, and certificate renewal tables, and adds the portal progress and recording columns to the academy schema.

## Run locally

1. Install Node.js LTS.
2. In this folder, run `npm install`.
3. Configure the MySQL connection and a long random `JWT_SECRET` in `.env`.
4. To create accepted student accounts and email temporary passwords, also configure `ADMIN_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `MAIL_FROM` in `.env`.
5. Run `npm run dev`.

The API listens on `http://localhost:5000`; the frontend origin defaults to `http://localhost:5173`.

## Endpoints

- `GET /api/health`
- `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/change-temporary-password`, `POST /api/auth/logout`
- `POST /api/auth/admin/students/:studentId/accept` (requires `x-admin-api-key`; creates a hashed temporary credential and emails it)
- `GET /api/dashboard`, `/api/programme`, `/api/sections/:sectionId`, `/api/assignments`, `/api/results`, `/api/announcements`, `/api/certificates`, `/api/profile`
- `POST /api/sections/:sectionId/content-opened`, `/api/sections/:sectionId/recording-watched`, `/api/sections/:sectionId/assessment`
- `POST /api/announcements/:announcementId/read`, `/api/certificates/:certificateId/renew`

All student routes require a valid session cookie. Assessment questions remain hidden until content is opened and the lecturer has recorded attendance, or the absent student has watched the uploaded recording. Lecturers must record attendance and grade submitted attempts in the academy workflow; students cannot change attendance or self-award marks. A section unlocks when its graded result is at least 80%.
