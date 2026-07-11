const db = require('./db');
const { localToUtc, TIMEZONE } = require('./time');
const { sendMail, mailEnabled } = require('./mailer');

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 60 * 24 * 28; // 4 weeks

// Local calendar date (and weekday 0-6) in TIMEZONE, `offsetDays` from now.
function localDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
  };
}

// Next UTC fire time strictly in the future (small grace so a reminder firing
// right now doesn't immediately reschedule for the same minute).
function computeNextDue({ freq, time_local, weekdays, interval_minutes }) {
  const now = Date.now();
  if (freq === 'interval') {
    return new Date(now + interval_minutes * 60000).toISOString();
  }
  const wanted = freq === 'weekly' ? String(weekdays).split(',').map(Number) : null;
  for (let i = 0; i <= 8; i++) {
    const { date, weekday } = localDay(i);
    if (wanted && !wanted.includes(weekday)) continue;
    const utc = localToUtc(`${date}T${time_local}`);
    if (utc.getTime() > now + 30000) return utc.toISOString();
  }
  throw new Error('Could not compute the next reminder time.');
}

function describeSchedule(r) {
  const at = r.time_local ? ` at ${r.time_local}` : '';
  if (r.freq === 'once') return 'one time';
  if (r.freq === 'daily') return `every day${at}`;
  if (r.freq === 'weekly') {
    const days = String(r.weekdays).split(',').map((n) => {
      const name = DAY_NAMES[Number(n)] || '?';
      return name[0].toUpperCase() + name.slice(1, 3);
    }).join(', ');
    return `every ${days}${at}`;
  }
  const m = r.interval_minutes;
  if (m % 60 === 0) return m === 60 ? 'every hour' : `every ${m / 60} hours`;
  return `every ${m} minutes`;
}

function normalizeWeekdays(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const nums = list.map((d) => {
    if (typeof d === 'number' || /^\d+$/.test(String(d).trim())) return Number(d);
    const idx = DAY_NAMES.findIndex((n) => n.startsWith(String(d).trim().toLowerCase().slice(0, 3)));
    return idx;
  }).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return [...new Set(nums)].sort();
}

function addRecurring(userId, { message, frequency, time, weekdays, every_minutes, in_minutes, at }) {
  const text = String(message || '').trim().slice(0, 300);
  if (!text) throw new Error('A reminder message is required.');
  const freq = String(frequency || '').toLowerCase();
  if (!['once', 'daily', 'weekly', 'interval'].includes(freq)) {
    throw new Error("frequency must be 'once', 'daily', 'weekly', or 'interval'.");
  }

  const row = { freq, time_local: null, weekdays: null, interval_minutes: null };
  if (freq === 'once') {
    let dueAt;
    if (in_minutes != null) {
      const mins = Math.round(Number(in_minutes));
      if (!Number.isFinite(mins) || mins < 1 || mins > MAX_INTERVAL_MINUTES) {
        throw new Error(`in_minutes must be between 1 and ${MAX_INTERVAL_MINUTES}.`);
      }
      dueAt = new Date(Date.now() + mins * 60000);
    } else if (at) {
      dueAt = localToUtc(String(at));
      if (dueAt.getTime() <= Date.now()) throw new Error(`${at} is in the past — one-time reminders need a future time.`);
    } else {
      throw new Error("A 'once' reminder needs in_minutes or at (local \"YYYY-MM-DDTHH:MM\").");
    }
    const info = db.prepare(`
      INSERT INTO recurring_reminders (user_id, message, freq, next_due_at) VALUES (?, ?, 'once', ?)
    `).run(userId, text, dueAt.toISOString());
    return { reminder: publicView(db.prepare('SELECT * FROM recurring_reminders WHERE id = ?').get(info.lastInsertRowid)) };
  }
  if (freq === 'interval') {
    const mins = Math.round(Number(every_minutes));
    if (!Number.isFinite(mins) || mins < MIN_INTERVAL_MINUTES || mins > MAX_INTERVAL_MINUTES) {
      throw new Error(`every_minutes must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}.`);
    }
    row.interval_minutes = mins;
  } else {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || ''))) {
      throw new Error('time must be 24-hour "HH:MM" local time.');
    }
    row.time_local = time;
    if (freq === 'weekly') {
      const days = normalizeWeekdays(weekdays);
      if (days.length === 0) throw new Error('weekly reminders need at least one weekday.');
      row.weekdays = days.join(',');
    }
  }

  const nextDue = computeNextDue(row);
  const info = db.prepare(`
    INSERT INTO recurring_reminders (user_id, message, freq, time_local, weekdays, interval_minutes, next_due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, text, row.freq, row.time_local, row.weekdays, row.interval_minutes, nextDue);
  const saved = db.prepare('SELECT * FROM recurring_reminders WHERE id = ?').get(info.lastInsertRowid);
  return { reminder: publicView(saved) };
}

function publicView(r) {
  return {
    id: r.id,
    message: r.message,
    schedule: describeSchedule(r),
    next_due_at: r.next_due_at,
  };
}

function listRecurring(userId) {
  return db.prepare(
    'SELECT * FROM recurring_reminders WHERE user_id = ? AND active = 1 ORDER BY next_due_at'
  ).all(userId).map(publicView);
}

function cancelRecurring(userId, id) {
  const info = db.prepare(
    'UPDATE recurring_reminders SET active = 0 WHERE user_id = ? AND id = ? AND active = 1'
  ).run(userId, Number(id));
  if (info.changes === 0) throw new Error(`No active recurring reminder with id ${id}.`);
  return { canceled: Number(id) };
}

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hour: 'numeric', hour12: false,
  }).format(new Date()));
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// Fire due reminders: reschedule first (so a crash can't cause a rapid-fire
// loop), then post the assistant's chat message; email is a best-effort backup.
async function fireDueRecurring() {
  const due = db.prepare(`
    SELECT r.*, u.email FROM recurring_reminders r
    JOIN users u ON u.id = r.user_id
    WHERE r.active = 1 AND r.next_due_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).all();

  for (const r of due) {
    if (r.freq === 'once') {
      db.prepare('UPDATE recurring_reminders SET active = 0 WHERE id = ?').run(r.id);
    } else {
      try {
        db.prepare('UPDATE recurring_reminders SET next_due_at = ? WHERE id = ?')
          .run(computeNextDue(r), r.id);
      } catch (err) {
        console.error(`Recurring reminder ${r.id}: reschedule failed, deactivating:`, err.message);
        db.prepare('UPDATE recurring_reminders SET active = 0 WHERE id = ?').run(r.id);
      }
    }

    const text = `⏰ ${greeting()}! Reminder: ${r.message}`;
    db.prepare('INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)').run(r.user_id, 'assistant', text);
    console.log(`Recurring reminder ${r.id} fired for user ${r.user_id} (${describeSchedule(r)})`);

    if (mailEnabled()) {
      const appUrl = process.env.APP_URL || 'http://localhost:3000';
      try {
        await sendMail({
          to: r.email,
          subject: 'MedBot: reminder',
          text: `${r.message}\n\nOpen MedBot: ${appUrl}\n\n— MedBot`,
          html: `<p>${String(r.message).replace(/</g, '&lt;')}</p>
<p><a href="${appUrl}">Open MedBot</a></p>
<p style="color:#888;font-size:12px">— MedBot</p>`,
        });
      } catch (err) {
        console.error(`Recurring reminder ${r.id}: backup email failed:`, err.message);
      }
    }
  }
}

module.exports = { addRecurring, listRecurring, cancelRecurring, fireDueRecurring };
