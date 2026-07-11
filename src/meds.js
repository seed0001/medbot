const db = require('./db');

function clean(s, max = 300) {
  const t = s == null ? null : String(s).trim().slice(0, max);
  return t || null;
}

function addMedication(userId, { name, dose, schedule, notes }) {
  name = clean(name, 120);
  if (!name) throw new Error('Medication name is required.');
  const existing = db.prepare(
    'SELECT id FROM medications WHERE user_id = ? AND active = 1 AND LOWER(name) = LOWER(?)'
  ).get(userId, name);
  if (existing) throw new Error(`"${name}" is already on the active medication list (id ${existing.id}).`);
  const info = db.prepare(
    'INSERT INTO medications (user_id, name, dose, schedule, notes) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, name, clean(dose, 120), clean(schedule, 200), clean(notes));
  return db.prepare('SELECT * FROM medications WHERE id = ?').get(info.lastInsertRowid);
}

function listMedications(userId, includeStopped = false) {
  return db.prepare(
    `SELECT * FROM medications WHERE user_id = ? ${includeStopped ? '' : 'AND active = 1'} ORDER BY active DESC, name`
  ).all(userId);
}

function stopMedication(userId, name) {
  const med = db.prepare(
    'SELECT id, name FROM medications WHERE user_id = ? AND active = 1 AND LOWER(name) = LOWER(?)'
  ).get(userId, clean(name, 120) || '');
  if (!med) throw new Error(`No active medication named "${name}" found.`);
  db.prepare(
    "UPDATE medications SET active = 0, stopped_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(med.id);
  return { stopped: med.name };
}

// Record that a dose was taken. Matches an active medication by name when
// possible; otherwise records a free-standing event (e.g. one-off ibuprofen).
function logMedTaken(userId, { name, dose, note }) {
  name = clean(name, 120);
  if (!name) throw new Error('Medication name is required.');
  const med = db.prepare(
    'SELECT id, name, dose FROM medications WHERE user_id = ? AND active = 1 AND LOWER(name) = LOWER(?)'
  ).get(userId, name);
  const info = db.prepare(
    'INSERT INTO med_events (user_id, medication_id, name, dose, note) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, med ? med.id : null, med ? med.name : name, clean(dose, 120) || (med ? med.dose : null), clean(note));
  const event = db.prepare('SELECT * FROM med_events WHERE id = ?').get(info.lastInsertRowid);
  return { event, matched_regimen: Boolean(med) };
}

function medEvents(userId, limit = 200) {
  return db.prepare(
    'SELECT id, name, dose, note, taken_at FROM med_events WHERE user_id = ? ORDER BY taken_at DESC, id DESC LIMIT ?'
  ).all(userId, limit);
}

module.exports = { addMedication, listMedications, stopMedication, logMedTaken, medEvents };
