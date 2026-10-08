# Okasha Dental ERP

The clinic and lab management system for Okasha Dental Clinic, built so it can serve more clinics later. Each record carries a clinic ID.

This is **phase 0, the foundation**: login, roles and permissions, clinic settings, master data, audit log, file storage, notifications and the app shell in Arabic and English. Phases 1 to 4 (patients and appointments, clinical records, billing, lab) plug into it.

## Stack

| Part | Choice |
| --- | --- |
| Database | PostgreSQL 16 |
| API | Django 5.1 + Django REST Framework, JWT sign-in |
| Web app | React 18 + TypeScript (Vite), right-to-left aware |

## Layout

```
backend/
  config/                Django settings and URLs
  erp/core/              users, roles, audit log, files, notifications, clinic (tenant)
  erp/masterdata/        branches, rooms, chairs, working hours, staff, procedure catalog
  erp/<module>/          one folder per later module (patients, appointments, clinical, billing, lab, ...)
frontend/
  src/components/        app shell, sidebar, reusable list/form building blocks
  src/pages/             one page per screen
  src/i18n.tsx           all Arabic and English text
```

Two rules from the development structure document hold here:

1. Every module may use `core` and `masterdata`. Those two never depend on a module.
2. Modules link to each other only through shared records, never by reading each other's tables.

The clinic itself lives in `core` rather than `masterdata`, because it is the tenant every record points to (including users and roles).

## What phase 0 gives you

- **Sign-in and roles.** Six built-in roles (owner, dentist, receptionist, dental assistant, lab technician, accountant) with permissions per module: view, create, edit, delete, approve. The owner edits any role's permissions in the app, adds new roles, and can give one user several roles.
- **Clinic settings.** Profile, tax details, currency (EGP), default language, branches, rooms, chairs and working hours.
- **Master data.** Staff directory with commission rules, and the procedure catalog with code, Arabic and English names, category, default price and duration, and a needs-lab flag. A starter catalog of 41 common procedures can be loaded with prices left at 0 for the clinic to fill in.
- **Audit log.** Every create, change and delete of a clinic record, role or user is logged automatically with who, when, IP, and old and new values. Passwords are never logged.
- **File storage.** Upload X-rays, photos, scans and signed consents and attach them to any record. Files are only served through a permission-checked download, never from a public URL.
- **Notifications.** One service (`erp.core.notifications.notify`) for in-app, WhatsApp and SMS. WhatsApp and SMS log instead of sending until a provider is chosen.
- **Clinic isolation.** Every query is limited to the signed-in user's clinic, and a record can never point at another clinic's data.
- **Backups.** `python manage.py backup_db` writes a compressed `pg_dump` and deletes ones older than `BACKUP_KEEP_DAYS`. The Docker setup runs it daily.

## Run it for development

You need Python 3.12+, Node 20+ and PostgreSQL 16.

```bash
# API
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
createdb okasha_erp
export DJANGO_DEBUG=1
python manage.py migrate
python manage.py setup_clinic --name-en "Okasha Dental Clinic" --name-ar "عيادة عكاشة لطب الأسنان" \
  --owner amin --with-catalog          # asks for the owner's password
python manage.py runserver

# Web app (second terminal)
cd frontend
npm install
npm run dev                            # http://localhost:5173
```

Database settings come from `POSTGRES_*` environment variables (see `.env.example`). The Django admin is at `/admin/` for users created with `createsuperuser`.

## Tests

```bash
cd backend && DJANGO_DEBUG=1 python manage.py test erp
cd frontend && npm run typecheck && npm run build
```

The backend tests walk through the phase 0 finish line: the owner signs in, creates users with roles, sets up the clinic, branch, chairs, hours and procedures in both languages, and finds every change in the audit log. They also check clinic isolation, role limits, file rules and notifications.

## Run it in production

```bash
cp .env.example .env      # fill in real secrets
docker compose up -d --build
docker compose exec backend python manage.py setup_clinic --name-en ... --name-ar ... --owner ... --with-catalog
```

This starts PostgreSQL, the API, the web app on port 8080 and a daily backup job. Put HTTPS in front of port 8080, and copy the backups volume off the server (cloud storage or a second machine). A backup on the same disk does not protect against losing that disk.

## Try it free in GitHub Codespaces (no card needed)

1. On the repository page on GitHub, click **Code > Codespaces > Create codespace on main**.
2. Wait for setup to finish (a few minutes the first time). The terminal then shows the owner's username and password.
3. Open the **Ports** tab and click the globe icon next to port 8000 to open the app.

Personal GitHub accounts include free Codespaces hours each month. The codespace stops after a period of inactivity; reopen it from the same menu and the data is still there. The app's address only works for your GitHub account unless you change the port's visibility.

## Deploy a test server on Render

`render.yaml` sets up one web service (API and web app in one container, from the root `Dockerfile`) and a PostgreSQL database.

1. In Render, choose **New > Blueprint** and pick this repository.
2. Enter a password for `INITIAL_OWNER_PASSWORD` when asked.
3. When the deploy finishes, open the `onrender.com` address and sign in as `amin`.

On first start the container creates the clinic, the six roles, the owner account and the starter procedure catalog. Later deploys leave the data alone.

Limits of the free plans: the app sleeps after a while without visits and takes a little time to wake, the free database is deleted after a set period unless upgraded, and uploaded files are lost on each redeploy. That is fine for trying it out, not for real patient data.

The same `Dockerfile` runs on any host that builds containers (Railway, Fly.io, a VPS). It needs `DATABASE_URL`, `DJANGO_SECRET_KEY` and, for the first start, `INITIAL_OWNER_USERNAME` and `INITIAL_OWNER_PASSWORD`.

## Not done yet

- API error messages are in English only. Screen text is in both languages.
- WhatsApp and SMS need a provider (for example the WhatsApp Business API through a local partner) before messages really go out.
- Files are stored on the server's disk. Moving them to cloud storage is a settings change once a provider is chosen.
- An in-clinic copy that keeps working through internet cuts is not built.
