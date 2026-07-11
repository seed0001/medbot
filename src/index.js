const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('./db');
const { register, login, destroySession, requireAuth, changePassword, adminSetPassword } = require('./auth');
const { chat, clearChat } = require('./ai');
const { saveMemory, deleteAnyMemory, listMemories } = require('./memory');
const { getLog, pendingReminder, stopReminders } = require('./readings');
const { listMedications, medEvents } = require('./meds');
const { listMeals } = require('./meals');
const { listAppointments } = require('./appointments');
const { listUserFiles, userFilePath, deleteUserFile } = require('./filesStore');
const { collectData, buildReportHtml, emailReport, csvOf } = require('./report');
const { publicAppSettings, saveAppSettings, resolveApiConfig, resolveTtsConfig } = require('./settings');
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
  res.json({
    email: req.user.email,
    isAdmin: Boolean(req.user.is_admin),
    mailEnabled: mailEnabled(),
    chatReady: Boolean(resolveApiConfig().key),
    ttsReady: Boolean(resolveTtsConfig().key),
  });
});

app.post('/api/change-password', requireAuth, (req, res) => {
  try {
    res.json(changePassword(req.user.id, req.body.current_password, req.body.new_password, req.cookies.session));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Admin (site-wide settings + user overview) ---
function requireAdmin(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Administrator only.' });
  next();
}

app.get('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  res.json(publicAppSettings());
});

app.post('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(saveAppSettings(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/users/:id/password', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(adminSetPassword(Number(req.params.id), req.body.password));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.is_admin, u.created_at,
      (SELECT COUNT(*) FROM readings r WHERE r.user_id = u.id) AS readings,
      (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS messages
    FROM users u ORDER BY u.id
  `).all();
  res.json({ users });
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

// Markdown and emoji make the voice narrate junk ("asterisk asterisk...") —
// reduce a reply to plain speakable text before it goes to the TTS service.
function speechText(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ') // code blocks
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → just their text
    .replace(/^#{1,6}\s+/gm, '') // heading marks
    .replace(/^\s*[-*•>]\s+/gm, '') // bullet/quote marks
    .replace(/[*_~#|]+/g, ' ') // bold/italic/strikethrough/table leftovers
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, ' ') // emoji, arrows & symbols
    .replace(/(^|\s)[-—=]{2,}(?=\s|$)/g, ' ') // table dividers / horizontal rules
    .replace(/\s+/g, ' ')
    .trim();
}

// Speak a chat reply aloud via Fish Audio TTS. Returns MP3 bytes.
app.post('/api/tts', requireAuth, async (req, res) => {
  const { key, model, voice } = resolveTtsConfig();
  if (!key) return res.status(400).json({ error: 'Voice is not set up yet — the administrator can add a Fish Audio key in the Admin tab.' });
  const text = speechText(req.body.text || '').slice(0, 3000);
  if (!text) return res.status(400).json({ error: 'Nothing to speak.' });
  try {
    const upstream = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        model,
      },
      body: JSON.stringify({ text, format: 'mp3', ...(voice ? { reference_id: voice } : {}) }),
    });
    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 300);
      console.error(`Fish Audio TTS error ${upstream.status}:`, detail);
      return res.status(502).json({ error: `Voice service error (${upstream.status}). Check the Fish Audio key in the Admin tab.` });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    const audio = Buffer.from(await upstream.arrayBuffer());
    res.send(audio);
  } catch (err) {
    console.error('TTS failed:', err);
    res.status(502).json({ error: 'Could not reach the voice service.' });
  }
});

app.get('/api/messages', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT role, content, created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 100'
  ).all(req.user.id).reverse();
  res.json({ messages: rows });
});

app.post('/api/clear-chat', requireAuth, async (req, res) => {
  try {
    res.json(await clearChat(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Memory (view + manage what the assistant remembers) ---
app.get('/api/memories', requireAuth, (req, res) => {
  res.json({
    long_term: listMemories(req.user.id, 'long_term', 200),
    episodic: listMemories(req.user.id, 'episodic', 200),
  });
});

app.post('/api/memories', requireAuth, (req, res) => {
  try {
    res.json(saveMemory(req.user.id, req.body.content));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/memories/:id', requireAuth, (req, res) => {
  try {
    res.json(deleteAnyMemory(req.user.id, Number(req.params.id)));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
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
  if (!process.env.OPENROUTER_API_KEY) console.log('No server-wide OPENROUTER_API_KEY — users must add their own key in Settings.');
  scheduler.start();
});
