# Okasha Dental ERP

The clinic and lab management system for Okasha Dental Clinic, built so it can serve more clinics later. Each record carries a clinic ID.

Built so far: **phase 0, the foundation** (login, roles and permissions, clinic settings, master data, audit log, file storage, notifications and the app shell in Arabic and English) and **phase 1, patients and appointments**. Phases 2 to 4 (clinical records, billing, lab) plug into the same foundation.

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

## Design

The look follows the approved Okasha design in `docs/design/` (colours, fonts, logo, background pattern, and the patient card layout). The dental chart, treatment plan, billing and lab sections of that design are built in phases 2 to 4.

## What phase 1 gives you

- **Patient file.** Automatic file numbers (P-00001, ...), names in Arabic and English, mobile, WhatsApp consent, the language messages go out in, national ID, how they heard of the clinic, preferred dentist and branch. Search finds patients by name, phone or file number, and matches Arabic spelling variants (أ/ا, ة/ه, ى/ي), Arabic digits and phones with or without +20. Closing a file hides it but never erases it.
- **Medical alerts and history.** Short alerts (for example a penicillin allergy) show in red on the patient file, the calendar and the booking form for every role. The full medical questionnaire is only visible to roles with clinical access.
- **Setup check.** Until the clinic has a branch, chairs, working hours and a dentist, the calendar lists what is missing, with a one-click starting setup.
- **Calendar by chair.** A day view per branch with one column per chair, a dentist filter (a dentist sees their own visits first), and click-a-slot booking. The server refuses a booking that overlaps on the same chair or with the same dentist, and asks for confirmation outside the branch's working hours.
- **Visit flow and waiting room.** Booked, confirmed, arrived, in chair, completed, plus cancelled (with a reason) and no-show. Each step records its time, and the waiting room panel lists who is waiting and who is in the chair.
- **Reminders.** `python manage.py send_reminders` (run daily; the Docker setup does) sends tomorrow's reminders over WhatsApp in each patient's language, once per visit, skipping patients who opted out. Reception can also send them from the calendar.

## What phase 2 gives you

- **Dental chart.** FDI chart of the permanent teeth, drawn as in the design handoff. Each tooth records missing, crown, implant and root canal, plus caries, filling or root canal access per surface (M, D, O, B, L). Teeth with planned work get an amber dot, and the record panel shows the tooth's status, note and what is planned.
- **Treatment plans.** Lines come from the procedure catalog with tooth, surfaces, price (defaults to the catalog price) and discount. A plan moves from proposed to agreed, in progress and completed as its lines are done. Each line can be booked straight into the calendar and remembers its appointment. Totals show done, planned and plan total in EGP.
- **Visit notes.** Complaint, findings, work done and next step, linked to the visit. Ticking procedures in a note marks those plan lines done. A dentist signs the note, and a signed note can no longer be changed or deleted.
- **Prescriptions.** Medicines with dose, frequency and duration, with common dental drugs suggested, printed on the clinic letterhead.
- **Consent forms.** Four starter forms in Arabic and English (general treatment, extraction, root canal, implant) that the owner can edit on the Clinical records page. The patient or a guardian signs on screen with a finger or stylus, and the signed copy keeps its own text and can be printed.
- **X-rays and images.** X-rays, photos and scans upload into a gallery on the patient file, with a viewer that zooms and adjusts brightness, contrast and invert.
- **Clinical records page.** Visit notes waiting for signature and treatment plans in progress across the clinic.
- Reception never sees the chart, plans, notes, prescriptions or consents. Assistants can read them but not change or sign them.

## What phase 3 gives you

- **Invoices from the treatment plan.** A new invoice lists the patient's plan lines not yet billed, with finished work already ticked, plus any extra items (an X-ray, materials). Numbers run INV-00001, ... per clinic. A line can only be billed once, and an invoice can be voided with a reason only while nothing is paid on it.
- **Payments and receipts.** Cash, InstaPay, card, mobile wallet or bank transfer, against an invoice, one of its installments, or on account. Each payment gets a receipt number (RC-00001, ...) and prints on the clinic letterhead. A payment can't be more than what is still owed, and voiding one needs a reason.
- **Installments.** Split an invoice's balance into monthly installments. The Installments tab lists what is due in the next two weeks and what is overdue, with the patient's phone.
- **Daily cashbox.** Today's totals by payment method and every receipt. Closing the day records the cash counted in the drawer and the difference, and after that no payment can be added or voided for that day.
- **Doctor commissions.** For a date range, what each dentist billed and collected and their commission under the rule set on their staff record (a percentage of collected, a percentage of billed, or a fixed amount per procedure). Payments are shared across an invoice's lines in proportion to their value. Owner and accountant only.
- **Patient balance.** The patient file shows the balance due at the top and a billing section with billed, paid and owed, a paid bar, invoices and payments.
- Reception can invoice, take payments and close the day. Dentists don't see billing. Only the owner and accountant can void.

## What phase 4 gives you

- **Lab orders from the treatment plan.** A dentist orders lab work from a plan line on the patient file. Lab procedures (zirconia crown, bridge, veneer, denture and so on) are listed first, and the restoration and material are filled in from the procedure. The order carries shade, units, teeth for a bridge, instructions, a due date and the try-in visit (with a warning when the work would be due after it). Numbers run LAB-00001, ... per clinic, and one plan line has one open case at a time.
- **Lab board.** Open cases in columns by stage: scan received, CAD design, milling, sintering and glaze, ready for try-in. Technicians move a case with one tap or by dragging it, filter to their own, unassigned or late cases, and every move records who and when, with an optional note. When a case is ready, the ordering dentist gets an in-app message and a count on the sidebar.
- **Technician assignment.** Assign or reassign a technician on the case or when ordering.
- **Design files.** Intraoral scans, STL designs, photos and PDFs attach to the case.
- **Remakes.** Finished work can be remade with a reason (fit, shade, fracture, design, patient request) and who carries the cost. The remake keeps a link to the first piece, and a first piece remade before delivery is counted as scrap.
- **Cost per unit.** Material and labour cost per case. The owner's cost report shows, for a period, cost per unit by restoration and material, remakes, scrap, the remake rate and how much work was ready on time.
- **Work ticket.** A printed ticket with the case details for the lab bench.
- **Patient file.** The lab orders card from the design: open work with its stage list, and finished work with its delivery date.
- Lab technicians see the patient's name and file number only, never phone numbers or the rest of the patient file. Reception does not see the lab.

## Home page and sidebar

- **Widget home.** Today's date with visits seen, money collected today and patients waiting; a live clock in the middle; quick buttons for the most used screens (only the ones the user is allowed to open); today's visits laid out chair by chair with a line for the current time; who is in the chair now and how long is left; this week's takings drawn as teeth with today highlighted; patients due for a check-up (no completed visit in six months and nothing booked) with a WhatsApp button that opens a ready message in the patient's language; a lab summary for lab users. The setup checklist only appears while something is still missing.
- **Sidebar.** On a computer it stays as a slim icon rail and opens over the page when the mouse rests on it. On a phone it is still the menu button. Scrollbars are hidden in the sidebar and on the patient file's section menu.
- **Logo.** The tooth logo in the sidebar and on the sign-in screen jumps and spins once every four seconds (off for people who turn motion down in their system settings).
## Look and feel

- **Light and dark mode.** The sun and moon button in the top bar (and on the sign-in screen) switches theme. The choice is remembered on that device; until someone picks, it follows the device setting.
- **Sidebar.** A greeting with today's date, work and setup groups, live counts (patients waiting, notes to sign), and gentle animations. It folds into an icon rail on desktop and becomes a slide-out menu on phones.

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

The backend tests walk through the finish line of each phase. For phase 1: reception registers a patient with an alert, books them, clashes and closed hours are refused, the visit goes through the waiting room, and reminders go out in the right language. For phase 0: the owner signs in, creates users with roles, sets up the clinic, branch, chairs, hours and procedures in both languages, and finds every change in the audit log. They also check clinic isolation, role limits, file rules and notifications.

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
3. The app runs in the terminal that opens with the codespace; keep it open. Open the **Ports** tab and click the globe icon next to port 8000. If the page says it is not working (502), the app is not running: run `bash .devcontainer/start.sh` in a terminal and keep it open.

To get new code into a codespace you already have, run `git pull` (or `git checkout <branch>` to try a branch) and then `bash .devcontainer/update.sh` in a terminal. It rebuilds everything and restarts the app in that terminal; keep it open.

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

- The lab takes the clinic's own cases only. Outside dentists as lab clients, with their own invoicing, are not built (an open question in the development structure document).
- Billing has no tax receipts for the Egyptian Tax Authority e-receipt system yet, and no refunds beyond voiding a payment.
- API error messages are in English only. Screen text is in both languages.
- The calendar shows one day at a time. A week view, online booking and recurring visits are not built.
- WhatsApp and SMS need a provider (for example the WhatsApp Business API through a local partner) before messages really go out.
- Files are stored on the server's disk. Moving them to cloud storage is a settings change once a provider is chosen.
- An in-clinic copy that keeps working through internet cuts is not built.
