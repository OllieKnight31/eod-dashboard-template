// The website half: a row per visit, and how far that visitor got through
// the application.
//
// One Notion row per session rather than a daily counter, because a counter
// needs read-modify-write on every hit — which races, and burns the rate
// limit. A row per session is a single create, and counting is then a query.

const N = require('./notion');
const J = require('./journey');

const CHANNELS = ['Meta ads', 'Google ads', 'TikTok ads', 'Tagged link',
                  'Organic search', 'Organic social', 'Referral', 'Direct'];
// The site pages worth naming in Site Sessions; anything else is filed as 'other'.
// Set journey.config.json -> site_pages, and rerun scripts/05_sessions.py to match.
const PAGES = require('../journey.config.json').site_pages || ['/', '/apply', '/thank-you'];

// site.js stores channels like "Tagged link — meta" and "Referral — t.co";
// the select only carries the family, and the detail goes to Campaign.
function channelOf(raw) {
  const v = String(raw || '').trim();
  if (!v) return 'Direct';
  const hit = CHANNELS.find((c) => v === c || v.startsWith(c + ' —') || v.startsWith(c + ' -'));
  return hit || (CHANNELS.includes(v) ? v : 'Direct');
}
const pageOf = (p) => (PAGES.includes(p) ? p : 'other');
const clip = (s, n = 200) => String(s || '').slice(0, n);

function labelFor(b, when) {
  const t = new Date(when);
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  const day = t.toISOString().slice(5, 10);
  return `${day} ${hh}:${mm} · ${channelOf(b.channel)}`;
}

/** First hit of a session creates the row; later hits bump Pages and Last seen. */
async function recordView(b, meta = {}) {
  const now = new Date().toISOString();

  if (b.sid) {
    try {
      const page = await N.notion('GET', `/pages/${b.sid}`);
      const pages = (N.readProp(page, 'Pages') || 1) + 1;
      await N.updatePage(b.sid, N.DB.sessions, { 'Last seen': now, Pages: pages });
      return { sid: b.sid, pages };
    } catch (e) {
      // Stale id (row archived, or a new deployment) — fall through and open a new one.
    }
  }

  const row = await N.createPage(N.DB.sessions, {
    Session: labelFor(b, now),
    Started: now,
    'Last seen': now,
    Channel: channelOf(b.channel),
    'Landing page': pageOf(b.landing || b.path),
    Referrer: clip(b.ref, 300),
    Device: ['Desktop', 'Mobile', 'Tablet'].includes(b.device) ? b.device : null,
    Country: clip(meta.country, 8),
    Campaign: clip([b.campaign, /—|-/.test(b.channel || '') ? b.channel : ''].filter(Boolean).join(' · '), 200),
    Pages: 1,
    'Furthest step': 0,
    'Form started': false,
    Completed: false,
  });
  return { sid: row.id, pages: 1 };
}

/** Furthest step only ever goes up — a back button is not a retreat. */
async function recordStep(b) {
  if (!b.sid) return { skipped: 'no session' };
  let page;
  try { page = await N.notion('GET', `/pages/${b.sid}`); }
  catch (e) { return { skipped: 'unknown session' }; }

  const have = N.readProp(page, 'Furthest step') || 0;
  const step = Number(b.step) || 0;
  const patch = { 'Last seen': new Date().toISOString() };

  if (step > have) {
    patch['Furthest step'] = step;
    if (b.label) patch['Furthest question'] = clip(b.label, 120);
  }
  if (b.started && !N.readProp(page, 'Form started')) patch['Form started'] = true;
  if (b.completed && !N.readProp(page, 'Completed')) patch['Completed'] = true;
  if (b.email && !N.readProp(page, 'Email') && /.+@.+\..+/.test(b.email)) {
    patch.Email = String(b.email).trim().toLowerCase();
  }

  await N.updatePage(b.sid, N.DB.sessions, patch);
  return { step: Math.max(step, have) };
}

/**
 * Traffic and application drop-off over a window.
 * Returns null when no sessions exist yet, so the dashboard can say so
 * rather than draw an empty chart.
 */
async function summary({ since = null } = {}) {
  if (!N.DB.sessions) return null;
  const filter = since ? { property: 'Started', date: { on_or_after: since } } : null;
  let rows;
  try { rows = await N.queryAll(N.DB.sessions, filter, [{ property: 'Started', direction: 'descending' }], 3000); }
  catch (e) { return null; }
  if (!rows.length) return null;

  const now = Date.now();
  const since24 = now - 86400000;
  const since1h = now - 3600000;

  const byChannel = new Map();
  const byLanding = new Map();
  const steps = new Map();
  let started = 0, completed = 0, last24 = 0, lastHour = 0, live = 0;
  let deepest = 0;

  for (const r of rows) {
    const ch = N.readProp(r, 'Channel') || 'Direct';
    byChannel.set(ch, (byChannel.get(ch) || 0) + 1);
    const lp = N.readProp(r, 'Landing page') || 'other';
    byLanding.set(lp, (byLanding.get(lp) || 0) + 1);

    const t = new Date(N.readProp(r, 'Started') || 0).getTime();
    if (t >= since24) last24++;
    if (t >= since1h) lastHour++;
    const seen = new Date(N.readProp(r, 'Last seen') || 0).getTime();
    if (now - seen < 300000) live++;                    // active in the last 5 minutes

    if (N.readProp(r, 'Form started')) started++;
    if (N.readProp(r, 'Completed')) completed++;

    const s = N.readProp(r, 'Furthest step') || 0;
    if (s > deepest) deepest = s;
    steps.set(s, (steps.get(s) || 0) + 1);
  }

  // How many reached step n or beyond — the shape of the drop-off.
  const reached = [];
  for (let n = 1; n <= Math.max(deepest, 1); n++) {
    let c = 0;
    for (const [k, v] of steps) if (k >= n) c += v;
    reached.push({ step: n, reached: c });
  }

  const label = new Map();
  for (const r of rows) {
    const s = N.readProp(r, 'Furthest step') || 0;
    const l = N.readProp(r, 'Furthest question');
    if (s && l && !label.has(s)) label.set(s, l);
  }
  for (const r of reached) r.label = label.get(r.step) || `Question ${r.step}`;

  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

  return {
    sessions: rows.length, last24, lastHour, live, started, completed,
    channels: top(byChannel), landings: top(byLanding),
    reached, deepest,
    startRate: rows.length ? Math.round((started / rows.length) * 1000) / 10 : null,
    finishRate: started ? Math.round((completed / started) * 1000) / 10 : null,
  };
}

module.exports = { recordView, recordStep, summary, channelOf };
