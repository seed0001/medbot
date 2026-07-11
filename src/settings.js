const db = require('./db');

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';
const KEYS = ['openrouter_key', 'model', 'persona', 'fish_audio_key', 'tts_voice'];

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

function resolveApiConfig() {
  const s = getAppSettings();
  return {
    key: s.openrouter_key || process.env.OPENROUTER_API_KEY || null,
    model: s.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
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
    persona: s.persona || '',
    fish_key_set: Boolean(s.fish_audio_key),
    fish_key_hint: s.fish_audio_key ? '…' + s.fish_audio_key.slice(-4) : null,
    tts_model: TTS_MODEL,
    tts_voice: s.tts_voice || '',
  };
}

// Fields left undefined are unchanged; an empty string clears a field.
function saveAppSettings({ openrouter_key, model, persona, fish_audio_key, tts_voice }) {
  const limits = { openrouter_key: 200, model: 120, persona: 2000, fish_audio_key: 200, tts_voice: 120 };
  const incoming = { openrouter_key, model, persona, fish_audio_key, tts_voice };
  if (incoming.openrouter_key !== undefined) {
    const k = String(incoming.openrouter_key).trim();
    if (k && !/^sk-or-/.test(k)) {
      throw new Error('That does not look like an OpenRouter key (they start with "sk-or-").');
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

module.exports = { getAppSettings, resolveApiConfig, resolveTtsConfig, publicAppSettings, saveAppSettings };
