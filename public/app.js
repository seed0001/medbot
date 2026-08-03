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

const loaders = { reminders: loadReminders, log: loadLog, charts: loadCharts, records: loadRecords, appts: loadAppointments, files: loadFiles, memory: loadMemory, admin: loadAdmin };

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

// ---- Change own password ----
$('pw-btn').addEventListener('click', () => {
  $('pw-form').classList.toggle('hidden');
  $('pw-notice').textContent = '';
});

$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pw-notice').textContent = 'Saving…';
  try {
    await api('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password: $('pw-current').value, new_password: $('pw-new').value }),
    });
    $('pw-notice').textContent = '✅ Password changed.';
    $('pw-current').value = '';
    $('pw-new').value = '';
    setTimeout(() => $('pw-form').classList.add('hidden'), 1500);
  } catch (err) {
    $('pw-notice').textContent = '⚠️ ' + err.message;
  }
});

// ---- Chat ----
let ttsReady = false;
let currentAudio = null;

function addMsg(role, text, pending = false) {
  const div = document.createElement('div');
  div.className = `msg ${role}${pending ? ' pending' : ''}`;
  div.textContent = text;
  $('messages').appendChild(div);
  if (role === 'assistant' && !pending) attachSpeaker(div);
  $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}

// Adds a 🔊 button that reads the message aloud (Fish Audio TTS on the server).
function attachSpeaker(div) {
  if (!ttsReady || div.querySelector('.speak-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'speak-btn';
  btn.textContent = '🔊';
  btn.title = 'Read this aloud';
  btn.addEventListener('click', async () => {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
      document.querySelectorAll('.speak-btn.playing').forEach((b) => { b.classList.remove('playing'); b.textContent = '🔊'; });
      if (btn.dataset.wasPlaying === '1') { btn.dataset.wasPlaying = ''; return; }
    }
    btn.textContent = '…';
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: div.firstChild.textContent }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Voice failed.');
      const url = URL.createObjectURL(await res.blob());
      currentAudio = new Audio(url);
      btn.textContent = '⏹';
      btn.classList.add('playing');
      btn.dataset.wasPlaying = '1';
      currentAudio.onended = () => {
        btn.textContent = '🔊';
        btn.classList.remove('playing');
        btn.dataset.wasPlaying = '';
        currentAudio = null;
        URL.revokeObjectURL(url);
      };
      await currentAudio.play();
    } catch (err) {
      btn.textContent = '🔊';
      btn.classList.remove('playing');
      btn.dataset.wasPlaying = '';
      alert('⚠️ ' + err.message);
    }
  });
  div.appendChild(btn);
}

// The transcript box grows as words appear so nothing scrolls out of sight.
function resizeInput() {
  const input = $('chat-input');
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
}
$('chat-input').addEventListener('input', resizeInput);

// Enter sends (Shift+Enter for a new line) — handy when a keyboard is used.
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('chat-form').requestSubmit();
  }
});

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  resizeInput();
  addMsg('user', text);
  const pending = addMsg('assistant', 'Thinking…', true);
  const sendBtn = $('send-btn');
  sendBtn.disabled = true;
  try {
    const { reply, reply_id } = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: text }) });
    pending.textContent = reply;
    if (reply_id) lastMsgId = Math.max(lastMsgId, reply_id);
    speakNow(pending);
  } catch (err) {
    pending.textContent = '⚠️ ' + err.message;
  }
  pending.classList.remove('pending');
  sendBtn.disabled = false;
  // Refocusing on a phone pops the keyboard up over the reply — desktop only.
  if (window.matchMedia('(hover: hover)').matches) input.focus();
});

// ---- Voice input (browser speech recognition; button hides if unsupported) ----
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $('mic-btn');
  if (!SR) {
    micBtn.classList.add('hidden');
    return;
  }
  const rec = new SR();
  rec.lang = navigator.language || 'en-US';
  // Android Chrome's continuous mode re-delivers the same finalized phrase many
  // times over; one-utterance sessions plus our onend auto-restart behave there.
  rec.continuous = !/android/i.test(navigator.userAgent);
  rec.interimResults = true;

  // True push-to-talk toggle: listening continues (auto-restarting through the
  // browser's silence timeouts) until the button is pressed again.
  let wantListening = false;
  let baseText = ''; // whatever was typed before the mic went on
  let priorFinals = ''; // finalized speech from earlier auto-restarted sessions
  let sessionFinals = ''; // finalized speech in the current session
  let lastFinal = ''; // last accepted phrase, so re-sent duplicates get dropped

  const joined = (...parts) => parts.map((s) => s.trim()).filter(Boolean).join(' ');

  const setListening = (on) => {
    micBtn.classList.toggle('listening', on);
    micBtn.textContent = on ? '⏹ Stop' : '🎤 Talk';
    micBtn.title = on ? 'Stop listening' : 'Press and talk';
  };

  // Sending while the mic is on stops it, discarding any half-heard words so
  // they don't reappear in the box after it's cleared.
  $('chat-form').addEventListener('submit', () => {
    if (!wantListening) return;
    wantListening = false;
    rec.abort();
    setListening(false);
  });

  micBtn.addEventListener('click', () => {
    if (wantListening) {
      wantListening = false;
      rec.stop();
      setListening(false);
      return;
    }
    baseText = $('chat-input').value;
    priorFinals = '';
    sessionFinals = '';
    lastFinal = '';
    wantListening = true;
    try {
      rec.start();
      setListening(true);
    } catch { /* already started */ }
  });

  rec.onresult = (e) => {
    // Only look at results that are new in this event — older entries have
    // already been captured, and some phones keep re-sending them as "new".
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const t = r[0].transcript.trim();
      if (!t) continue;
      if (!r.isFinal) {
        interim = joined(interim, t);
      } else if (t.toLowerCase() !== lastFinal.toLowerCase()) {
        sessionFinals = joined(sessionFinals, t);
        lastFinal = t;
      }
    }
    $('chat-input').value = joined(baseText, priorFinals, sessionFinals, interim);
    resizeInput();
  };

  rec.onend = () => {
    if (wantListening) {
      // The browser gave up after a pause — keep going until the user says stop.
      priorFinals = joined(priorFinals, sessionFinals);
      sessionFinals = '';
      try { rec.start(); } catch { setTimeout(() => { if (wantListening) try { rec.start(); } catch {} }, 250); }
      return;
    }
    setListening(false);
    if (window.matchMedia('(hover: hover)').matches) $('chat-input').focus();
  };

  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return; // onend will restart
    wantListening = false;
    setListening(false);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      addMsg('assistant', '⚠️ I couldn\'t use the microphone — access is blocked. Allow microphone access for this app (browser: the padlock icon by the address bar; Amy app: Settings → Apps → Amy → Permissions), then try again.');
    }
  };
})();

// Voice is on: speak a reply automatically (the button still stops/replays).
function speakNow(div) {
  attachSpeaker(div);
  div.querySelector('.speak-btn')?.click();
}

let lastMsgId = 0;

async function loadMessages() {
  const { messages } = await api('/api/messages');
  $('messages').innerHTML = '';
  messages.forEach((m) => addMsg(m.role, m.content));
  lastMsgId = messages.length ? messages[messages.length - 1].id : 0;
}

// The assistant can reach out on its own (recurring reminders): poll for
// messages we haven't shown, append them to chat, and speak them aloud.
async function pollNewMessages() {
  if ($('app-view').classList.contains('hidden')) return;
  try {
    const { messages } = await api(`/api/messages?after=${lastMsgId}`);
    for (const m of messages) {
      lastMsgId = Math.max(lastMsgId, m.id);
      const div = addMsg(m.role, m.content);
      if (m.role === 'assistant') speakNow(div);
    }
  } catch { /* offline or signed out — try again next tick */ }
}

setInterval(pollNewMessages, 20000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollNewMessages();
});

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

// ---- Records tab (hospital chart via SMART on FHIR) ----
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

async function loadRecords() {
  const s = await api('/api/fhir/status');
  $('records-connect').classList.toggle('hidden', s.connected);
  $('records-data').classList.toggle('hidden', !s.connected);

  if (!s.connected) {
    $('records-server').textContent = s.server_label;
    return;
  }

  const bits = [];
  if (s.patient_name) bits.push(`Connected as ${s.patient_name}`);
  else bits.push('Connected');
  bits.push(s.server_label);
  bits.push(s.last_sync_at ? `synced ${fmtTime(s.last_sync_at)}` : 'first sync in progress…');
  $('records-status').textContent = bits.join(' · ');
  $('records-reconnect').classList.toggle('hidden', s.status !== 'reauth_needed');
  $('records-notice').textContent = s.status === 'reauth_needed'
    ? '⚠️ The portal connection expired — press Reconnect to sign in again.'
    : (s.last_sync_error ? '⚠️ Some sections could not be fetched: ' + s.last_sync_error : '');

  const { records } = await api('/api/fhir/records');
  const g = (cat) => records[cat] || [];

  fillTable('fhir-labs', g('lab'), (r) => [
    fmtDate(r.effective_at), r.title, r.value || '—', { text: r.detail || '', cls: 'note' },
  ]);
  fillTable('fhir-vitals', g('vital'), (r) => [fmtDate(r.effective_at), r.title, r.value || '—']);
  fillTable('fhir-meds', g('medication'), (r) => [
    r.title, r.status || '—', { text: r.detail || '', cls: 'note' }, fmtDate(r.effective_at),
  ]);
  fillTable('fhir-conditions', g('condition'), (r) => [r.title, r.value || '—', fmtDate(r.effective_at)]);
  fillTable('fhir-allergies', g('allergy'), (r) => [
    r.title, { text: r.value || '—', cls: 'note' }, { text: r.detail || '', cls: 'note' }, fmtDate(r.effective_at),
  ]);
  fillTable('fhir-imms', g('immunization'), (r) => [r.title, fmtDate(r.effective_at), r.status || '—']);
  fillTable('fhir-appts', g('appointment'), (r) => [
    r.effective_at ? fmtTime(r.effective_at) : '—', r.title, { text: r.detail || '', cls: 'note' }, r.status || '—',
  ]);

  // First sync may still be running right after the redirect back — retry once.
  if (!s.last_sync_at && !loadRecords.retried) {
    loadRecords.retried = true;
    setTimeout(() => { if (!$('records-data').classList.contains('hidden')) loadRecords().catch(() => {}); }, 4000);
  }
}

$('records-sync').addEventListener('click', async () => {
  const btn = $('records-sync');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const r = await api('/api/fhir/sync', { method: 'POST' });
    $('records-notice').textContent = r.errors?.length ? '⚠️ Some sections could not be fetched: ' + r.errors.join(' | ') : '✅ Records are up to date.';
    await loadRecords();
  } catch (err) {
    $('records-notice').textContent = '⚠️ ' + err.message;
  }
  btn.disabled = false;
  btn.textContent = '🔄 Sync now';
});

$('records-disconnect').addEventListener('click', async () => {
  if (!confirm('Disconnect your hospital records? The copied records are deleted from MedBot. You can reconnect any time.')) return;
  await api('/api/fhir/disconnect', { method: 'POST' });
  loadRecords();
});

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

// ---- Clear chat ----
$('clear-chat-btn').addEventListener('click', async () => {
  if (!confirm('Clear this conversation? Important details get saved to Memory first.')) return;
  const btn = $('clear-chat-btn');
  btn.disabled = true;
  btn.textContent = 'Clearing…';
  try {
    await api('/api/clear-chat', { method: 'POST' });
    await loadMessages();
  } catch (err) {
    alert('⚠️ ' + err.message);
  }
  btn.disabled = false;
  btn.textContent = '🧹 Clear chat';
});

// ---- Scan a medicine bottle (photo → vision model → medication list) ----
$('scan-btn').addEventListener('click', () => $('scan-input').click());

// Shrink the photo before upload: labels stay readable at 1280px and the
// upload goes from ~8 MB to a few hundred KB.
async function downscalePhoto(file, maxDim = 1280, quality = 0.85) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

$('scan-input').addEventListener('change', async () => {
  const file = $('scan-input').files[0];
  $('scan-input').value = '';
  if (!file) return;
  const btn = $('scan-btn');
  btn.disabled = true;
  addMsg('user', '📷 Scanned a medicine bottle');
  const pending = addMsg('assistant', 'Reading the label…', true);
  try {
    const image = await downscalePhoto(file);
    const { reply, reply_id } = await api('/api/scan-medication', { method: 'POST', body: JSON.stringify({ image }) });
    pending.textContent = reply;
    if (reply_id) lastMsgId = Math.max(lastMsgId, reply_id);
    speakNow(pending);
  } catch (err) {
    pending.textContent = '⚠️ ' + err.message;
  }
  pending.classList.remove('pending');
  btn.disabled = false;
});

// ---- Reminders tab ----
async function loadReminders() {
  const { reminders } = await api('/api/recurring');
  fillTable('reminders-table', reminders, (r) => {
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'small danger';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete this reminder?\n\n"${r.message}" (${r.schedule})`)) return;
      await api(`/api/recurring/${r.id}`, { method: 'DELETE' });
      loadReminders();
    });
    return [
      { text: r.message, cls: 'note' },
      r.schedule,
      fmtTime(r.next_due_at),
      { node: del },
    ];
  });
}

// ---- Memory tab ----
function memoryRow(tableId) {
  return (m) => {
    const del = document.createElement('button');
    del.textContent = 'Forget';
    del.className = 'small danger';
    del.addEventListener('click', async () => {
      if (!confirm('Forget this permanently?\n\n' + m.content.slice(0, 200))) return;
      await api(`/api/memories/${m.id}`, { method: 'DELETE' });
      loadMemory();
    });
    return [
      { text: m.content, cls: 'note' },
      new Date(m.created_at).toLocaleDateString(),
      { node: del },
    ];
  };
}

async function loadMemory() {
  const { long_term, episodic } = await api('/api/memories');
  fillTable('memory-facts', long_term, memoryRow('memory-facts'));
  fillTable('memory-episodes', episodic, memoryRow('memory-episodes'));
}

$('memory-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = $('memory-content').value.trim();
  if (!content) return;
  $('memory-notice').textContent = '';
  try {
    await api('/api/memories', { method: 'POST', body: JSON.stringify({ content }) });
    $('memory-content').value = '';
    loadMemory();
  } catch (err) {
    $('memory-notice').textContent = '⚠️ ' + err.message;
  }
});

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
  $('admin-router-model').value = s.router_model;
  $('admin-default-router-model').textContent = s.default_router_model;
  $('admin-persona').value = s.persona;
  $('admin-fish-key').value = '';
  $('admin-fish-status').textContent = s.fish_key_set
    ? `Key saved (${s.fish_key_hint}). Enter a new key to replace it; leave blank to keep it.`
    : 'No key yet — voice replies are off. Get a free key at fish.audio (Developers → API keys).';
  $('admin-tts-model').textContent = s.tts_model;
  $('admin-tts-voice').value = s.tts_voice;
  $('admin-fhir-base').value = s.fhir_base_url;
  $('admin-default-fhir-base').textContent = s.default_fhir_base;
  $('admin-fhir-client').value = s.fhir_client_id;

  const { users } = await api('/api/admin/users');
  fillTable('admin-users', users, (u) => {
    const btn = document.createElement('button');
    btn.textContent = 'Reset password';
    btn.className = 'small';
    btn.addEventListener('click', async () => {
      const pw = prompt(`New temporary password for ${u.email} (at least 8 characters):`);
      if (pw == null) return;
      try {
        await api(`/api/admin/users/${u.id}/password`, { method: 'POST', body: JSON.stringify({ password: pw }) });
        alert(`Password reset for ${u.email}. They are signed out everywhere — tell them the temporary password.`);
      } catch (err) {
        alert('⚠️ ' + err.message);
      }
    });
    return [
      u.email,
      u.is_admin ? 'Admin' : 'Member',
      new Date(u.created_at).toLocaleDateString(),
      u.readings,
      u.messages,
      { node: btn },
    ];
  });
}

$('admin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('admin-notice').textContent = 'Saving…';
  try {
    const body = {
      model: $('admin-model').value,
      router_model: $('admin-router-model').value,
      persona: $('admin-persona').value,
      tts_voice: $('admin-tts-voice').value,
      fhir_base_url: $('admin-fhir-base').value,
      fhir_client_id: $('admin-fhir-client').value,
    };
    // Only send keys if a new one was typed, so leaving them blank keeps the saved keys.
    if ($('admin-key').value.trim()) body.openrouter_key = $('admin-key').value.trim();
    if ($('admin-fish-key').value.trim()) body.fish_audio_key = $('admin-fish-key').value.trim();
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
  ttsReady = me.ttsReady;
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

// Show "Get the Android app" links once an APK has been published — but not
// when we're already running inside that app.
(async () => {
  if (window.Capacitor?.isNativePlatform?.()) return;
  try {
    const res = await fetch('/app/amy.apk', { method: 'HEAD' });
    if (res.ok) document.querySelectorAll('.get-app').forEach((el) => el.classList.remove('hidden'));
  } catch { /* offline — leave hidden */ }
})();

(async () => {
  try {
    await enterApp();
    // Coming back from the hospital portal: /?tab=records[&fhir=connected|&fhir_error=...]
    const params = new URLSearchParams(location.search);
    if (params.get('tab')) {
      showTab(params.get('tab'));
      const err = params.get('fhir_error');
      if (err) {
        $('records-connect-notice').textContent = '⚠️ ' + err;
        $('records-notice').textContent = '⚠️ ' + err;
      }
      history.replaceState({}, '', location.pathname);
    }
  } catch {
    show('auth');
  }
})();
