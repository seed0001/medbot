const db = require('./db');

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';
// Fast, cheap model for the routing pre-pass that classifies each message
// before the main model acts on it.
const DEFAULT_ROUTER_MODEL = 'google/gemini-2.5-flash-lite';
const KEYS = ['openrouter_key', 'model', 'router_model', 'persona', 'fish_audio_key', 'tts_voice', 'fhir_base_url', 'fhir_client_id'];

// Site-wide settings, set by the admin, applying to every account.
function getAppSettings() {
  const rows = db.prepare(`SELECT key, value FROM app_settings WHERE key IN (${KEYS.map(() => '?').join(',')})`).all(...KEYS);
  const out = Object.fromEntries(KEYS.map((k) => [k, null]));
  for (const r of rows) out[r.key] = r.value || null;
  return out;
}

// Voice replies via Fish Audio TTS (free model through July 2026).
const TTS_MODEL = process.env.FISH_TTS_MODEL || 's2.1-pro-free';

function resolveTtsConfig() {
  const s = getAppSettings();
  return {
    key: s.fish_audio_key || process.env.FISH_AUDIO_API_KEY || null,
    model: TTS_MODEL,
    voice: s.tts_voice || null,
  };
}

// Hospital records (SMART on FHIR). The default is SMART Health IT's public
// practice sandbox — fake patients, accepts any client id — so the Records tab
// works out of the box. Point these at Cerner/Oracle Health (UAB) once the app
// is registered in their code console.
const DEFAULT_FHIR_BASE = process.env.FHIR_BASE_URL || 'https://launch.smarthealthit.org/v/r4/fhir';
const DEFAULT_FHIR_CLIENT_ID = process.env.FHIR_CLIENT_ID || 'medbot-demo';

function resolveFhirConfig() {
  const s = getAppSettings();
  return {
    base: (s.fhir_base_url || DEFAULT_FHIR_BASE).replace(/\/+$/, ''),
    clientId: s.fhir_client_id || DEFAULT_FHIR_CLIENT_ID,
  };
}

function resolveApiConfig() {
  const s = getAppSettings();
  return {
    key: s.openrouter_key || process.env.OPENROUTER_API_KEY || null,
    model: s.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    routerModel: s.router_model || process.env.OPENROUTER_ROUTER_MODEL || DEFAULT_ROUTER_MODEL,
    persona: s.persona,
  };
}

// Safe to send to the admin UI: never returns the key itself.
function publicAppSettings() {
  const s = getAppSettings();
  return {
    key_set: Boolean(s.openrouter_key),
    key_hint: s.openrouter_key ? '…' + s.openrouter_key.slice(-4) : null,
    env_key_available: Boolean(process.env.OPENROUTER_API_KEY),
    model: s.model || '',
    default_model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    router_model: s.router_model || '',
    default_router_model: process.env.OPENROUTER_ROUTER_MODEL || DEFAULT_ROUTER_MODEL,
    persona: s.persona || '',
    fish_key_set: Boolean(s.fish_audio_key),
    fish_key_hint: s.fish_audio_key ? '…' + s.fish_audio_key.slice(-4) : null,
    tts_model: TTS_MODEL,
    tts_voice: s.tts_voice || '',
    fhir_base_url: s.fhir_base_url || '',
    default_fhir_base: DEFAULT_FHIR_BASE,
    fhir_client_id: s.fhir_client_id || '',
    default_fhir_client_id: DEFAULT_FHIR_CLIENT_ID,
  };
}

// Fields left undefined are unchanged; an empty string clears a field.
function saveAppSettings({ openrouter_key, model, router_model, persona, fish_audio_key, tts_voice, fhir_base_url, fhir_client_id }) {
  const limits = { openrouter_key: 200, model: 120, router_model: 120, persona: 2000, fish_audio_key: 200, tts_voice: 120, fhir_base_url: 300, fhir_client_id: 200 };
  const incoming = { openrouter_key, model, router_model, persona, fish_audio_key, tts_voice, fhir_base_url, fhir_client_id };
  if (incoming.openrouter_key !== undefined) {
    const k = String(incoming.openrouter_key).trim();
    if (k && !/^sk-or-/.test(k)) {
      throw new Error('That does not look like an OpenRouter key (they start with "sk-or-").');
    }
  }
  if (incoming.fhir_base_url !== undefined) {
    const u = String(incoming.fhir_base_url).trim();
    if (u && !/^https:\/\/.+/.test(u)) {
      throw new Error('The FHIR server URL must start with https://');
    }
  }
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  for (const key of KEYS) {
    if (incoming[key] === undefined) continue;
    const value = String(incoming[key]).trim().slice(0, limits[key]) || null;
    upsert.run(key, value);
  }
  return publicAppSettings();
}

module.exports = { getAppSettings, resolveApiConfig, resolveTtsConfig, resolveFhirConfig, publicAppSettings, saveAppSettings };
