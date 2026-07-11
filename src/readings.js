const db = require('./db');

const FOLLOWUP_MINUTES = parseInt(process.env.FOLLOWUP_MINUTES || '120', 10);

// Log a reading, cancel any pending reminder, and schedule the next follow-up.
// Returns the stored reading plus the change since the previous one.
function logReading(userId, { glucose_mgdl, insulin_units = null, note = null, followup_minutes = null }) {
  const glucose = Number(glucose_mgdl);
  if (!Number.isFinite(glucose) || glucose <= 0 || glucose > 1500) {
    throw new Error('glucose_mgdl must be a positive number (mg/dL).');
  }
  const insulin = insulin_units == null || insulin_units === '' ? null : Number(insulin_units);
  if (insulin != null && (!Number.isFinite(insulin) || insulin < 0 || insulin > 200)) {
    throw new Error('insulin_units must be a non-negative number.');
  }

  const previous = db.prepare(
    'SELECT glucose_mgdl, taken_at FROM readings WHERE user_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1'
  ).get(userId);

  const info = db.prepare(
    'INSERT INTO readings (user_id, glucose_mgdl, insulin_units, note) VALUES (?, ?, ?, ?)'
  ).run(userId, glucose, insulin, note);
  const reading = db.prepare('SELECT * FROM readings WHERE id = ?').get(info.lastInsertRowid);

  // One active glucose follow-up at a time: replace whatever was pending.
  db.prepare("UPDATE reminders SET canceled = 1 WHERE user_id = ? AND type = 'glucose' AND sent_at IS NULL AND canceled = 0").run(userId);
  const minutes = followup_minutes && followup_minutes > 0 ? followup_minutes : FOLLOWUP_MINUTES;
  const dueAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  db.prepare("INSERT INTO reminders (user_id, reading_id, type, due_at) VALUES (?, ?, 'glucose', ?)").run(userId, reading.id, dueAt);

  let change = null;
  if (previous) {
    const elapsedMin = Math.round((new Date(reading.taken_at) - new Date(previous.taken_at)) / 60000);
    change = {
      delta_mgdl: Math.round((glucose - previous.glucose_mgdl) * 10) / 10,
      previous_glucose_mgdl: previous.glucose_mgdl,
      previous_taken_at: previous.taken_at,
      minutes_since_previous: elapsedMin,
    };
  }

  return { reading, change, next_followup_at: dueAt, followup_minutes: minutes };
}

function getLog(userId, limit = 50) {
  const rows = db.prepare(
    'SELECT id, glucose_mgdl, insulin_units, note, taken_at FROM readings WHERE user_id = ? ORDER BY taken_at ASC, id ASC'
  ).all(userId);
  // Compute deltas oldest → newest, then return the most recent `limit`.
  rows.forEach((r, i) => {
    r.delta_mgdl = i > 0 ? Math.round((r.glucose_mgdl - rows[i - 1].glucose_mgdl) * 10) / 10 : null;
  });
  return rows.slice(-limit);
}

// Cancels glucose follow-ups and custom reminders; appointment reminders stay
// unless the appointment itself is canceled.
function stopReminders(userId) {
  const info = db.prepare(
    "UPDATE reminders SET canceled = 1 WHERE user_id = ? AND type IN ('glucose','custom') AND sent_at IS NULL AND canceled = 0"
  ).run(userId);
  return { canceled: info.changes };
}

function pendingReminder(userId) {
  return db.prepare(
    "SELECT due_at FROM reminders WHERE user_id = ? AND type = 'glucose' AND sent_at IS NULL AND canceled = 0 ORDER BY due_at ASC LIMIT 1"
  ).get(userId) || null;
}

function scheduleCustomReminder(userId, message, minutesFromNow) {
  const minutes = Number(minutesFromNow);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 30) {
    throw new Error('minutes_from_now must be between 1 and 43200 (30 days).');
  }
  const text = String(message || '').trim().slice(0, 500);
  if (!text) throw new Error('A reminder message is required.');
  const dueAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  db.prepare("INSERT INTO reminders (user_id, type, message, due_at) VALUES (?, 'custom', ?, ?)").run(userId, text, dueAt);
  return { scheduled_for: dueAt, message: text };
}

module.exports = { logReading, getLog, stopReminders, pendingReminder, scheduleCustomReminder, FOLLOWUP_MINUTES };
