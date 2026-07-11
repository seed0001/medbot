const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// On Railway, attach a volume and set DATA_DIR to its mount path (e.g. /data)
// so the database survives deploys.
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'medbot.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS readings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  glucose_mgdl  REAL NOT NULL,
  insulin_units REAL,
  note          TEXT,
  taken_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS medications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  dose       TEXT,
  schedule   TEXT,
  notes      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  stopped_at TEXT
);

CREATE TABLE IF NOT EXISTS med_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  medication_id INTEGER REFERENCES medications(id),
  name          TEXT NOT NULL,
  dose          TEXT,
  note          TEXT,
  taken_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS meals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  carbs_g     REAL,
  calories    REAL,
  note        TEXT,
  eaten_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- appt_at is a LOCAL wall-clock time "YYYY-MM-DDTHH:MM" in the TIMEZONE env var,
-- displayed as-is; reminder scheduling converts it to UTC.
CREATE TABLE IF NOT EXISTS appointments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  provider   TEXT,
  location   TEXT,
  appt_at    TEXT NOT NULL,
  notes      TEXT,
  canceled   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS reminders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  reading_id     INTEGER REFERENCES readings(id),
  appointment_id INTEGER REFERENCES appointments(id),
  type           TEXT NOT NULL DEFAULT 'glucose',
  message        TEXT,
  due_at         TEXT NOT NULL,
  sent_at        TEXT,
  canceled       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_readings_user ON readings(user_id, taken_at);
CREATE INDEX IF NOT EXISTS idx_med_events_user ON med_events(user_id, taken_at);
CREATE INDEX IF NOT EXISTS idx_meals_user ON meals(user_id, eaten_at);
CREATE INDEX IF NOT EXISTS idx_appts_user ON appointments(user_id, appt_at);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at) WHERE sent_at IS NULL AND canceled = 0;
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);
`);

// Migrations for databases created before the health-tracking expansion.
for (const col of ["type TEXT NOT NULL DEFAULT 'glucose'", 'message TEXT', 'appointment_id INTEGER REFERENCES appointments(id)']) {
  try { db.exec(`ALTER TABLE reminders ADD COLUMN ${col}`); } catch { /* already exists */ }
}

module.exports = db;
