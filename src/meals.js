const db = require('./db');

function logMeal(userId, { description, carbs_g, calories, note }) {
  description = String(description || '').trim().slice(0, 500);
  if (!description) throw new Error('A meal description is required.');
  const num = (v, label, max) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label} must be between 0 and ${max}.`);
    return n;
  };
  const info = db.prepare(
    'INSERT INTO meals (user_id, description, carbs_g, calories, note) VALUES (?, ?, ?, ?, ?)'
  ).run(
    userId,
    description,
    num(carbs_g, 'carbs_g', 1000),
    num(calories, 'calories', 10000),
    note ? String(note).trim().slice(0, 500) : null
  );
  return db.prepare('SELECT * FROM meals WHERE id = ?').get(info.lastInsertRowid);
}

function listMeals(userId, limit = 200) {
  return db.prepare(
    'SELECT id, description, carbs_g, calories, note, eaten_at FROM meals WHERE user_id = ? ORDER BY eaten_at DESC, id DESC LIMIT ?'
  ).all(userId, limit);
}

module.exports = { logMeal, listMeals };
