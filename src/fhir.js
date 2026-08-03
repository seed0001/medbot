// Hospital records via SMART on FHIR (the standard Cerner/Oracle Health — and
// most US hospitals — expose for patient-authorized apps). The user presses
// "Connect my records", signs in on their patient portal's own login page, and
// we receive read-only tokens scoped to their chart. Everything here is
// pull-only: nothing is ever written back to the hospital.
const crypto = require('crypto');
const db = require('./db');
const { resolveFhirConfig } = require('./settings');

// Scopes use SMART v1 style (.read), which Cerner and the sandboxes all accept.
// Cerner forbids wildcards, so each resource is listed out.
const SCOPES = [
  'openid', 'fhirUser', 'offline_access', 'launch/patient',
  'patient/Patient.read', 'patient/Observation.read', 'patient/MedicationRequest.read',
  'patient/Condition.read', 'patient/AllergyIntolerance.read', 'patient/Immunization.read',
  'patient/Appointment.read',
].join(' ');

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PAGES_PER_CATEGORY = 5;
const AUTO_SYNC_HOURS = 6;

const pendingStates = new Map(); // state -> { userId, verifier, tokenEndpoint, base, clientId, redirectUri, createdAt }
const smartConfigCache = new Map(); // base -> { config, fetchedAt }

const nowIso = () => new Date().toISOString();
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---- SMART discovery ----
// Ask the FHIR server where its authorize/token endpoints live.
async function discoverSmart(base) {
  const cached = smartConfigCache.get(base);
  if (cached && Date.now() - cached.fetchedAt < 3600 * 1000) return cached.config;

  let config = null;
  try {
    const res = await fetch(`${base}/.well-known/smart-configuration`, { headers: { Accept: 'application/json' } });
    if (res.ok) config = await res.json();
  } catch { /* fall through to metadata */ }

  if (!config?.authorization_endpoint || !config?.token_endpoint) {
    const res = await fetch(`${base}/metadata`, { headers: { Accept: 'application/fhir+json' } });
    if (!res.ok) throw new Error(`The records server did not respond (${res.status}). Check the FHIR server URL in the Admin tab.`);
    const meta = await res.json();
    const ext = meta.rest?.[0]?.security?.extension
      ?.find((e) => e.url === 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris')?.extension || [];
    config = {
      authorization_endpoint: ext.find((e) => e.url === 'authorize')?.valueUri,
      token_endpoint: ext.find((e) => e.url === 'token')?.valueUri,
    };
  }
  if (!config.authorization_endpoint || !config.token_endpoint) {
    throw new Error('This FHIR server does not advertise SMART sign-in endpoints.');
  }
  smartConfigCache.set(base, { config, fetchedAt: Date.now() });
  return config;
}

// ---- OAuth: begin + callback ----
async function beginConnect(userId, redirectUri) {
  const { base, clientId } = resolveFhirConfig();
  const { authorization_endpoint, token_endpoint } = await discoverSmart(base);

  for (const [k, v] of pendingStates) if (Date.now() - v.createdAt > STATE_TTL_MS) pendingStates.delete(k);

  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  pendingStates.set(state, { userId, verifier, tokenEndpoint: token_endpoint, base, clientId, redirectUri, createdAt: Date.now() });

  const url = new URL(authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('aud', base);
  url.searchParams.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest()));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function handleCallback(query) {
  const pending = query.state && pendingStates.get(query.state);
  if (pending) pendingStates.delete(query.state);
  if (query.error) {
    throw new Error(query.error_description || query.error || 'The portal declined the connection.');
  }
  if (!pending) throw new Error('This sign-in link expired — please press Connect again.');
  if (!query.code) throw new Error('The portal did not return a sign-in code.');

  const tok = await tokenRequest(pending.tokenEndpoint, {
    grant_type: 'authorization_code',
    code: query.code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });

  const expiresAt = new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString();
  db.prepare(`
    INSERT INTO fhir_connections (user_id, fhir_base, client_id, patient_id, access_token, refresh_token, token_expires_at, scope, status, connected_at, last_sync_at, last_sync_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      fhir_base = excluded.fhir_base, client_id = excluded.client_id, patient_id = excluded.patient_id,
      access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      token_expires_at = excluded.token_expires_at, scope = excluded.scope, status = 'active',
      connected_at = excluded.connected_at, last_sync_error = NULL
  `).run(pending.userId, pending.base, pending.clientId, tok.patient || null, tok.access_token, tok.refresh_token || null, expiresAt, tok.scope || null);

  // Pull the chart right away so the tab has data when the user lands back on it.
  syncNow(pending.userId).catch((e) => console.error(`Initial FHIR sync failed for user ${pending.userId}:`, e.message));
  return { userId: pending.userId };
}

async function tokenRequest(tokenEndpoint, params) {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error_description || body.error || `Sign-in with the records server failed (${res.status}).`);
  }
  return body;
}

// ---- Token upkeep ----
function getConnection(userId) {
  return db.prepare('SELECT * FROM fhir_connections WHERE user_id = ?').get(userId) || null;
}

async function freshAccessToken(conn) {
  const expiresSoon = !conn.token_expires_at || new Date(conn.token_expires_at).getTime() < Date.now() + 60 * 1000;
  if (!expiresSoon) return conn.access_token;
  if (!conn.refresh_token) return conn.access_token; // let the request fail with 401 if it's truly dead

  const { token_endpoint } = await discoverSmart(conn.fhir_base);
  let tok;
  try {
    tok = await tokenRequest(token_endpoint, {
      grant_type: 'refresh_token',
      refresh_token: conn.refresh_token,
      client_id: conn.client_id,
    });
  } catch (err) {
    db.prepare("UPDATE fhir_connections SET status = 'reauth_needed' WHERE user_id = ?").run(conn.user_id);
    throw new Error('The portal connection expired — press Reconnect in the Records tab. (' + err.message + ')');
  }
  const expiresAt = new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString();
  db.prepare(`
    UPDATE fhir_connections SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
      token_expires_at = ?, status = 'active' WHERE user_id = ?
  `).run(tok.access_token, tok.refresh_token || null, expiresAt, conn.user_id);
  conn.access_token = tok.access_token;
  conn.token_expires_at = expiresAt;
  return tok.access_token;
}

async function fhirGet(conn, pathOrUrl) {
  const token = await freshAccessToken(conn);
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${conn.fhir_base}/${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' } });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`FHIR request failed (${res.status}): ${body}`);
  }
  return res.json();
}

// Collect every matching resource across a paginated search.
async function fetchAll(conn, searchPath, resourceType) {
  const out = [];
  let next = searchPath;
  for (let page = 0; next && page < MAX_PAGES_PER_CATEGORY; page++) {
    const bundle = await fhirGet(conn, next);
    for (const entry of bundle.entry || []) {
      if (entry.resource?.resourceType === resourceType) out.push(entry.resource);
    }
    next = (bundle.link || []).find((l) => l.relation === 'next')?.url || null;
  }
  return out;
}

// ---- Normalizers: FHIR resources → simple table rows ----
const codeText = (cc) => cc?.text || cc?.coding?.find((c) => c.display)?.display || cc?.coding?.[0]?.code || null;
const round1 = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : n);
const qty = (q) => (q && q.value != null ? `${round1(q.value)}${q.unit || q.code ? ' ' + (q.unit || q.code) : ''}` : null);

function obsValue(res) {
  if (res.valueQuantity) return qty(res.valueQuantity);
  if (res.valueCodeableConcept) return codeText(res.valueCodeableConcept);
  if (res.valueString) return res.valueString;
  if (Array.isArray(res.component) && res.component.length) {
    // Blood pressure and friends: "120/74 mm[Hg]" reads better than two rows.
    const parts = res.component.map((c) => ({ name: codeText(c.code) || '', val: c.valueQuantity }));
    const sys = parts.find((p) => /systolic/i.test(p.name));
    const dia = parts.find((p) => /diastolic/i.test(p.name));
    if (sys?.val && dia?.val) return `${round1(sys.val.value)}/${round1(dia.val.value)} ${sys.val.unit || 'mmHg'}`;
    return parts.filter((p) => p.val).map((p) => `${p.name}: ${qty(p.val)}`).join('; ') || null;
  }
  return null;
}

function obsDetail(res) {
  const bits = [];
  const interp = codeText(res.interpretation?.[0]);
  if (interp && !/normal/i.test(interp)) bits.push(interp);
  const range = res.referenceRange?.[0];
  if (range?.text) bits.push(`ref ${range.text}`);
  else if (range?.low || range?.high) bits.push(`ref ${qty(range.low) ?? ''}–${qty(range.high) ?? ''}`.trim());
  return bits.join(' · ') || null;
}

const NORMALIZERS = {
  lab: (res) => ({
    title: codeText(res.code) || 'Lab result',
    value: obsValue(res),
    detail: obsDetail(res),
    status: res.status || null,
    effective_at: res.effectiveDateTime || res.effectivePeriod?.start || res.issued || null,
  }),
  vital: (res) => NORMALIZERS.lab(res),
  medication: (res) => ({
    title: codeText(res.medicationCodeableConcept) || res.medicationReference?.display || 'Medication',
    value: res.status || null,
    detail: [res.dosageInstruction?.[0]?.text, res.requester?.display && `by ${res.requester.display}`].filter(Boolean).join(' · ') || null,
    status: res.status || null,
    effective_at: res.authoredOn || null,
  }),
  condition: (res) => ({
    title: codeText(res.code) || 'Condition',
    value: res.clinicalStatus?.coding?.[0]?.code || null,
    detail: codeText(res.severity) || null,
    status: res.clinicalStatus?.coding?.[0]?.code || null,
    effective_at: res.onsetDateTime || res.recordedDate || null,
  }),
  allergy: (res) => ({
    title: codeText(res.code) || 'Allergy',
    value: res.reaction?.map((r) => (r.manifestation || []).map(codeText).filter(Boolean).join(', ')).filter(Boolean).join('; ') || null,
    detail: [res.criticality && `criticality ${res.criticality}`, res.clinicalStatus?.coding?.[0]?.code].filter(Boolean).join(' · ') || null,
    status: res.clinicalStatus?.coding?.[0]?.code || null,
    effective_at: res.recordedDate || res.onsetDateTime || null,
  }),
  immunization: (res) => ({
    title: codeText(res.vaccineCode) || 'Vaccine',
    value: res.status || null,
    detail: res.site ? codeText(res.site) : null,
    status: res.status || null,
    effective_at: res.occurrenceDateTime || null,
  }),
  appointment: (res) => ({
    title: res.description || codeText(res.serviceType?.[0]) || codeText(res.appointmentType) || 'Appointment',
    value: res.status || null,
    detail: (res.participant || []).map((p) => p.actor?.display).filter(Boolean).join(', ') || null,
    status: res.status || null,
    effective_at: res.start || null,
  }),
};

// ---- Sync ----
const syncing = new Set();

async function syncNow(userId) {
  const conn = getConnection(userId);
  if (!conn) throw new Error('No hospital records connection yet — connect one in the Records tab.');
  if (syncing.has(userId)) return { already_running: true };
  syncing.add(userId);
  try {
    return await doSync(conn);
  } finally {
    syncing.delete(userId);
  }
}

async function doSync(conn) {
  const pid = conn.patient_id;
  const counts = {};
  const errors = [];

  // Patient demographics → display name for the status bar.
  try {
    if (pid) {
      const p = await fhirGet(conn, `Patient/${encodeURIComponent(pid)}`);
      const name = p.name?.find((n) => n.use === 'official') || p.name?.[0];
      const display = name ? (name.text || [...(name.given || []), name.family].filter(Boolean).join(' ')) : null;
      db.prepare('UPDATE fhir_connections SET patient_name = ? WHERE user_id = ?').run(display, conn.user_id);
    }
  } catch (err) {
    errors.push(`patient: ${err.message}`);
  }

  const yearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const searches = [
    ['lab', `Observation?patient=${pid}&category=laboratory&_count=100`, 'Observation'],
    ['vital', `Observation?patient=${pid}&category=vital-signs&_count=100`, 'Observation'],
    ['medication', `MedicationRequest?patient=${pid}&_count=100`, 'MedicationRequest'],
    ['condition', `Condition?patient=${pid}&_count=100`, 'Condition'],
    ['allergy', `AllergyIntolerance?patient=${pid}&_count=100`, 'AllergyIntolerance'],
    ['immunization', `Immunization?patient=${pid}&_count=100`, 'Immunization'],
    ['appointment', `Appointment?patient=${pid}&date=ge${yearAgo}&_count=100`, 'Appointment'],
  ];

  const insert = db.prepare(`
    INSERT INTO fhir_records (user_id, category, fhir_id, title, value, detail, status, effective_at, raw, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(user_id, category, fhir_id) DO UPDATE SET
      title = excluded.title, value = excluded.value, detail = excluded.detail, status = excluded.status,
      effective_at = excluded.effective_at, raw = excluded.raw, updated_at = excluded.updated_at
  `);
  const replaceCategory = db.transaction((cat, rows) => {
    db.prepare('DELETE FROM fhir_records WHERE user_id = ? AND category = ?').run(conn.user_id, cat);
    for (const r of rows) insert.run(conn.user_id, cat, r.fhir_id, r.title, r.value, r.detail, r.status, r.effective_at, r.raw);
  });

  for (const [cat, path, type] of searches) {
    try {
      const resources = await fetchAll(conn, path, type);
      const rows = resources.map((res) => {
        const norm = NORMALIZERS[cat](res);
        const slim = { ...res };
        delete slim.text; // narrative HTML can be huge and is never shown
        return { fhir_id: res.id || crypto.randomUUID(), raw: JSON.stringify(slim), ...norm };
      });
      replaceCategory(cat, rows);
      counts[cat] = rows.length;
    } catch (err) {
      errors.push(`${cat}: ${err.message.slice(0, 200)}`);
    }
  }

  db.prepare('UPDATE fhir_connections SET last_sync_at = ?, last_sync_error = ? WHERE user_id = ?')
    .run(nowIso(), errors.length ? errors.join(' | ').slice(0, 1000) : null, conn.user_id);
  return { counts, errors };
}

// Background refresh so new labs show up without anyone pressing Sync.
async function syncStale() {
  const staleBefore = new Date(Date.now() - AUTO_SYNC_HOURS * 3600 * 1000).toISOString();
  const due = db.prepare(`
    SELECT user_id FROM fhir_connections
    WHERE status = 'active' AND (last_sync_at IS NULL OR last_sync_at < ?)
  `).all(staleBefore);
  for (const { user_id } of due) {
    try {
      await syncNow(user_id);
      console.log(`FHIR auto-sync completed for user ${user_id}`);
    } catch (err) {
      console.error(`FHIR auto-sync failed for user ${user_id}:`, err.message);
    }
  }
}

// ---- Reads for the UI and the assistant ----
function serverLabel(base) {
  if (/smarthealthit\.org/.test(base)) return 'Practice sandbox (fake test patients — for trying this out)';
  if (/cerner\.com|oracle/.test(base)) return 'Oracle Health / Cerner (UAB Medicine uses this)';
  try { return new URL(base).hostname; } catch { return base; }
}

function getStatus(userId) {
  const { base, clientId } = resolveFhirConfig();
  const conn = getConnection(userId);
  if (!conn) {
    return { connected: false, server_label: serverLabel(base), client_id: clientId };
  }
  const counts = Object.fromEntries(
    db.prepare('SELECT category, COUNT(*) AS n FROM fhir_records WHERE user_id = ? GROUP BY category')
      .all(userId).map((r) => [r.category, r.n])
  );
  return {
    connected: true,
    status: conn.status,
    server_label: serverLabel(conn.fhir_base),
    patient_name: conn.patient_name,
    connected_at: conn.connected_at,
    last_sync_at: conn.last_sync_at,
    last_sync_error: conn.last_sync_error,
    counts,
  };
}

function getRecords(userId) {
  const rows = db.prepare(`
    SELECT category, title, value, detail, status, effective_at
    FROM fhir_records WHERE user_id = ?
    ORDER BY category, effective_at DESC, title
  `).all(userId);
  const grouped = {};
  for (const r of rows) (grouped[r.category] ||= []).push(r);
  return grouped;
}

function disconnect(userId) {
  db.prepare('DELETE FROM fhir_records WHERE user_id = ?').run(userId);
  const info = db.prepare('DELETE FROM fhir_connections WHERE user_id = ?').run(userId);
  return { disconnected: info.changes > 0 };
}

// Compact view for the assistant's get_medical_records tool.
function recordsForAI(userId, category = null) {
  const conn = getConnection(userId);
  if (!conn) {
    return { connected: false, note: 'No hospital records are connected. The user can connect their patient portal in the Records tab (Connect my records button).' };
  }
  const grouped = getRecords(userId);
  const compact = (list, cap) => (list || []).slice(0, cap).map((r) => ({
    what: r.title, result: r.value, detail: r.detail, status: r.status, date: r.effective_at?.slice(0, 10) || null,
  }));
  const all = {
    labs: compact(grouped.lab, 60),
    vitals: compact(grouped.vital, 40),
    hospital_medication_list: compact(grouped.medication, 60),
    conditions: compact(grouped.condition, 60),
    allergies: compact(grouped.allergy, 40),
    immunizations: compact(grouped.immunization, 40),
    hospital_appointments: compact(grouped.appointment, 30),
  };
  return {
    connected: true,
    patient_name: conn.patient_name,
    source: serverLabel(conn.fhir_base),
    last_synced: conn.last_sync_at,
    needs_reconnect: conn.status === 'reauth_needed' || undefined,
    ...(category && all[category] !== undefined ? { [category]: all[category] } : all),
  };
}

module.exports = { beginConnect, handleCallback, syncNow, syncStale, getStatus, getRecords, disconnect, recordsForAI };
