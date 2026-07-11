const { getLog } = require('./readings');
const { listMedications, medEvents } = require('./meds');
const { listMeals } = require('./meals');
const { listAppointments } = require('./appointments');
const { sendMail } = require('./mailer');
const { TIMEZONE } = require('./time');

const esc = (v) => (v == null ? '' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

function csvOf(rows, columns) {
  const escCsv = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => escCsv(r[c])).join(','))].join('\n') + '\n';
}

function fmtLocal(iso) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: TIMEZONE, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function collectData(userId, days) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const readings = getLog(userId, 100000).filter((r) => r.taken_at >= since);
  const glucose = readings.map((r) => r.glucose_mgdl);
  const stats = glucose.length
    ? {
        count: glucose.length,
        avg: Math.round(glucose.reduce((a, b) => a + b, 0) / glucose.length),
        min: Math.min(...glucose),
        max: Math.max(...glucose),
        below70: glucose.filter((g) => g < 70).length,
        above180: glucose.filter((g) => g > 180).length,
      }
    : null;
  return {
    days,
    readings,
    stats,
    medications: listMedications(userId, true),
    doses: medEvents(userId, 100000).filter((e) => e.taken_at >= since),
    meals: listMeals(userId, 100000).filter((m) => m.eaten_at >= since),
    appointments: listAppointments(userId, true),
  };
}

function table(headers, rows) {
  if (rows.length === 0) return '<p class="empty">No entries in this period.</p>';
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function buildReportHtml(user, data) {
  const d = data;
  const readingRows = d.readings.map((r) => `<tr>
    <td>${fmtLocal(r.taken_at)}</td><td class="num">${r.glucose_mgdl}</td>
    <td class="num">${r.delta_mgdl == null ? '—' : (r.delta_mgdl > 0 ? '+' : '') + r.delta_mgdl}</td>
    <td class="num">${r.insulin_units ?? '—'}</td><td>${esc(r.note)}</td></tr>`);
  const medRows = d.medications.map((m) => `<tr>
    <td>${esc(m.name)}</td><td>${esc(m.dose) || '—'}</td><td>${esc(m.schedule) || '—'}</td>
    <td>${m.active ? 'Active' : `Stopped ${m.stopped_at ? fmtLocal(m.stopped_at) : ''}`}</td><td>${esc(m.notes)}</td></tr>`);
  const doseRows = d.doses.map((e) => `<tr>
    <td>${fmtLocal(e.taken_at)}</td><td>${esc(e.name)}</td><td>${esc(e.dose) || '—'}</td><td>${esc(e.note)}</td></tr>`);
  const mealRows = d.meals.map((m) => `<tr>
    <td>${fmtLocal(m.eaten_at)}</td><td>${esc(m.description)}</td>
    <td class="num">${m.carbs_g ?? '—'}</td><td class="num">${m.calories ?? '—'}</td><td>${esc(m.note)}</td></tr>`);
  const apptRows = d.appointments.map((a) => `<tr>
    <td>${esc(a.appt_at).replace('T', ' ')}</td><td>${esc(a.title)}</td>
    <td>${esc(a.provider) || '—'}</td><td>${esc(a.location) || '—'}</td><td>${esc(a.notes)}</td></tr>`);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Health Report — ${esc(user.email)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #0b0b0b; margin: 40px auto; max-width: 900px; padding: 0 20px; }
  h1 { font-size: 24px; margin-bottom: 2px; }
  h2 { font-size: 17px; margin: 28px 0 8px; border-bottom: 1px solid #e1e0d9; padding-bottom: 4px; }
  .meta { color: #52514e; font-size: 14px; margin-bottom: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #e1e0d9; padding: 6px 9px; text-align: left; vertical-align: top; }
  th { background: #f4f4f1; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .stats { display: flex; gap: 24px; flex-wrap: wrap; margin: 10px 0; }
  .stat { border: 1px solid #e1e0d9; border-radius: 8px; padding: 10px 16px; }
  .stat b { display: block; font-size: 20px; }
  .stat span { color: #52514e; font-size: 12px; }
  .empty { color: #898781; font-size: 13px; }
  .disclaimer { color: #898781; font-size: 12px; margin-top: 30px; }
  .print-btn { float: right; padding: 8px 14px; font-size: 14px; cursor: pointer; }
  @media print { .print-btn { display: none; } body { margin: 0; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
<h1>Health Report</h1>
<p class="meta">Patient account: ${esc(user.email)} &nbsp;•&nbsp; Period: last ${d.days} days &nbsp;•&nbsp; Generated ${fmtLocal(new Date().toISOString())} (${TIMEZONE})</p>

<h2>Blood glucose summary</h2>
${d.stats ? `<div class="stats">
  <div class="stat"><b>${d.stats.count}</b><span>readings</span></div>
  <div class="stat"><b>${d.stats.avg}</b><span>average mg/dL</span></div>
  <div class="stat"><b>${d.stats.min}–${d.stats.max}</b><span>range mg/dL</span></div>
  <div class="stat"><b>${d.stats.below70}</b><span>readings &lt; 70</span></div>
  <div class="stat"><b>${d.stats.above180}</b><span>readings &gt; 180</span></div>
</div>` : '<p class="empty">No readings in this period.</p>'}

<h2>Blood glucose &amp; insulin log</h2>
${table(['Time', 'Glucose (mg/dL)', 'Change', 'Insulin (units)', 'Note'], readingRows)}

<h2>Medication list</h2>
${table(['Medication', 'Dose', 'Schedule', 'Status', 'Notes'], medRows)}

<h2>Doses taken</h2>
${table(['Time', 'Medication', 'Dose', 'Note'], doseRows)}

<h2>Food log</h2>
${table(['Time', 'Meal', 'Carbs (g)', 'Calories', 'Note'], mealRows)}

<h2>Appointments</h2>
${table(['When (local)', 'Title', 'Provider', 'Location', 'Notes'], apptRows)}

<p class="disclaimer">Generated by MedBot from patient-entered data. This log is for informational purposes and is not medical advice; values are self-reported and unverified.</p>
</body></html>`;
}

function reportAttachments(data) {
  const date = new Date().toISOString().slice(0, 10);
  const files = [];
  if (data.readings.length) files.push({ filename: `glucose-${date}.csv`, content: csvOf(data.readings, ['taken_at', 'glucose_mgdl', 'delta_mgdl', 'insulin_units', 'note']) });
  if (data.medications.length) files.push({ filename: `medications-${date}.csv`, content: csvOf(data.medications, ['name', 'dose', 'schedule', 'active', 'started_at', 'stopped_at', 'notes']) });
  if (data.doses.length) files.push({ filename: `doses-taken-${date}.csv`, content: csvOf(data.doses, ['taken_at', 'name', 'dose', 'note']) });
  if (data.meals.length) files.push({ filename: `meals-${date}.csv`, content: csvOf(data.meals, ['eaten_at', 'description', 'carbs_g', 'calories', 'note']) });
  if (data.appointments.length) files.push({ filename: `appointments-${date}.csv`, content: csvOf(data.appointments, ['appt_at', 'title', 'provider', 'location', 'notes']) });
  return files;
}

async function emailReport(user, days, toOverride) {
  const data = collectData(user.id, days);
  const html = buildReportHtml(user, data);
  const to = toOverride || user.email;
  await sendMail({
    to,
    subject: `Health report — last ${days} days (${new Date().toISOString().slice(0, 10)})`,
    text: `A health report for the last ${days} days is attached as HTML (open and print/save as PDF), with CSV data files.\n\n— MedBot`,
    html: `<p>Your health report for the last ${days} days is attached as an HTML file — open it and use Print → Save as PDF to hand a copy to your doctor. Raw data is attached as CSV.</p><p style="color:#888;font-size:12px">— MedBot. Patient-entered data; not medical advice.</p>`,
    attachments: [{ filename: `health-report-${new Date().toISOString().slice(0, 10)}.html`, content: html }, ...reportAttachments(data)],
  });
  return { to, readings: data.readings.length };
}

module.exports = { collectData, buildReportHtml, emailReport, csvOf };
