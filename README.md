# 🩺 MedBot

An AI health-tracking assistant. Chat in plain English and it keeps an organized,
exportable health log:

- **Blood sugar & insulin** — log a reading, get a reminder email **2 hours later** to
  re-check, and see how much it changed. Repeats as long as you keep logging.
- **Medications** — keep your medication list and record every dose you take.
- **Food** — log meals with optional carbs and calories.
- **Doctor's appointments** — tracked with a reminder email the day before.
- **Charts** — blood sugar over time (with 70–180 target band), insulin, daily carbs,
  and daily medication doses, over 7/30/90 days.
- **Doctor report** — a printable report (print → save as PDF) plus CSV exports, sent
  by email to yourself or straight to your doctor.
- **Documents** — ask the assistant to create files (question lists, summaries, notes);
  they appear in the Files tab for download.

Multi-user: each account has its own log, chat history, files, reminders, and AI
memory. **The account matching `ADMIN_EMAIL` is the administrator** and gets an Admin
tab to set the OpenRouter API key, the model, and the assistant's persona for the
whole site — friends and family just sign up and chat.

## AI memory

The assistant remembers across three layers, per user:

- **Short-term** — the recent conversation window sent with every message.
- **Long-term** — lasting facts it saves as it learns them (allergies, doctors,
  preferences, goals) and can update or delete when corrected.
- **Episodic** — when older messages age out of the short-term window, the AI
  automatically summarizes them into dated episode memories it can search later
  ("what did we talk about last month?").

> **MedBot is a logging tool, not a medical device, and gives no medical advice.**
> It will never recommend or adjust doses of insulin or any medication.

## How the AI works

Chat goes to an LLM via [OpenRouter](https://openrouter.ai) with a set of server-side
tools (`log_reading`, `log_med_taken`, `add_appointment`, `create_document`, …). The
model extracts structured data from natural language and calls the tools; the server
validates everything, stores it in SQLite, and schedules reminder emails. Documents the
AI creates are written to a per-user folder on the server (never to anyone's computer)
and served from the Files tab.

## Run locally

```bash
npm install
copy .env.example .env   # then fill in OPENROUTER_API_KEY and SMTP settings
npm start                # http://localhost:3000
```

Without SMTP settings the app still works for logging, charts, and chat; reminder
emails and emailed reports are disabled (the UI warns you).

## Deploy on Railway

1. Push this folder to a GitHub repo and create a new Railway project from it
   (or use `railway up` with the [Railway CLI](https://docs.railway.com/guides/cli)).
2. **Attach a volume** to the service (e.g. mount path `/data`) and set the variable
   `DATA_DIR=/data` — otherwise the database and files are wiped on every deploy.
3. Set the environment variables from `.env.example`:
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (for emails)
   - `APP_URL` — your public Railway URL (used for links inside emails)
   - `TIMEZONE` — the user's IANA timezone, e.g. `America/Chicago` (Railway runs in UTC)
   - `ADMIN_EMAIL` — the administrator's email (defaults to the project owner's)
   - Optionally `FOLLOWUP_MINUTES`, or `OPENROUTER_API_KEY`/`OPENROUTER_MODEL` as
     fallbacks for the Admin-tab settings
4. Generate a public domain for the service (Settings → Networking). Railway sets
   `PORT` automatically.
5. Register with the `ADMIN_EMAIL` address, open the Admin tab, paste your OpenRouter
   key, pick a model, and set the persona. Everyone else just registers and chats.

## Stack

- **Node.js + Express** — server and API
- **better-sqlite3** — storage (users, readings, meds, meals, appointments, reminders, chat)
- **OpenRouter** — LLM with tool calling
- **nodemailer** — SMTP email (reminders, reports)
- Vanilla HTML/JS frontend with hand-rolled SVG charts, no build step

## Safety design

- The system prompt forbids dosing advice and diagnosis, and tells the model to flag
  dangerous readings (<70 or >300 mg/dL) with "contact your care team" guidance.
- Server-side validation rejects implausible values regardless of what the model sends.
- The AI's file tool is sandboxed to a per-user directory with a filename allowlist
  (.txt, .md, .csv, .html, .json) and size limits.
- The AI has no email-sending tool; only the human-facing UI can email reports.
- Disclaimers appear on the sign-in page, in the app footer, in reports, and in emails.
