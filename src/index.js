const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('./db');
const { register, login, destroySession, requireAuth } = require('./auth');
const { chat } = require('./ai');
const { getLog, pendingReminder, stopReminders } = require('./readings');
const { listMedications, medEvents } = require('./meds');
const { listMeals } = require('./meals');
const { listAppointments } = require('./appointments');
const { listUserFiles, userFilePath, deleteUserFile } = require('./filesStore');
const { collectData, buildReportHtml, emailReport, csvOf } = require('./report');
const { mailEnabled } = require('./mailer');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

function setSessionCookie(res, token) {
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: PROD,
    maxAge: 30 * 24 * 3600 * 1000,
  });
}

// --- Auth ---
app.post('/api/register', (req, res) => {
  try {
    const token = register(req.body.email, req.body.password);
    setSessionCookie(res, token);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const token = login(req.body.email, req.body.password);
    setSessionCookie(res, token);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  destroySession(req.cookies.session);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email, mailEnabled: mailEnabled() });
});

// --- Chat ---
app.post('/api/chat', requireAuth, async (req, res) => {
  const text = String(req.body.message || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty message.' });
  if (text.length > 4000) return res.status(400).json({ error: 'Message too long.' });
  try {
    const reply = await chat(req.user.id, text);
    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'The assistant hit an error: ' + err.message });
  }
});

app.get('/api/messages', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT role, content, created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 100'
  ).all(req.user.id).reverse();
  res.json({ messages: rows });
});

// --- Health data (read APIs for the UI) ---
app.get('/api/log', requireAuth, (req, res) => {
  res.json({
    readings: getLog(req.user.id, 1000),
    medications: listMedications(req.user.id, true),
    medEvents: medEvents(req.user.id, 300),
    meals: listMeals(req.user.id, 300),
    pendingReminder: pendingReminder(req.user.id),
  });
});

app.get('/api/appointments', requireAuth, (req, res) => {
  res.json({ appointments: listAppointments(req.user.id, req.query.all === '1') });
});

app.get('/api/chart-data', requireAuth, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
  res.json({ days, ...collectData(req.user.id, days) });
});

// --- Files (AI-created documents) ---
app.get('/api/files', requireAuth, (req, res) => {
  res.json({ files: listUserFiles(req.user.id) });
});

app.get('/api/files/:name', requireAuth, (req, res) => {
  try {
    res.download(userFilePath(req.user.id, req.params.name));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/files/:name', requireAuth, (req, res) => {
  try {
    res.json(deleteUserFile(req.user.id, req.params.name));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Export / doctor report ---
const CSV_SOURCES = {
  readings: (uid) => csvOf(getLog(uid, 100000), ['taken_at', 'glucose_mgdl', 'delta_mgdl', 'insulin_units', 'note']),
  medications: (uid) => csvOf(listMedications(uid, true), ['name', 'dose', 'schedule', 'active', 'started_at', 'stopped_at', 'notes']),
  doses: (uid) => csvOf(medEvents(uid, 100000), ['taken_at', 'name', 'dose', 'note']),
  meals: (uid) => csvOf(listMeals(uid, 100000), ['eaten_at', 'description', 'carbs_g', 'calories', 'note']),
  appointments: (uid) => csvOf(listAppointments(uid, true), ['appt_at', 'title', 'provider', 'location', 'notes']),
};

app.get('/api/export/:kind.csv', requireAuth, (req, res) => {
  const source = CSV_SOURCES[req.params.kind];
  if (!source) return res.status(404).json({ error: 'Unknown export.' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="medbot-${req.params.kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(source(req.user.id));
});

app.get('/report', requireAuth, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
  res.send(buildReportHtml(req.user, collectData(req.user.id, days)));
});

app.post('/api/email-report', requireAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.body.days || '30', 10) || 30, 1), 365);
    let to = req.user.email;
    if (req.body.to) {
      to = String(req.body.to).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Invalid recipient email address.' });
    }
    const result = await emailReport(req.user, days, to);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/stop-reminders', requireAuth, (req, res) => {
  res.json(stopReminders(req.user.id));
});

app.listen(PORT, () => {
  console.log(`MedBot listening on port ${PORT}`);
  if (!process.env.OPENROUTER_API_KEY) console.warn('OPENROUTER_API_KEY not set — chat will not work.');
  scheduler.start();
});
