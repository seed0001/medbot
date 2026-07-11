const db = require('./db');
const { localToUtc, TIMEZONE } = require('./time');

const REMIND_HOURS_BEFORE = 24;

function addAppointment(userId, { title, provider, location, datetime, notes }) {
  title = String(title || '').trim().slice(0, 200);
  if (!title) throw new Error('An appointment title is required (e.g. "Endocrinologist check-up").');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(datetime || ''))) {
    throw new Error('datetime must be local time formatted as YYYY-MM-DDTHH:MM.');
  }
  const utc = localToUtc(datetime);
  const clean = (s, max = 300) => (s == null ? null : String(s).trim().slice(0, max)) || null;

  const info = db.prepare(
    'INSERT INTO appointments (user_id, title, provider, location, appt_at, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, title, clean(provider, 150), clean(location), datetime, clean(notes, 500));
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(info.lastInsertRowid);

  // Email reminder the day before (or skipped if the appointment is closer than that).
  let reminder = null;
  const remindAt = new Date(utc.getTime() - REMIND_HOURS_BEFORE * 3600 * 1000);
  if (remindAt.getTime() > Date.now()) {
    db.prepare(
      "INSERT INTO reminders (user_id, appointment_id, type, due_at) VALUES (?, ?, 'appointment', ?)"
    ).run(userId, appt.id, remindAt.toISOString());
    reminder = { email_reminder_at_utc: remindAt.toISOString(), hours_before: REMIND_HOURS_BEFORE };
  }
  return { appointment: appt, reminder, timezone: TIMEZONE };
}

function listAppointments(userId, includePast = false) {
  const rows = db.prepare(
    'SELECT id, title, provider, location, appt_at, notes, canceled FROM appointments WHERE user_id = ? AND canceled = 0 ORDER BY appt_at'
  ).all(userId);
  if (includePast) return rows;
  const today = new Date().toISOString().slice(0, 10); // generous cutoff: keep anything from today on
  return rows.filter((a) => a.appt_at >= today);
}

function cancelAppointment(userId, id) {
  const appt = db.prepare('SELECT id, title, appt_at FROM appointments WHERE user_id = ? AND id = ? AND canceled = 0').get(userId, id);
  if (!appt) throw new Error(`No upcoming appointment with id ${id}.`);
  db.prepare('UPDATE appointments SET canceled = 1 WHERE id = ?').run(appt.id);
  db.prepare('UPDATE reminders SET canceled = 1 WHERE appointment_id = ? AND sent_at IS NULL').run(appt.id);
  return { canceled: `${appt.title} on ${appt.appt_at}` };
}

module.exports = { addAppointment, listAppointments, cancelAppointment, REMIND_HOURS_BEFORE };
