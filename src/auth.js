const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SESSION_DAYS = 30;

function register(email, password) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid email address.');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw new Error('An account with that email already exists.');
  const hash = bcrypt.hashSync(password, 10);
  // Only the ADMIN_EMAIL account is ever the administrator.
  const isAdmin = email === db.ADMIN_EMAIL ? 1 : 0;
  const info = db.prepare('INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)').run(email, hash, isAdmin);
  return createSession(info.lastInsertRowid);
}

function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    throw new Error('Incorrect email or password.');
  }
  return createSession(user.id);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Self-service password change; keeps the current session, signs out others.
function changePassword(userId, currentPassword, newPassword, keepToken) {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!user || !bcrypt.compareSync(currentPassword || '', user.password_hash)) {
    throw new Error('Current password is incorrect.');
  }
  setPassword(userId, newPassword);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, keepToken || '');
  return { changed: true };
}

// Admin reset: sets a new password and signs the user out everywhere.
function adminSetPassword(userId, newPassword) {
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('No such user.');
  setPassword(userId, newPassword);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return { reset: user.email };
}

function setPassword(userId, newPassword) {
  if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), userId);
}

// Express middleware: attaches req.user or sends 401.
function requireAuth(req, res, next) {
  const token = req.cookies.session;
  if (token) {
    const row = db.prepare(`
      SELECT u.id, u.email, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).get(token);
    if (row) {
      req.user = row;
      return next();
    }
  }
  res.status(401).json({ error: 'Not signed in.' });
}

module.exports = { register, login, destroySession, requireAuth, changePassword, adminSetPassword };
