// The scheduled jobs: the missed-report reminder, the daily digest to
// daily-standup with the "This week" table on the 📝 EOD Reports page, and the
// daily journey recompute.
//
// The schedule (vercel.json) calls in once every hour and each job only acts
// when the LOCAL hour is its own, so the times and the timezone are ordinary
// settings on /settings and survive the clocks changing. A once-a-day marker
// in the store stops a double post.

const CFG = require('../journey.config.json');
const STATE = require('./state');
const N = require('./notion');
const J = require('./journey');
const D = require('./discord');
const EOD = require('./eod');
const LIVE = require('./live');
const SC = require('./scorecard');
const { firstRun } = require('./store');

const localParts = LIVE.localNow;

const shift = (ymd, days) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

// Triage and closing are often one person. A seat they took no calls in is not
// a line of zeros: it is dropped when their other seat has calls, and a sign-off
// under either seat counts for both. With no calls in either, one line stays.
function oneLinePerCaller(rows) {
  const CALL = EOD.CALL_SEATS;
  const mates = (r) => rows.filter((x) => x !== r && CALL.includes(x.role) && CALL.includes(r.role) && x.rep.toLowerCase() === r.rep.toLowerCase());
  const signed = new Map(rows.map((r) => [r, r.signed || mates(r).some((x) => x.signed)]));
  const kpis = new Map(rows.map((r) => [r, r.hit_kpis || (mates(r).find((x) => x.hit_kpis) || {}).hit_kpis || null]));
  return rows
    .filter((r) => r.calls || !CALL.includes(r.role) || !mates(r).some((x) => x.calls || (r.role === 'closer' && x.role === 'triage')))
    .map((r) => ({ ...r, signed: signed.get(r), hit_kpis: kpis.get(r) }));
}

/** Per-rep rows for one day: filed reports joined with sign-offs. */
async function dayRows(date) {
  const reports = await EOD.reportsBetween(date, date);
  const signoffs = await EOD.signoffsBetween(date, date);
  const key = (rep, role) => `${rep.toLowerCase()}|${role}`;
  const rows = new Map();
  for (const r of reports) {
    if (!r.rep) continue;
    const k = key(r.rep, r.role);
    if (!rows.has(k)) rows.set(k, { rep: r.rep, role: r.role, list: [], signed: false, hit_kpis: null });
    rows.get(k).list.push(r);
  }
  for (const so of signoffs) {
    const k = key(so.rep, so.role);
    if (!rows.has(k)) rows.set(k, { rep: so.rep, role: so.role, list: [], signed: false, hit_kpis: null });
    const row = rows.get(k);
    row.signed = true; row.hit_kpis = so.hit_kpis; row.messages = so.messages; row.no_calls = so.no_calls;
    row.bookedSigned = so.booked;
  }
  const out = [...rows.values()].map((r) => {
    const t = EOD.tally(r.list);
    return { ...r, ...t, booked: r.role === 'setter' ? (r.bookedSigned || t.booked) : t.booked, calls: r.list.length };
  });
  const order = { setter: 0, triage: 1, closer: 2 };
  out.sort((a, b) => (order[a.role] - order[b.role]) || a.rep.localeCompare(b.rep));
  const totals = EOD.tally(reports);
  const filedBy = new Set(out.map((r) => r.rep.toLowerCase()));
  const shown = oneLinePerCaller(out);
  // Someone holding two seats is on the list twice; chase them once.
  const missing = LIVE.live.team.filter((t, i, all) => !filedBy.has(t.name.toLowerCase()) && all.findIndex((x) => x.name === t.name) === i);
  return { date, rows: shown, totals, missing, reports, signoffs };
}

/** Post the digest for `date` (default: today in London). */
async function postDigest({ date, base } = {}) {
  const d = date || localParts().date;
  const data = await dayRows(d);
  const notionUrl = STATE.eod_page ? `https://www.notion.so/${STATE.eod_page.replace(/-/g, '')}` : null;
  // How each rep did against the daily targets; a failure here must not stop the post.
  const status = await SC.statusFor(d).catch((e) => { console.error('[digest] status', e.message); return {}; });
  // The reminder has already pinged whoever is missing, so the digest only names them.
  const ping = !LIVE.live.nudge.enabled;
  const msg = await D.post(CFG.eod?.discord?.digest, D.digestCard({ ...data, base, notionUrl, status, ping, hour: LIVE.live.scorecard.hour }));
  return { date: d, posted: !!msg, url: msg?.url || null, reps: data.rows.length, missing: data.missing.map((m) => m.name) };
}

/* ------------------------------------------------ the Notion "This week" table */

const rt = (t) => [{ type: 'text', text: { content: String(t ?? '').slice(0, 200) } }];
const money = (n) => (n ? `$${Math.round(n).toLocaleString('en-US')}` : '—');

async function weekTable({ base } = {}) {
  if (!STATE.eod_page || !STATE.eod_week_anchor) return { skipped: 'no page' };
  const today = localParts().date;
  const since = shift(today, -6);
  const reports = await EOD.reportsBetween(since, today);
  const signoffs = await EOD.signoffsBetween(since, today);

  const byRep = new Map();
  for (const r of reports) {
    if (!r.rep) continue;
    const k = `${r.rep}|${r.role}`;
    if (!byRep.has(k)) byRep.set(k, { rep: r.rep, role: r.role, list: [], days: new Set() });
    byRep.get(k).list.push(r);
  }
  for (const so of signoffs) {
    const k = `${so.rep}|${so.role}`;
    if (!byRep.has(k)) byRep.set(k, { rep: so.rep, role: so.role, list: [], days: new Set() });
    byRep.get(k).days.add(so.date);
  }
  // One person, two call seats: a day signed under either counts for both, and a seat with no calls all week is left out.
  const CALL = EOD.CALL_SEATS;
  const all = [...byRep.values()];
  for (const r of all) r.signoffs = new Set(all.filter((x) => x.rep === r.rep && (x === r || (CALL.includes(x.role) && CALL.includes(r.role)))).flatMap((x) => [...x.days])).size;
  for (const [k, r] of byRep) if (!r.list.length && CALL.includes(r.role) && all.some((x) => x !== r && x.rep === r.rep && CALL.includes(x.role) && x.list.length)) byRep.delete(k);
  const order = { setter: 0, triage: 1, closer: 2 };
  const rows = [...byRep.values()].sort((a, b) => (order[a.role] - order[b.role]) || a.rep.localeCompare(b.rep));

  const header = ['Rep', 'Role', 'Calls', 'Showed', 'Won / booked', 'Cash', 'Sign-offs'];
  const body = rows.length ? rows.map((r) => {
    const t = EOD.tally(r.list);
    const wonOrBooked = r.role === 'closer' ? `${t.won} won` : r.role === 'triage' ? `${t.closing_booked} closing booked` : `${t.booked} booked`;
    return [r.rep, EOD.ROLE_LABEL[r.role], String(r.role === 'setter' ? t.calls : t.scheduled), String(t.showed), wonOrBooked, money(t.cash), `${r.signoffs} / 7`];
  }) : [[`No reports filed between ${since} and ${today}`, '', '', '', '', '', '']];

  const table = {
    object: 'block', type: 'table',
    table: { table_width: 7, has_column_header: true, has_row_header: false, children: [
      { object: 'block', type: 'table_row', table_row: { cells: header.map(rt) } },
      ...body.map((cells) => ({ object: 'block', type: 'table_row', table_row: { cells: cells.map(rt) } })),
    ] },
  };

  // Replace whatever table currently sits under the anchor paragraph.
  const kids = await N.notion('GET', `/blocks/${STATE.eod_page}/children?page_size=100`);
  const list = kids.results || [];
  const i = list.findIndex((b) => b.id.replace(/-/g, '') === STATE.eod_week_anchor.replace(/-/g, ''));
  const old = i > -1 && list[i + 1]?.type === 'table' ? list[i + 1] : null;
  await N.notion('PATCH', `/blocks/${STATE.eod_page}/children`, { after: STATE.eod_week_anchor, children: [table] });
  if (old) await N.notion('DELETE', `/blocks/${old.id}`).catch(() => {});
  return { since, until: today, reps: rows.length };
}

/* ------------------------------------------------------------------ cron */

const RECOMPUTE_HOUR = 21;

/** The digest job: posts at the digest hour. A morning hour recaps yesterday. */
async function runDigest({ base, force = false, dry = false, date } = {}) {
  const now = localParts();
  const { enabled, hour: at } = LIVE.live.scorecard;
  if (!force && !enabled) return { skipped: 'the digest is switched off' };
  if (!force && now.hour !== at) return { skipped: `local hour is ${now.hour}, digest posts at ${at}` };
  const day = date || (at < 12 ? SC.shiftDate(now.date, -1) : now.date);
  if (dry) { const d = await dayRows(day); return { date: day, dry: true, reps: d.rows.length, missing: d.missing.map((m) => m.name) }; }
  if (!force && !(await firstRun(`digest:${day}`))) return { skipped: 'already posted', date: day };
  const out = {};
  try { out.digest = await postDigest({ date: day, base }); }
  catch (e) { out.digest = { error: e.message }; await log(`digest failed: ${e.message}`); }
  try { out.week = await weekTable({ base }); }
  catch (e) { out.week = { error: e.message }; await log(`week table failed: ${e.message}`); }
  return out;
}

/** Called every hour: runs whichever job is due in this local hour. */
async function cron({ base, query = {} } = {}) {
  const now = localParts();
  const out = { local: now };
  try { out.nudge = await SC.runNudge(query, base); }
  catch (e) { out.nudge = { error: e.message }; await log(`reminder failed: ${e.message}`); }
  out.digest = await runDigest({ base, force: query.force === '1', dry: query.dry === '1', date: query.date });
  if (query.dry !== '1' && (query.force === '1' || (now.hour === RECOMPUTE_HOUR && await firstRun(`recompute:${now.date}`)))) {
    try { out.recompute = await J.recompute({}); }
    catch (e) { out.recompute = { error: e.message }; }
  }
  return out;
}

/** The old nightly entry point: the digest (now, with force) and the recompute. */
async function nightly({ base, force = false, date } = {}) {
  const out = { local: localParts(), ...(await runDigest({ base, force, date })) };
  try { out.recompute = await J.recompute({}); }
  catch (e) { out.recompute = { error: e.message }; }
  return out;
}

async function log(text) {
  try { await D.post(CFG.eod?.discord?.logs, { content: `⚙️ eod-journey · ${text}`.slice(0, 1900), allowed_mentions: { parse: [] } }); }
  catch (e) { console.error('[digest] log', e.message); }
}

module.exports = { cron, nightly, runDigest, postDigest, weekTable, dayRows, localParts };
