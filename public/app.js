const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fillTable(tableId, rows, mapper) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = '';
  if (rows.length === 0) {
    const cols = document.querySelectorAll(`#${tableId} thead th`).length;
    tbody.innerHTML = `<tr><td colspan="${cols}" class="empty">Nothing here yet.</td></tr>`;
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of mapper(row)) {
      const td = document.createElement('td');
      if (cell && typeof cell === 'object') {
        td.textContent = cell.text ?? '';
        if (cell.cls) td.className = cell.cls;
        if (cell.node) { td.textContent = ''; td.appendChild(cell.node); }
      } else {
        td.textContent = cell ?? '';
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

// ---- View switching ----
function show(view) {
  $('auth-view').classList.toggle('hidden', view !== 'auth');
  $('app-view').classList.toggle('hidden', view === 'auth');
}

const loaders = { log: loadLog, charts: loadCharts, appts: loadAppointments, files: loadFiles, admin: loadAdmin };

function showTab(tab) {
  document.querySelectorAll('main[data-panel]').forEach((m) => m.classList.toggle('hidden', m.dataset.panel !== tab));
  document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (loaders[tab]) loaders[tab]().catch((e) => console.error(e));
}

document.querySelectorAll('#tabs .tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---- Auth ----
let authMode = 'login';
document.querySelectorAll('#auth-form button').forEach((btn) => {
  btn.addEventListener('click', () => { authMode = btn.dataset.mode; });
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  try {
    await api(`/api/${authMode}`, {
      method: 'POST',
      body: JSON.stringify({ email: $('auth-email').value, password: $('auth-password').value }),
    });
    await enterApp();
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
});

$('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  show('auth');
});

// ---- Chat ----
function addMsg(role, text, pending = false) {
  const div = document.createElement('div');
  div.className = `msg ${role}${pending ? ' pending' : ''}`;
  div.textContent = text;
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addMsg('user', text);
  const pending = addMsg('assistant', 'Thinking…', true);
  const sendBtn = e.target.querySelector('button');
  sendBtn.disabled = true;
  try {
    const { reply } = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: text }) });
    pending.textContent = reply;
  } catch (err) {
    pending.textContent = '⚠️ ' + err.message;
  }
  pending.classList.remove('pending');
  sendBtn.disabled = false;
  input.focus();
});

async function loadMessages() {
  const { messages } = await api('/api/messages');
  $('messages').innerHTML = '';
  if (messages.length === 0) {
    addMsg('assistant', "Hi! I'm MedBot, your health-tracking assistant. You can tell me things like:\n\n• \"Blood sugar 182, took 4 units\" — I'll log it and email you in 2 hours to re-check\n• \"Took my morning metformin\"\n• \"I had a turkey sandwich and an apple for lunch\"\n• \"I see Dr. Smith next Tuesday at 2pm\"\n• \"Make me a list of questions for my doctor\"\n\nI keep everything in your Log, draw Charts, and can put together a report for your doctor. I never give medical or dosing advice — I'm here to keep good records.");
  } else {
    messages.forEach((m) => addMsg(m.role, m.content));
  }
}

// ---- Log tab ----
async function loadLog() {
  const { readings, medications, medEvents, meals, pendingReminder } = await api('/api/log');

  fillTable('readings-table', [...readings].reverse(), (r) => [
    fmtTime(r.taken_at),
    r.glucose_mgdl,
    r.delta_mgdl == null
      ? '—'
      : { text: (r.delta_mgdl > 0 ? '+' : '') + r.delta_mgdl, cls: r.delta_mgdl > 0 ? 'delta-up' : r.delta_mgdl < 0 ? 'delta-down' : '' },
    r.insulin_units ?? '—',
    { text: r.note || '', cls: 'note' },
  ]);

  fillTable('meds-table', medications, (m) => [
    m.name, m.dose || '—', m.schedule || '—',
    m.active ? { text: 'Active', cls: 'delta-down' } : 'Stopped',
    { text: m.notes || '', cls: 'note' },
  ]);

  fillTable('doses-table', medEvents, (e) => [fmtTime(e.taken_at), e.name, e.dose || '—', { text: e.note || '', cls: 'note' }]);

  fillTable('meals-table', meals, (m) => [
    fmtTime(m.eaten_at), { text: m.description, cls: 'note' }, m.carbs_g ?? '—', m.calories ?? '—', { text: m.note || '', cls: 'note' },
  ]);

  $('reminder-status').textContent = pendingReminder
    ? `⏰ Next blood-sugar check-in email: ${fmtTime(pendingReminder.due_at)}`
    : 'No blood-sugar follow-up scheduled.';
}

$('email-report-btn').addEventListener('click', () => {
  $('email-report-row').classList.toggle('hidden');
});

$('email-report-send').addEventListener('click', async () => {
  $('log-notice').textContent = 'Sending…';
  try {
    const body = { days: parseInt($('report-days').value, 10) };
    const to = $('report-to').value.trim();
    if (to) body.to = to;
    const res = await api('/api/email-report', { method: 'POST', body: JSON.stringify(body) });
    $('log-notice').textContent = `✅ Report sent to ${res.to}.`;
    $('email-report-row').classList.add('hidden');
  } catch (err) {
    $('log-notice').textContent = '⚠️ ' + err.message;
  }
});

$('stop-reminders-btn').addEventListener('click', async () => {
  await api('/api/stop-reminders', { method: 'POST' });
  $('log-notice').textContent = 'Pending check-in reminders canceled. Logging a new reading schedules the next one.';
  loadLog();
});

// ---- Charts tab ----
let chartDays = 30;
document.querySelectorAll('.range-btn').forEach((b) => b.addEventListener('click', () => {
  chartDays = parseInt(b.dataset.days, 10);
  document.querySelectorAll('.range-btn').forEach((x) => x.classList.toggle('active', x === b));
  loadCharts();
}));

async function loadCharts() {
  const data = await api(`/api/chart-data?days=${chartDays}`);
  const ms = (iso) => new Date(iso).getTime();

  renderTimeSeries($('chart-glucose'),
    data.readings.map((r) => ({ t: ms(r.taken_at), v: r.glucose_mgdl, label: r.note || '' })),
    { color: '#2a78d6', unit: 'mg/dL', band: [70, 180], rangeDays: chartDays });

  renderTimeSeries($('chart-insulin'),
    data.readings.filter((r) => r.insulin_units != null).map((r) => ({ t: ms(r.taken_at), v: r.insulin_units, label: r.note || '' })),
    { color: '#1baf7a', unit: 'units', rangeDays: chartDays });

  renderDailyBars($('chart-carbs'),
    data.meals.filter((m) => m.carbs_g != null).map((m) => ({ t: ms(m.eaten_at), v: m.carbs_g })),
    { color: '#eda100', unit: 'g carbs', rangeDays: chartDays, agg: 'sum' });

  renderDailyBars($('chart-meds'),
    data.doses.map((e) => ({ t: ms(e.taken_at), v: 1 })),
    { color: '#008300', unit: 'doses', rangeDays: chartDays, agg: 'count' });
}

// ---- Appointments tab ----
async function loadAppointments() {
  const { appointments } = await api('/api/appointments?all=1');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const nowLocal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const fmt = (a) => [a.appt_at.replace('T', '  '), a.title, a.provider || '—', a.location || '—', { text: a.notes || '', cls: 'note' }];
  fillTable('appts-upcoming', appointments.filter((a) => a.appt_at >= nowLocal), fmt);
  fillTable('appts-past', appointments.filter((a) => a.appt_at < nowLocal).reverse(), fmt);
}

// ---- Files tab ----
async function loadFiles() {
  const { files } = await api('/api/files');
  fillTable('files-table', files, (f) => {
    const wrap = document.createElement('span');
    const dl = document.createElement('a');
    dl.href = `/api/files/${encodeURIComponent(f.filename)}`;
    dl.textContent = 'Download';
    dl.className = 'csv';
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'small danger';
    del.style.marginLeft = '8px';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete ${f.filename}?`)) return;
      await api(`/api/files/${encodeURIComponent(f.filename)}`, { method: 'DELETE' });
      loadFiles();
    });
    wrap.append(dl, del);
    return [
      f.filename,
      f.bytes < 1024 ? `${f.bytes} B` : `${Math.round(f.bytes / 102.4) / 10} KB`,
      fmtTime(f.modified_at),
      { node: wrap },
    ];
  });
}

// ---- Admin tab ----
async function loadAdmin() {
  const s = await api('/api/admin/settings');
  $('admin-key').value = '';
  $('admin-key-status').textContent = s.key_set
    ? `Key saved (${s.key_hint}). Enter a new key to replace it; leave blank to keep it.`
    : s.env_key_available
      ? 'No key saved here — using the server environment key.'
      : '⚠️ No key configured. Chat will not work until you add one (openrouter.ai/keys).';
  $('admin-model').value = s.model;
  $('admin-default-model').textContent = s.default_model;
  $('admin-persona').value = s.persona;

  const { users } = await api('/api/admin/users');
  fillTable('admin-users', users, (u) => [
    u.email,
    u.is_admin ? 'Admin' : 'Member',
    new Date(u.created_at).toLocaleDateString(),
    u.readings,
    u.messages,
  ]);
}

$('admin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('admin-notice').textContent = 'Saving…';
  try {
    const body = {
      model: $('admin-model').value,
      persona: $('admin-persona').value,
    };
    // Only send the key if a new one was typed, so leaving it blank keeps the saved key.
    if ($('admin-key').value.trim()) body.openrouter_key = $('admin-key').value.trim();
    await api('/api/admin/settings', { method: 'POST', body: JSON.stringify(body) });
    $('admin-notice').textContent = '✅ Saved.';
    loadAdmin();
  } catch (err) {
    $('admin-notice').textContent = '⚠️ ' + err.message;
  }
});

// ---- Startup ----
async function enterApp() {
  const me = await api('/api/me');
  $('user-email').textContent = me.email;
  $('admin-tab').classList.toggle('hidden', !me.isAdmin);
  show('app');
  showTab('chat');
  await loadMessages();
  if (!me.chatReady) {
    addMsg('assistant', me.isAdmin
      ? '⚠️ No OpenRouter API key is set yet — open the Admin tab to add one so chat works.'
      : '⚠️ The assistant isn\'t connected yet — ask the administrator to add the API key.');
  }
  if (!me.mailEnabled) {
    addMsg('assistant', "⚠️ Heads up: email isn't configured on the server yet, so reminder emails and emailed reports won't send until SMTP settings are added.");
  }
}

(async () => {
  try {
    await enterApp();
  } catch {
    show('auth');
  }
})();
