// Client-journey and EOD service.
//
//   GET  /v/<slug>?c=<ghl contact id>   branded watch page (rewrite -> action=watch)
//   GET  /journey                       live funnel mirror  (rewrite -> action=dashboard)
//   GET  /reports                       the EOD dashboard    (rewrite -> action=reports)
//   POST /api?source=call_report        one call report (setter / triage / closer) -> row + lead + CRM stage + Discord
//   POST /api?source=signoff            the end-of-day sign-off -> row + Discord
//   GET  /api?action=board              what the form needs when it opens (calls due, filed today, names)
//   GET  /api?action=leads&q=           lead picker search
//   GET  /api?action=lead&c|e|l=        one lead, for a pre-linked form
//   GET  /api?action=scorecard_data     everyone against target (reps: only their own)
//   GET  /api?action=cron               hourly: reminder, digest + week table, recompute
//   GET  /api?action=nudge              the missed-report reminder on its own (&dry=1, &force=1)
//   GET  /api?action=nightly            the digest now (&force=1) + recompute
//   GET  /api?action=auth_state | me | config        sign-in state (open)
//   POST /api?source=auth_setup | auth_login | auth_logout | password
//   GET  /api?action=settings | users   owner only
//   POST /api?source=settings | user_save | user_delete   owner only
//
// With logins on, everything a person looks at or files needs a login (lib/auth.js);
// with logins off (no ADMIN_PASSWORD / ACCESS_PASSWORD) everyone is the owner. The watch
// pages, the trackers and the GHL webhooks stay open: leads and machines use them.
//   POST /api?source=closer_eod         legacy batch closer report -> call_report per block
//   POST /api?source=setter_eod         legacy setter EOD -> signoff
//   POST /api?source=vsl_event          watch-page beacon
//   POST /api?source=vsl_sent           GHL: "the asset email has gone out"
//   POST /api?source=ghl_stage          GHL stage change -> re-derive one lead
//   GET  /api?action=recompute          rebuild Funnel Health (cron, 4-hourly)
//   GET  /api?action=health             connectivity check

const CFG   = require('../journey.config.json');
const N     = require('../lib/notion');
const J     = require('../lib/journey');
const L     = require('../lib/leads');
const EOD   = require('../lib/eod');
const WATCH = require('../lib/watch');
const DASH  = require('../lib/dashboard');
const REPORTS = require('../lib/reports');
const DIGEST  = require('../lib/digest');
const REMINDERS = require('../lib/reminders');
const SITE  = require('../lib/site');
const LIVE  = require('../lib/live');
const AUTH  = require('../lib/auth');
const SC    = require('../lib/scorecard');
const BRAND = require('../lib/brand');

const SECRET = process.env.SYNC_SECRET || '';
const BASE = process.env.PUBLIC_BASE_URL || CFG.public_base || '';

const ASSET_BY_SLUG = new Map(CFG.assets.map((a) => [a.slug, a]));
const STAGE_OF_ASSET = (a) => CFG.stages.find((s) => s.key === a.stage_key);
// Which pair of columns an asset writes to. Stage 4 -> VSL 1, stage 6 -> VSL 2.
const COLS = (a) => (STAGE_OF_ASSET(a).no <= 4 ? { sent: 'VSL 1 Sent', view: 'VSL 1 Viewed', pct: 'VSL 1 Watch %' }
                                               : { sent: 'VSL 2 Sent', view: 'VSL 2 Viewed', pct: 'VSL 2 Watch %' });

function readBody(req) {
  if (req._b) return req._b;                      // already read (and scoped) by the sign-in gate
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

// Machine calls: the ops key, or Vercel's own cron. When CRON_SECRET is set Vercel sends it
// as a Bearer token and only that is accepted. With no CRON_SECRET (the out-of-the-box
// setup) the scheduled jobs are accepted from Vercel's cron caller, so reminders and the
// digest work without extra setup; the jobs only run once per local hour either way.
const vercelCron = (req) => !process.env.CRON_SECRET && Boolean(process.env.VERCEL)
  && /^vercel-cron\//.test(String(req.headers['user-agent'] || ''));
const authed = (url, req) =>
  (SECRET && url.searchParams.get('key') === SECRET) ||
  (req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` && !!process.env.CRON_SECRET);
const cronAuthed = (url, req) => authed(url, req) || vercelCron(req);

// The tracker runs on your website and posts here, so these endpoints
// answer cross-origin. Bodies arrive as text/plain on purpose: it is a
// CORS-simple content type, which is what lets sendBeacon through without a
// preflight it could never satisfy.
const TRACK_SOURCES = new Set(['site_view', 'form_step']);

// A handler result ({ code, body, cookie? }) -> the response.
function send(res, out) {
  if (out.cookie) res.setHeader('Set-Cookie', out.cookie);
  return res.status(out.code).json(out.body);
}
const denied = (res, user) => (user
  ? res.status(403).json({ status: 'forbidden', message: 'Your login doesn’t have access to this.' })
  : res.status(401).json({ status: 'unauthorized', message: 'Please sign in.' }));

// The server-rendered pages: signed out -> the login page (and back afterwards),
// signed in without access -> that role's home. Returns true when it has answered.
function pageGate(res, user, path, q) {
  if (AUTH.seesDashboards(user)) return false;
  const rest = new URLSearchParams(Object.entries(q).filter(([k]) => k !== 'action')).toString();
  const to = user ? AUTH.homeOf(user) : `/login?next=${encodeURIComponent(path + (rest ? `?${rest}` : ''))}`;
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(302, { Location: to }).end();
  return true;
}

// An outside form (GHL, Tally) holding the inbound key may file without a login.
const machine = (req) => Boolean(process.env.INBOUND_KEY) && req.headers.authorization === `Bearer ${process.env.INBOUND_KEY}`;

// The forms never pre-fill a date, so a report without a real one is refused rather than filed under today.
const validDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

module.exports = async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const q = Object.fromEntries(url.searchParams);
  const action = q.action || '';
  const source = q.source || '';
  const base = BASE || `https://${req.headers.host}`;

  if (TRACK_SOURCES.has(source) || req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }

  try {
    // Layer anything saved on /settings over the defaults, then work out who is asking.
    // Everything below is decided from this, never from what the page claims.
    await LIVE.refresh();
    let user = null;
    try { user = await AUTH.currentUser(req); }
    catch (e) { console.error('[journey] could not read logins:', e.message); }
    // The ops key (&key=$SYNC_SECRET) stands in for a manager, so the e2e test and
    // scripts can read and file without a person's password.
    if (!user && authed(url, req)) user = { id: 'ops', name: 'Ops key', username: 'ops', role: 'manager' };

    /* -------------------------------------------------------------- sign-in */
    if (action === 'auth_state') { res.setHeader('Cache-Control', 'no-store'); return send(res, await AUTH.authState()); }
    if (action === 'me')         { res.setHeader('Cache-Control', 'no-store'); return send(res, AUTH.me(user)); }
    // Signed out, the only thing a page may know is how to brand the login screen.
    if (action === 'config') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ status: 'ok', brand: BRAND.brandInfo(), ...(user ? LIVE.publicConfig() : {}) });
    }
    if (source === 'auth_setup')  return send(res, await AUTH.setup(readBody(req), req));
    if (source === 'auth_login')  return send(res, await AUTH.login(readBody(req), req));
    if (source === 'auth_logout') return send(res, AUTH.logout());
    if (source === 'password') {
      if (!user) return denied(res, user);
      return send(res, await AUTH.changePassword(readBody(req), user));
    }

    /* ------------------------------------------------- settings and logins */
    if (action === 'settings' || action === 'users') {
      res.setHeader('Cache-Control', 'no-store');
      if (!AUTH.isOwner(user)) return denied(res, user);
      return action === 'settings' ? res.status(200).json(await LIVE.getSettings()) : send(res, await AUTH.listUsers());
    }
    if (['settings', 'user_save', 'user_delete'].includes(source)) {
      if (!AUTH.isOwner(user)) return denied(res, user);
      const b = readBody(req);
      if (source === 'user_save')   return send(res, await AUTH.saveUser(b, user));
      if (source === 'user_delete') return send(res, await AUTH.deleteUser(b, user));
      return send(res, await LIVE.postSettings(b));
    }

    /* ------------------------------------------------------------ scorecard */
    if (action === 'scorecard_data') {
      res.setHeader('Cache-Control', 'no-store');
      if (!user) return denied(res, user);
      const card = await SC.getScorecard(AUTH.scopeQuery(user, q));
      // a rep's filters would only ever hold their own name
      if (AUTH.isRep(user)) { card.people = { [user.role]: [AUTH.repName(user)] }; card.all_roles = [user.role]; }
      return res.status(200).json(card);
    }

    /* ------------------------------------------------------- scheduled jobs */
    if (action === 'cron' || action === 'nudge') {
      if (!cronAuthed(url, req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const jq = authed(url, req) ? q : {};        // the plain cron caller gets no force / dry switches
      const out = action === 'nudge' ? await SC.runNudge(jq, base) : await DIGEST.cron({ base, query: jq });
      return res.status(200).json({ ok: true, ...out });
    }

    /* ---------------------------------------------------------- watch page */
    if (action === 'watch') {
      const asset = ASSET_BY_SLUG.get(q.slug);
      if (!asset) { res.status(404).send('Unknown asset'); return; }

      // Notion is the live record for the video URL and copy — the config is
      // only the seed, so pasting a URL into the table is enough to go live.
      const live = await assetFromNotion(asset.slug).catch(() => null);
      const token = L.tokenFrom(q);
      const row = token ? await L.resolve(token) : null;

      if (row) await noteOpen(row, asset).catch(() => {});

      const stage = STAGE_OF_ASSET(asset);
      const next = stage.no <= 4
        ? { label: 'Your call is the next step',
            note: 'If it is not already in the diary, put it there. The call is a conversation about fit — both directions.',
            cta: 'Book the call',
            url: row ? (N.readProp(row, 'Calendly Link') || CFG.booking_url || '') : (CFG.booking_url || '') }
        : { label: 'Ready when you are',
            note: 'When you have watched this, tell your contact and we will move to the closing conversation.',
            cta: 'Book the closing call',
            url: row ? (N.readProp(row, 'Calendly Link') || CFG.closing_booking_url || '') : (CFG.closing_booking_url || '') };
      if (!next.url) delete next.url;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(WATCH.page({
        asset: {
          slug: asset.slug,
          title: live?.title || asset.title,
          kicker: live?.kicker || asset.kicker,
          blurb: live?.blurb || asset.blurb,
          duration: live?.duration || asset.duration_hint,
          videoUrl: live?.videoUrl || asset.video_url || '',
        },
        lead: row ? { firstName: L.firstNameOf(row), id: row.id } : null,
        next, token,
      }));
      return;
    }

    /* ----------------------------------------------------------- dashboard */
    if (action === 'dashboard') {
      if (pageGate(res, user, '/journey', q)) return;
      const data = await DASH.gather({ since: q.since === 'all' ? null : (q.since || CFG.cohort_start) });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).send(DASH.page(data, base));
      return;
    }

    /* -------------------------------------------------------- vsl beacons */
    if (source === 'vsl_event') {
      const b = readBody(req);
      const asset = ASSET_BY_SLUG.get(b.slug);
      if (!asset) return res.status(200).json({ ok: false, error: 'unknown slug' });
      const row = b.t ? await L.resolve(b.t) : null;
      const out = await recordEvent({ asset, row, event: b.event, pct: Number(b.pct) || 0 });
      return res.status(200).json({ ok: true, ...out });
    }

    if (source === 'vsl_sent') {
      const b = readBody(req);
      const asset = ASSET_BY_SLUG.get(b.slug);
      const row = await L.resolve(b.t || L.tokenFrom(b));
      if (!asset || !row) return res.status(200).json({ ok: false, error: 'need a known slug and lead' });
      const c = COLS(asset);
      if (!N.readProp(row, c.sent)) {
        await N.updatePage(row.id, N.DB.sales, { [c.sent]: J.day(new Date().toISOString()) });
        await bump(asset.slug, 'Sent');
      }
      return res.status(200).json({ ok: true, lead: row.id });
    }

    /* ----------------------------------------------------- EOD dashboard */
    if (action === 'reports') {
      if (pageGate(res, user, '/reports', q)) return;
      const data = await REPORTS.gather(q);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(REPORTS.page(data, base));
      return;
    }

    /* --------------------------------------------- the form's data calls */
    // The CRM behind the picker: names and emails, so signed-in people only.
    if (action === 'leads' || action === 'lead' || action === 'board') {
      if (!user) { res.setHeader('Cache-Control', 'no-store'); return denied(res, user); }
    }
    if (action === 'leads') {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await L.search(q.q || '');
      return res.status(200).json({ ok: true, leads: rows.map(EOD.leadView) });
    }
    if (action === 'lead') {
      res.setHeader('Cache-Control', 'no-store');
      const row = await L.resolve(L.tokenFrom(q));
      return res.status(200).json({ ok: !!row, lead: EOD.leadView(row) });
    }
    if (action === 'board') {
      res.setHeader('Cache-Control', 'no-store');
      const sq = AUTH.scopeQuery(user, q);          // a rep only ever gets their own seat
      const out = await EOD.board({ role: sq.role, rep: sq.rep, date: q.date || J.day(new Date().toISOString()) });
      return res.status(200).json({ ok: true, ...out });
    }

    /* ------------------------------------------------------ the reports */
    // A signed-in person filing their own, or an outside form holding INBOUND_KEY.
    if (['call_report', 'signoff', 'closer_eod', 'setter_eod'].includes(source) && !machine(req)) {
      if (!user) return denied(res, user);
      const b = readBody(req);
      if (source === 'setter_eod') b.role = 'setter';
      if (source === 'closer_eod' && AUTH.isRep(user) && user.role === 'setter') return res.status(403).json({ status: 'forbidden', message: 'You can only file your own report.' });
      const want = b.role;
      const access = AUTH.reportAccess(user, b);
      if (!access.ok) return res.status(403).json({ status: 'forbidden', message: access.message || 'You can’t file that report.' });
      if (AUTH.isRep(user)) {
        if (want && !AUTH.seatsOf(user).includes(String(want).toLowerCase())) return res.status(403).json({ status: 'forbidden', message: `Your login files ${AUTH.seatsOf(user).join(' and ')} reports only.` });
        if (source === 'closer_eod') b.closer = b.rep;
        if (source === 'setter_eod') b.setter = b.rep;
      }
      req._b = b;
    }
    if (source === 'call_report') {
      const b = readBody(req);
      const date = String(b.date || '');
      if (!validDay(date)) return res.status(200).json({ status: 'error', message: 'Choose the date this report covers.' });
      if (!b.outcome) return res.status(200).json({ status: 'error', message: 'An outcome is required.' });
      if (b.outcome === 'closed_won' && b.payment_type !== 'Paid in Full' && !(parseFloat(b.collection_amount) > 0 && validDay(String(b.collection_date || '')))) {
        return res.status(200).json({ status: 'error', message: 'Add the amount to collect and the collection date.' });
      }
      if (!(b.lead_id || b.prospect_name || b.prospect_email)) return res.status(200).json({ status: 'error', message: 'Pick the lead, or type their name.' });
      const out = await EOD.fileCall({ role: b.role, rep: b.rep || b.closer || b.setter, date, call: b, base });
      return res.status(200).json({ status: 'received', ...out });
    }

    if (source === 'signoff') {
      const b = readBody(req);
      const date = String(b.date || '');
      if (!validDay(date)) return res.status(200).json({ status: 'error', message: 'Choose the date this report covers.' });
      if (!b.rep) return res.status(200).json({ status: 'error', message: 'A name is required.' });
      const out = await EOD.fileSignoff({ role: b.role, rep: b.rep, date, p: b, base });
      // The Notion page promises its This week table refreshes when a sign-off lands.
      await DIGEST.weekTable({ base }).catch((e) => console.error('[signoff] week table', e.message));
      J.recompute({ writeLeads: false }).catch(() => {});
      return res.status(200).json({ status: 'received', ...out });
    }

    /* ---------------------------------------------------------- nightly */
    if (action === 'reminders') {
      if (!cronAuthed(url, req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const rq = authed(url, req) ? q : {};
      const out = await REMINDERS.run({ date: rq.date, force: rq.force === '1', dry: rq.dry === '1' });
      return res.status(200).json({ ok: true, ...out });
    }
    if (action === 'nightly') {
      if (!authed(url, req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const out = await DIGEST.nightly({ base, force: q.force === '1', date: q.date });
      return res.status(200).json({ ok: true, ...out });
    }
    if (action === 'week') {
      if (!authed(url, req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
      return res.status(200).json({ ok: true, ...(await DIGEST.weekTable({ base })) });
    }

    /* ---------------------------------------------------------- EOD ingest */
    if (source === 'closer_eod') {
      const b = readBody(req);
      const date = b.date || J.day(new Date().toISOString());
      const closer = (b.closer || '').trim();
      if (b.no_calls) {
        return res.status(200).json({ status: 'received', filed: 0, moved: 0, unmatched: [] });
      }
      const results = [];
      for (const call of b.calls || []) {
        results.push(await EOD.fileCall({ role: b.role || (call.call_type === 'closing' ? 'closer' : 'triage'), rep: closer, date, call, base }));
      }
      // A hobby-plan cron only runs daily, so the report that actually changes
      // the numbers refreshes them itself. Health-only: 9 writes, not 550.
      await J.recompute({ writeLeads: false }).catch(() => {});
      return res.status(200).json({
        status: 'received',
        filed: results.length,
        moved: results.filter((r) => r.moved).length,
        unmatched: results.filter((r) => !r.matched).map((r) => r.who).filter(Boolean),
      });
    }

    if (source === 'setter_eod') {
      const b = readBody(req);
      const out = await EOD.fileSignoff({ role: 'setter', rep: b.setter || b.rep, date: b.date || J.day(new Date().toISOString()), p: b, base });
      await J.recompute({ writeLeads: false }).catch(() => {});
      return res.status(200).json({ status: 'received', ...out });
    }

    /* ------------------------------------------------ the website */
    if (source === 'site_view') {
      const b = readBody(req);
      const out = await SITE.recordView(b, {
        country: req.headers['x-vercel-ip-country'] || '',
      });
      return res.status(200).json({ ok: true, ...out });
    }

    if (source === 'form_step') {
      const b = readBody(req);
      const out = await SITE.recordStep(b);
      return res.status(200).json({ ok: true, ...out });
    }

    /* -------------------------------------------------------- GHL webhook */
    if (source === 'ghl_stage') {
      const b = readBody(req);
      const row = await L.resolve(b.contact_id ? `c:${b.contact_id}` : (b.email ? `e:${L.b64url.enc(b.email)}` : ''));
      if (!row) return res.status(200).json({ ok: false, error: 'no matching lead' });
      const fresh = await N.notion('GET', `/pages/${row.id}`);
      const d = J.derive(fresh);
      await N.updatePage(row.id, N.DB.sales, {
        'Journey Stage': J.stageName(d),
        'Journey #': d.exited ? null : d.no,
        'Journey Updated': J.nowIso(),
        'Journey Source': 'ghl-stage',
      });
      return res.status(200).json({ ok: true, stage: J.stageName(d), why: d.why });
    }

    /* ---------------------------------------------------------- recompute */
    if (action === 'recompute') {
      if (!authed(url, req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const out = await J.recompute({ since: q.since === 'all' ? null : (q.since || undefined) });
      return res.status(200).json({ ok: true, ...out });
    }

    if (action === 'health') {
      if (!authed(url, req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const dbs = {};
      for (const [k, id] of Object.entries(N.DB)) {
        try { const d = await N.notion('GET', `/databases/${id}`); dbs[k] = d.title.map((t) => t.plain_text).join(''); }
        catch (e) { dbs[k] = `ERROR ${e.message.slice(0, 80)}`; }
      }
      return res.status(200).json({ ok: true, base, cohort: CFG.cohort_start, dbs });
    }

    return res.status(400).json({ ok: false, error: 'unknown action/source' });
  } catch (e) {
    console.error('[journey] fatal', e);
    // Webhook callers must never see a non-2xx: GHL retries and Notion disables.
    const soft = source && source !== '';
    return res.status(soft ? 200 : 500).json({ ok: false, error: e.message });
  }
};

/* ------------------------------------------------------------- helpers */

async function assetFromNotion(slug) {
  const rows = await N.queryAll(N.DB.assets, { property: 'Slug', rich_text: { equals: slug } }, null, 5);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    title: N.readProp(r, 'Asset'),
    kicker: N.readProp(r, 'Headline'),
    blurb: N.readProp(r, 'Blurb'),
    duration: N.readProp(r, 'Duration'),
    videoUrl: N.readProp(r, 'Video URL'),
  };
}

// Counters live on the asset row so the table reads as a funnel of its own.
async function bump(slug, field, by = 1) {
  const rows = await N.queryAll(N.DB.assets, { property: 'Slug', rich_text: { equals: slug } }, null, 5);
  const r = rows[0];
  if (!r) return;
  await N.updatePage(r.id, N.DB.assets, {
    [field]: (N.readProp(r, field) || 0) + by,
    'Last computed': J.nowIso(),
  });
}

async function noteOpen(row, asset) {
  const c = COLS(asset);
  const patch = {};
  // Without the vsl_sent webhook wired, an open is the only proof it was sent.
  if (!N.readProp(row, c.sent)) { patch[c.sent] = J.day(new Date().toISOString()); await bump(asset.slug, 'Sent'); }
  if (Object.keys(patch).length) await N.updatePage(row.id, N.DB.sales, patch);
}

async function recordEvent({ asset, row, event, pct }) {
  const c = COLS(asset);
  const stage = STAGE_OF_ASSET(asset);

  if (event === 'open') { await bump(asset.slug, 'Opened'); return { counted: 'open' }; }
  if (event === 'cta')  { return { counted: 'cta' }; }

  if (event === 'play') {
    await bump(asset.slug, 'Played');
    if (row) {
      // Playing is what proves the asset was seen — an open proves only a click.
      await J.advance(row, stage.no, 'vsl-tracking',
        N.readProp(row, c.view) ? {} : { [c.view]: J.day(new Date().toISOString()) });
    }
    return { counted: 'play', advanced: !!row };
  }

  if (event === 'complete') await bump(asset.slug, 'Completed');

  if (row && pct > 0) {
    const had = N.readProp(row, c.pct) || 0;
    if (pct > had) await N.updatePage(row.id, N.DB.sales, { [c.pct]: Math.round(pct) });
  }
  if (pct > 0) await avgWatch(asset.slug, pct);
  return { counted: event, pct };
}

// A running mean, so no per-view store is needed.
async function avgWatch(slug, pct) {
  const rows = await N.queryAll(N.DB.assets, { property: 'Slug', rich_text: { equals: slug } }, null, 5);
  const r = rows[0];
  if (!r) return;
  const played = N.readProp(r, 'Played') || 1;
  const cur = N.readProp(r, 'Avg watch %') || 0;
  const next = Math.round(((cur * (played - 1)) + pct) / played);
  await N.updatePage(r.id, N.DB.assets, { 'Avg watch %': next });
}
