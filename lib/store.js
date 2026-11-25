// The encrypted store behind /settings and the logins.
//
// Saved values win over the defaults in journey.config.json. They are AES-256-GCM
// encrypted at rest whenever a secret is set:
//   ADMIN_PASSWORD / ACCESS_PASSWORD   optional setup code for the owner sign-up; also the
//                                      encryption secret unless SETTINGS_SECRET is set.
//                                      With none of them set (open mode) settings are
//                                      stored as plain JSON: they hold no secrets.
//   KV_REST_API_URL + KV_REST_API_TOKEN  Upstash Redis, injected when the integration
//                                      is attached to the Vercel project
// Off Vercel (local preview) the store falls back to a gitignored .data/ folder.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROLES = ['setter', 'triage', 'closer'];
const DISCORD_ID_RE = /^\d{15,22}$/;

/* ------------------------------------------------------------ validators */

const dayList = (v) => {
  const days = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (!days.length || days.some((d) => !/^[0-6]$/.test(d))) throw new Error('must be day numbers 0-6 separated by commas (0 = Sunday)');
  return [...new Set(days)].join(',');
};
const onOff = (v) => { const x = v.toLowerCase(); if (x !== 'on' && x !== 'off') throw new Error('must be on or off'); return x; };
const roleList = (v) => {
  const roles = v.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (!roles.length || roles.some((r) => !ROLES.includes(r))) throw new Error('can only contain setter, triage, closer');
  return [...new Set(roles)].join(',');
};
const hour = (v) => { if (!/^([01]?\d|2[0-3])$/.test(v)) throw new Error('must be a whole hour from 0 to 23'); return String(Number(v)); };
// A daily target. 0 means "no target".
const targetNumber = (max) => (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`must be a number from 0 to ${max}`);
  return String(n);
};

// {"setter":[…],"triage":[…],"closer":[…]}, each entry {name, discord?, aka?, nudge?}.
function rosterJSON(v) {
  let j;
  try { j = JSON.parse(v); } catch { throw new Error('is not valid JSON'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('must be an object with setter / triage / closer lists');
  const out = {};
  for (const role of ROLES) {
    const list = j[role] == null ? [] : j[role];
    if (!Array.isArray(list)) throw new Error(`"${role}" must be a list`);
    out[role] = list.map((p) => {
      const e = typeof p === 'string' ? { name: p } : (p || {});
      const name = String(e.name || '').trim();
      if (!name || name.length > 80) throw new Error(`has a ${role} with a missing or over-long name`);
      const entry = { name };
      if (e.discord) { if (!DISCORD_ID_RE.test(e.discord)) throw new Error(`has an invalid Discord user ID for ${name} (a long number)`); entry.discord = String(e.discord); }
      const aka = (Array.isArray(e.aka) ? e.aka : String(e.aka || '').split(',')).map((a) => String(a).trim()).filter(Boolean);
      if (aka.length) entry.aka = aka.slice(0, 8);
      if (e.nudge === false) entry.nudge = false;
      return entry;
    });
  }
  return JSON.stringify(out);
}

/* ---------------------------------------------------------------- fields */
// Every field the page can set.
//   group: which card on /settings      sub: sub-heading inside the card
//   role: the seat it belongs to        widget: a friendlier control on the page
//   unit: 'day' (a count per day), 'pct' or 'money'
const kpi = (key, sub, role, label, placeholder, max, unit = 'day', help = '') => ({
  key, group: 'targets', sub, role, label, unit, placeholder: String(placeholder), help, clean: targetNumber(max),
});

const FIELDS = [
  { key: 'ROSTER_JSON', group: 'team', widget: 'roster', label: 'People', clean: rosterJSON },

  kpi('KPI_SETTER_MESSAGES', 'Setters', 'setter', 'Messages sent', 50, 100000),
  kpi('KPI_SETTER_OUTBOUNDS', 'Setters', 'setter', 'Outbounds', 30, 100000),
  kpi('KPI_SETTER_CALLS_BOOKED', 'Setters', 'setter', 'Calls booked', 3, 10000),
  kpi('KPI_TRIAGE_CALLS', 'Triage', 'triage', 'Calls taken', 5, 10000),
  kpi('KPI_TRIAGE_SHOW_RATE', 'Triage', 'triage', 'Show rate', 70, 100, 'pct'),
  kpi('KPI_TRIAGE_QUALIFIED_RATE', 'Triage', 'triage', 'Qualified rate', 65, 100, 'pct', 'of calls that showed'),
  kpi('KPI_CLOSER_CALLS', 'Closers', 'closer', 'Calls taken', 5, 10000),
  kpi('KPI_CLOSER_SHOW_RATE', 'Closers', 'closer', 'Show rate', 70, 100, 'pct'),
  kpi('KPI_CLOSER_CLOSE_RATE', 'Closers', 'closer', 'Close rate', 35, 100, 'pct', 'of calls that showed'),
  kpi('KPI_CLOSER_REVENUE', 'Closers', 'closer', 'Cash collected', 0, 100000000, 'money', '0 = none'),

  { key: 'REMINDERS', group: 'reminders', sub: 'Remind people who haven’t filed', widget: 'toggle', label: 'Send reminders', clean: onOff },
  { key: 'NUDGE_HOUR', group: 'reminders', sub: 'Remind people who haven’t filed', widget: 'hour', label: 'At', placeholder: '20', clean: hour },
  { key: 'NUDGE_DAYS', group: 'reminders', sub: 'Remind people who haven’t filed', widget: 'days', label: 'On these days', placeholder: '1,2,3,4,5', clean: dayList },
  { key: 'NUDGE_ROLES', group: 'reminders', sub: 'Remind people who haven’t filed', widget: 'roles', label: 'Remind these seats', clean: roleList },
  { key: 'SCORECARD_POST', group: 'reminders', sub: 'Post the daily digest', widget: 'toggle', label: 'Post the digest', clean: onOff },
  { key: 'SCORECARD_HOUR', group: 'reminders', sub: 'Post the daily digest', widget: 'hour', label: 'At', placeholder: '21',
    help: 'A morning time sums up yesterday. Midday or later sums up today.', clean: hour },

  { key: 'TIMEZONE', group: 'reminders', sub: 'Clock', widget: 'timezone', label: 'Timezone', placeholder: 'Europe/London',
    help: 'Decides what counts as “today” and when the reminders and the digest go out.',
    clean: (v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); } catch { throw new Error('is not a valid timezone (e.g. Europe/London)'); } return v; } },
];

const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const MAX_VALUE_LENGTH = 8000;

/* ------------------------------------------------------------ encryption */

const storeSecret = () => process.env.SETTINGS_SECRET || process.env.ADMIN_PASSWORD || process.env.ACCESS_PASSWORD || '';
const adminConfigured = () => Boolean(process.env.ADMIN_PASSWORD || process.env.ACCESS_PASSWORD);

function cryptoKey() {
  const secret = storeSecret();
  if (!secret) throw new Error('No encryption secret is set');
  return crypto.scryptSync(secret, 'eod-journey-settings-v1', 32);
}

function encrypt(obj) {
  // Open mode: no secret to encrypt with, so keep plain JSON (marked v0).
  if (!storeSecret()) return 'v0:' + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

function decrypt(blob) {
  const [version, iv, tag, body] = String(blob).split(':');
  if (version === 'v0' && iv) return JSON.parse(Buffer.from(iv, 'base64').toString('utf8'));
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('unrecognised settings format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', cryptoKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    // GCM auth failure = the secret changed since these were saved.
    throw new Error('Saved settings could not be decrypted. ADMIN_PASSWORD, ACCESS_PASSWORD or SETTINGS_SECRET has changed (or been removed) since they were saved.');
  }
}

/* -------------------------------------------------------------- backends */

const KV_KEY = process.env.SETTINGS_KV_KEY || 'eod-journey:settings';
const DATA_DIR = path.join(process.cwd(), '.data');

function kvCreds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

// 'kv' on Vercel with Upstash attached, 'file' for local preview, 'none' when a
// deployed instance has nowhere durable to write.
function backend() {
  if (kvCreds()) return 'kv';
  if (!process.env.VERCEL) return 'file';
  return 'none';
}

async function kvCommand(command) {
  const { url, token } = kvCreds();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) throw new Error(`settings store error: ${data.error || resp.status}`);
  return data.result;
}

// Settings live under the bare key; every other document (the logins) under its own name.
const kvName = (name) => (name === 'settings' ? KV_KEY : `${KV_KEY}:${name}`);
const docFile = (name) => path.join(DATA_DIR, `${name}.json`);

async function readDoc(name) {
  const b = backend();
  let blob = null;
  if (b === 'kv') blob = await kvCommand(['GET', kvName(name)]);
  else if (b === 'file') { try { blob = fs.readFileSync(docFile(name), 'utf8').trim() || null; } catch { blob = null; } }
  return blob ? decrypt(blob) : null;
}

async function writeDoc(name, obj) {
  const b = backend();
  const blob = encrypt(obj);
  if (b === 'kv') return kvCommand(['SET', kvName(name), blob]);
  if (b === 'file') {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(docFile(name), blob, { mode: 0o600 });
    return;
  }
  throw new Error('No storage connected');
}

/* ------------------------------------------- once-a-day marker for the jobs */
// The schedule calls in every hour and a host may fire a call a little early or
// late, so two calls can land in the same local hour. First caller for a key wins.
// With no storage connected there is nothing to remember, so the job just runs.
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
async function firstRun(key) {
  try {
    const b = backend();
    if (b === 'kv') return (await kvCommand(['SET', `${KV_KEY}:run:${key}`, '1', 'NX', 'EX', '172800'])) === 'OK';
    if (b === 'file') {
      let runs = {};
      try { runs = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')); } catch { /* first run */ }
      if (runs[key]) return false;
      const cutoff = Date.now() - 172800000;
      for (const k of Object.keys(runs)) if (runs[k] < cutoff) delete runs[k];
      runs[key] = Date.now();
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(RUNS_FILE, JSON.stringify(runs));
    }
    return true;
  } catch (e) {
    console.error('[store] firstRun failed, running anyway:', e.message);
    return true;
  }
}

/* ------------------------------------------------------------ load / save */
// Warm instances reuse the last read for a short while so normal traffic does not
// pay a store round-trip per request. A save reaches the others within CACHE_MS.
const CACHE_MS = 30000;
let cache = null;       // { values, at }

async function loadSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.values;
  let values = {};
  if (backend() !== 'none') values = (await readDoc('settings')) || {};
  cache = { values, at: Date.now() };
  return values;
}

// values: { KEY: 'new value' }  (blank strings are ignored, "leave as is")
// clear:  [ 'KEY', … ]          (remove the saved value, falling back to the default)
// Throws an Error carrying .fields = { KEY: message } when validation fails.
async function saveSettings({ values = {}, clear = [] }) {
  const errors = {};
  const next = { ...(await loadSettings({ fresh: true })) };

  for (const key of clear) if (FIELD_BY_KEY[key]) delete next[key];
  for (const [key, raw] of Object.entries(values)) {
    const field = FIELD_BY_KEY[key];
    if (!field || typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;
    if (value.length > MAX_VALUE_LENGTH) { errors[key] = `${field.label} is too long`; continue; }
    try { next[key] = field.clean ? field.clean(value) : value; }
    catch (e) { errors[key] = `${field.label} ${e.message}`; }
  }

  if (Object.keys(errors).length) {
    const err = new Error('Some fields need fixing');
    err.fields = errors;
    throw err;
  }
  await writeDoc('settings', next);
  cache = { values: next, at: Date.now() };
  return next;
}

// What the page is allowed to see. Nothing here is a secret.
function describe(saved) {
  return FIELDS.map((f) => ({
    key: f.key, group: f.group, label: f.label,
    placeholder: f.placeholder || '', help: f.help || '', role: f.role || '',
    sub: f.sub || '', widget: f.widget || '', unit: f.unit || '',
    source: saved[f.key] ? 'saved' : 'default',
  }));
}

module.exports = {
  FIELDS, ROLES,
  adminConfigured, backend,
  loadSettings, saveSettings, describe, firstRun, readDoc, writeDoc,
};
