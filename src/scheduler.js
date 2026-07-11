const db = require('./db');
const { sendMail, mailEnabled } = require('./mailer');

const CHECK_INTERVAL_MS = 60 * 1000;

function buildEmail(r, appUrl) {
  if (r.type === 'appointment') {
    const when = r.appt_at ? r.appt_at.replace('T', ' at ') : 'soon';
    const where = r.location ? ` at ${r.location}` : '';
    const who = r.provider ? ` with ${r.provider}` : '';
    return {
      subject: `MedBot: appointment reminder — ${r.title || 'upcoming appointment'}`,
      text: `Reminder: you have "${r.title}"${who}${where} on ${when}.\n${r.appt_notes ? `Notes: ${r.appt_notes}\n` : ''}\nYour log and details: ${appUrl}\n\n— MedBot`,
      html: `<p>Reminder: you have <b>${r.title}</b>${who}${where} on <b>${when}</b>.</p>
${r.appt_notes ? `<p>Notes: ${r.appt_notes}</p>` : ''}
<p><a href="${appUrl}">Open MedBot</a> for your log and details.</p>
<p style="color:#888;font-size:12px">— MedBot</p>`,
    };
  }
  if (r.type === 'custom') {
    return {
      subject: 'MedBot: reminder',
      text: `${r.message}\n\nOpen MedBot: ${appUrl}\n\n— MedBot`,
      html: `<p>${String(r.message || '').replace(/</g, '&lt;')}</p>
<p><a href="${appUrl}">Open MedBot</a></p>
<p style="color:#888;font-size:12px">— MedBot</p>`,
    };
  }
  // glucose follow-up
  const last = r.glucose_mgdl != null
    ? ` Your last reading was ${r.glucose_mgdl} mg/dL${r.insulin_units != null ? ` with ${r.insulin_units} units of insulin` : ''}.`
    : '';
  return {
    subject: 'MedBot: time to check your blood sugar',
    text: `Hi! It's time to check your blood sugar again.${last}\n\nPlease take a reading and report it here so we can log the change: ${appUrl}\n\n— MedBot`,
    html: `<p>Hi! It's time to check your blood sugar again.${last}</p>
<p><a href="${appUrl}">Open MedBot to report your new reading</a> so we can log how much it changed.</p>
<p style="color:#888;font-size:12px">— MedBot. This is a logging reminder, not medical advice.</p>`,
  };
}

async function sendDueReminders() {
  if (!mailEnabled()) return;

  const due = db.prepare(`
    SELECT r.id, r.user_id, r.type, r.message, u.email,
           rd.glucose_mgdl, rd.insulin_units,
           a.title, a.provider, a.location, a.appt_at, a.notes AS appt_notes
    FROM reminders r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN readings rd ON rd.id = r.reading_id
    LEFT JOIN appointments a ON a.id = r.appointment_id
    WHERE r.sent_at IS NULL AND r.canceled = 0
      AND r.due_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).all();

  for (const r of due) {
    // Mark sent first so a mail failure can't cause repeated sends every minute.
    db.prepare("UPDATE reminders SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(r.id);
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    try {
      await sendMail({ to: r.email, ...buildEmail(r, appUrl) });
      console.log(`Reminder email (${r.type}) sent to ${r.email} (reminder ${r.id})`);
    } catch (err) {
      console.error(`Failed to send reminder ${r.id} to ${r.email}:`, err.message);
    }
  }
}

function start() {
  if (!mailEnabled()) {
    console.warn('SMTP not configured — reminder emails are disabled.');
  }
  setInterval(() => sendDueReminders().catch((e) => console.error('Reminder check failed:', e)), CHECK_INTERVAL_MS);
  sendDueReminders().catch((e) => console.error('Reminder check failed:', e));
}

module.exports = { start };
