// Settings: built-in defaults < environment < values saved from the settings page (table "settings").
// Values saved on the settings page take effect immediately; nothing needs a restart.

import * as db from './db.mjs';

export const FIELDS = {
  base_url:           { type: 'string', env: 'ASK_BASE_URL', default: '' },
  api_key:            { type: 'secret', env: ['ASK_API_KEY', 'ANTHROPIC_API_KEY'], default: '' },
  model:              { type: 'string', env: 'ASK_MODEL', default: '' },
  effort:             { type: 'enum', env: 'ASK_EFFORT', default: '', options: ['', 'low', 'medium', 'high', 'xhigh', 'max'] },
  max_turns:          { type: 'int', env: 'ASK_MAX_TURNS', default: 8, min: 2, max: 30 },
  history_turns:      { type: 'int', env: 'ASK_HISTORY_TURNS', default: 10, min: 0, max: 100 },
  max_concurrent:     { type: 'int', env: 'ASK_MAX_CONCURRENT', default: 2, min: 1, max: 64 },
  max_queue:          { type: 'int', env: 'ASK_MAX_QUEUE', default: 8, min: 0, max: 1000 },
  max_question_chars: { type: 'int', env: 'ASK_MAX_QUESTION_CHARS', default: 4000, min: 100, max: 100000 },
  page_char_cap:      { type: 'int', env: 'ASK_PAGE_CHAR_CAP', default: 60000, min: 1000, max: 1000000 },
  wiki_name:          { type: 'string', env: 'ASK_WIKI_NAME', default: 'this wiki' },
  extra_instructions: { type: 'text', env: 'ASK_EXTRA_INSTRUCTIONS', default: '' },
  enabled:            { type: 'bool', env: 'ASK_ENABLED', default: true },
  // web tools; web_search needs an Exa key, web_fetch "direct" fetches pages itself
  web_search:         { type: 'bool', env: 'ASK_WEB_SEARCH', default: true },
  exa_api_key:        { type: 'secret', env: 'EXA_API_KEY', default: '' },
  web_search_results: { type: 'int', env: 'ASK_WEB_SEARCH_RESULTS', default: 5, min: 1, max: 20 },
  web_fetch:          { type: 'bool', env: 'ASK_WEB_FETCH', default: true },
  web_fetch_via:      { type: 'enum', env: 'ASK_WEB_FETCH_VIA', default: 'exa', options: ['exa', 'direct'] },
};

// When no model is set: Claude on the Anthropic API, otherwise the endpoint must be told.
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

function parse(field, raw) {
  if (raw === undefined || raw === null) return undefined;
  switch (field.type) {
    case 'int': {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) return undefined;
      return Math.min(field.max, Math.max(field.min, n));
    }
    case 'bool': return raw === true || raw === 'true' || raw === '1' || raw === 1;
    case 'enum': return field.options.includes(String(raw)) ? String(raw) : undefined;
    default: return String(raw);
  }
}

function fromEnv() {
  const out = {};
  for (const [key, f] of Object.entries(FIELDS)) {
    for (const name of [].concat(f.env)) {
      const v = parse(f, process.env[name]);
      if (v !== undefined && process.env[name] !== '') { out[key] = v; break; }
    }
  }
  return out;
}

let saved = {};
let current = null;
const listeners = [];

export async function load() {
  saved = await db.getSettings();
  recompute();
}

function recompute() {
  const env = fromEnv();
  const merged = {};
  const source = {};
  for (const [key, f] of Object.entries(FIELDS)) {
    if (saved[key] !== undefined) { merged[key] = parse(f, saved[key]); source[key] = 'saved'; }
    else if (env[key] !== undefined) { merged[key] = env[key]; source[key] = 'env'; }
    else { merged[key] = f.default; source[key] = 'default'; }
  }
  current = { values: merged, source };
  listeners.forEach(fn => fn(merged));
}

export function get() { return current.values; }
export function onChange(fn) { listeners.push(fn); }

export function isAnthropic(values = current.values) {
  return !values.base_url || /(^|\.)anthropic\.com/.test(new URL(values.base_url).hostname);
}

export function effectiveModel(values = current.values) {
  return values.model || (isAnthropic(values) ? DEFAULT_ANTHROPIC_MODEL : '');
}

// What the settings page sees: secrets masked.
export function describe() {
  const out = {};
  for (const [key, f] of Object.entries(FIELDS)) {
    const v = current.values[key];
    out[key] = {
      type: f.type, source: current.source[key], default: f.type === 'secret' ? '' : f.default,
      ...(f.options ? { options: f.options } : {}), ...(f.min !== undefined ? { min: f.min, max: f.max } : {}),
      value: f.type === 'secret' ? '' : v,
      ...(f.type === 'secret' ? { set: Boolean(v), hint: v ? `…${String(v).slice(-4)}` : '' } : {}),
    };
  }
  return out;
}

// Validate a patch from the settings page. null = "reset to env/default"; a blank secret = keep.
export function validate(patch) {
  const clean = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    const f = FIELDS[key];
    if (!f) continue;
    if (raw === null) { clean[key] = null; continue; }
    if (f.type === 'secret' && raw === '') continue;
    const v = parse(f, raw);
    if (v === undefined) throw new Error(`invalid value for ${key}`);
    if (key === 'base_url' && v) {
      let u;
      try { u = new URL(v); } catch { throw new Error('base_url must be a URL'); }
      if (!/^https?:$/.test(u.protocol)) throw new Error('base_url must be http(s)');
    }
    clean[key] = v;
  }
  return clean;
}

export function preview(patch) {
  const clean = validate(patch);
  const values = { ...current.values };
  for (const [k, v] of Object.entries(clean)) values[k] = v === null ? (fromEnv()[k] ?? FIELDS[k].default) : v;
  return values;
}

export async function save(patch, user) {
  const clean = validate(patch);
  await db.saveSettings(clean, user.email);
  await load();
}
