// The EOD settings in force right now: the team, the daily targets, and when the
// reminder and the digest go out.
//
// journey.config.json holds the defaults; anything saved on /settings (lib/store.js)
// is layered over them once per request by the API entry. Every module holds a
// reference to the one `live` object and reads it at call time, so apply() can swap
// values in place without anyone re-requiring.

const CFG = require('../journey.config.json');
const STORE = require('./store');

const ROLES = STORE.ROLES;
const E = CFG.eod || {};

// '$', '£', '€' and so on, from journey.config.json -> business.currency.
function currencySymbol() {
  const B = CFG.business || {};
  try {
    const part = new Intl.NumberFormat(B.locale || 'en-US', { style: 'currency', currency: B.currency || 'USD' })
      .formatToParts(0).find((p) => p.type === 'currency');
    return part ? part.value : '$';
  } catch (e) { return '$'; }
}

const csv = (v, fallback) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : fallback);
const parseJSON = (v, fallback) => { if (!v) return fallback; try { return JSON.parse(v); } catch { return fallback; } };

// A target: the saved value if given (0 = "no target for this one"), else the default.
function target(v, fallback) {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// The config file lists the team flat ({name, role, discord, aka}); /settings saves
// it grouped by seat. Either way it comes out grouped, with nudge defaulting on.
function parseRoster(raw) {
  const grouped = raw || Object.fromEntries(ROLES.map((r) => [r, (E.team || []).filter((t) => t.role === r)]));
  const out = {};
  for (const role of ROLES) {
    out[role] = (Array.isArray(grouped[role]) ? grouped[role] : [])
      .map((p) => (typeof p === 'string' ? { name: p } : p))
      .filter((p) => p && p.name)
      .map((p) => ({
        name: String(p.name).trim(), role,
        discord: p.discord ? String(p.discord).trim() : '',
        aka: Array.isArray(p.aka) ? p.aka.map(String) : [],
        nudge: p.nudge !== false,
      }));
  }
  return out;
}

function build(env) {
  const roster = parseRoster(parseJSON(env.ROSTER_JSON, null));
  return {
    roles: ROLES,
    timezone: env.TIMEZONE || E.timezone || 'Europe/London',
    currency_symbol: currencySymbol(),
    roster,
    team: ROLES.flatMap((r) => roster[r]),

    // Daily targets, the bars on the scorecard. 0 = no target.
    targets: {
      setter: {
        messages:     target(env.KPI_SETTER_MESSAGES, 50),
        outbounds:    target(env.KPI_SETTER_OUTBOUNDS, 30),
        calls_booked: target(env.KPI_SETTER_CALLS_BOOKED, 3),
      },
      triage: {
        calls:          target(env.KPI_TRIAGE_CALLS, 5),
        show_rate:      target(env.KPI_TRIAGE_SHOW_RATE, 70),
        qualified_rate: target(env.KPI_TRIAGE_QUALIFIED_RATE, 65),
      },
      closer: {
        calls:      target(env.KPI_CLOSER_CALLS, 5),
        show_rate:  target(env.KPI_CLOSER_SHOW_RATE, 70),
        close_rate: target(env.KPI_CLOSER_CLOSE_RATE, 35),
        revenue:    target(env.KPI_CLOSER_REVENUE, 0),
      },
    },

    // Missed-report reminder, posted in each seat's own EOD channel.
    nudge: {
      enabled: String(env.REMINDERS || 'on').toLowerCase() !== 'off',
      hour: Number(env.NUDGE_HOUR || 20),
      days: csv(env.NUDGE_DAYS, ['1', '2', '3', '4', '5']).map(Number),
      roles: csv(env.NUDGE_ROLES, ROLES).map((r) => r.toLowerCase()).filter((r) => ROLES.includes(r)),
    },

    // The daily digest to daily-standup. Before noon it covers YESTERDAY (a morning
    // recap); from noon on it covers today.
    scorecard: {
      enabled: String(env.SCORECARD_POST || 'on').toLowerCase() !== 'off',
      hour: Number(env.SCORECARD_HOUR || (E.digest_hour ?? 21)),
    },
  };
}

const live = build({});

/** Re-derive the live settings with saved values layered over the defaults. */
function apply(overrides) {
  Object.assign(live, build(overrides || {}));
  return live;
}

/** Load whatever is saved and apply it. A broken store falls back to the defaults. */
async function refresh({ fresh = false } = {}) {
  try { apply(await STORE.loadSettings({ fresh })); }
  catch (e) { console.error('[live] settings load failed, using defaults:', e.message); }
  return live;
}

function teamMember(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return live.team.find((t) => t.name.toLowerCase() === n || t.aka.some((a) => a.toLowerCase() === n)) || null;
}

function localNow(d = new Date()) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: live.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short',
  }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

// What is actually in force for every setting, defaults included, so /settings shows
// the real state instead of an empty box that silently means "default".
function effective() {
  const t = live.targets;
  const strip = (p) => ({ name: p.name, ...(p.discord ? { discord: p.discord } : {}), ...(p.aka.length ? { aka: p.aka } : {}), ...(p.nudge ? {} : { nudge: false }) });
  return {
    ROSTER_JSON: JSON.stringify(Object.fromEntries(ROLES.map((r) => [r, live.roster[r].map(strip)]))),
    KPI_SETTER_MESSAGES: t.setter.messages, KPI_SETTER_OUTBOUNDS: t.setter.outbounds,
    KPI_SETTER_CALLS_BOOKED: t.setter.calls_booked,
    KPI_TRIAGE_CALLS: t.triage.calls, KPI_TRIAGE_SHOW_RATE: t.triage.show_rate, KPI_TRIAGE_QUALIFIED_RATE: t.triage.qualified_rate,
    KPI_CLOSER_CALLS: t.closer.calls, KPI_CLOSER_SHOW_RATE: t.closer.show_rate,
    KPI_CLOSER_CLOSE_RATE: t.closer.close_rate, KPI_CLOSER_REVENUE: t.closer.revenue,
    REMINDERS: live.nudge.enabled ? 'on' : 'off', NUDGE_HOUR: live.nudge.hour,
    NUDGE_DAYS: live.nudge.days.join(','), NUDGE_ROLES: live.nudge.roles.join(','),
    SCORECARD_POST: live.scorecard.enabled ? 'on' : 'off', SCORECARD_HOUR: live.scorecard.hour,
    TIMEZONE: live.timezone,
  };
}

/* ------------------------------------------------ the /settings handlers */

function view(saved) {
  apply(saved);
  return {
    status: 'ok',
    storage: STORE.backend(),
    roles: ROLES,
    effective: Object.fromEntries(Object.entries(effective()).map(([k, v]) => [k, String(v)])),
    fields: STORE.describe(saved),
    channels: E.discord || {},
  };
}

async function getSettings() {
  return view(await STORE.loadSettings({ fresh: true }));
}

async function postSettings(body) {
  if (STORE.backend() === 'none') {
    return { code: 503, body: { status: 'error', reason: 'no_storage',
      message: 'No storage connected. Attach the Upstash Redis integration to this Vercel project, then redeploy.' } };
  }
  try {
    const saved = await STORE.saveSettings({
      values: body.values && typeof body.values === 'object' ? body.values : {},
      clear: Array.isArray(body.clear) ? body.clear : [],
    });
    return { code: 200, body: view(saved) };
  } catch (e) {
    if (e.fields) return { code: 400, body: { status: 'invalid', message: e.message, fields: e.fields } };
    throw e;
  }
}

// What a signed-in page may know. Names only, the Discord IDs stay server-side.
function publicConfig() {
  return {
    roles: ROLES,
    timezone: live.timezone,
    currency_symbol: live.currency_symbol,
    roster: Object.fromEntries(ROLES.map((r) => [r, live.roster[r].map((p) => p.name)])),
    targets: live.targets,
    pathways: E.pathways || [],
    lead_sources: CFG.lead_sources || [],
    currency: (CFG.business || {}).currency || 'USD',
    locale: (CFG.business || {}).locale || 'en-US',
    budget_bands: E.budget_bands || [],
  };
}

module.exports = { live, ROLES, apply, refresh, teamMember, localNow, effective, getSettings, postSettings, publicConfig };
