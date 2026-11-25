#!/usr/bin/env node
/**
 * End-to-end test of the three-seat EOD report against the live deployment.
 *   node scripts/e2e_eod.js            create a sacrificial lead, file every report type, sign off
 *   node scripts/e2e_eod.js --cleanup  archive every row it made and delete its Discord posts
 * The lead is created by this script with its own unique email; nothing real is touched.
 * It has no GHL opportunity, so the CRM sync sees the stage writes and skips them.
 */
const N = require('../lib/notion');
const J = require('../lib/journey');
const D = require('../lib/discord');

const CFG = require('../journey.config.json');
const BASE = process.env.PUBLIC_BASE_URL || CFG.public_base;
if (!BASE) { console.error('Set PUBLIC_BASE_URL (or public_base in journey.config.json) to the deployed app.'); process.exit(1); }
// Test reps come from the team in journey.config.json: the first person in each seat.
const TEAM = (CFG.eod && CFG.eod.team) || [];
const first = (role, fallback) => (TEAM.find((t) => t.role === role) || {}).name || fallback;
const ALIAS_OF = (name) => ((TEAM.find((t) => t.name === name) || {}).aka || [])[0] || name;
const PACKAGE = ((CFG.eod && CFG.eod.pathways) || ['Option A'])[0];
const BUDGET = ((CFG.eod && CFG.eod.budget_bands) || ['Discuss on the call'])[0];
// Everything is behind a login now; the ops key stands in for a manager.
const KEY = encodeURIComponent(process.env.SYNC_SECRET || '');
const EMAIL = 'eod-e2e@example.test';
const NAME = '🧪 EOD Test Lead';
const REP = { setter: 'E2E Setter', triage: first('triage', 'Triage 1'), closer: first('closer', 'Closer 1') };
const today = J.day(new Date().toISOString());
const MADE = { reports: [], signoffs: [], discord: [] };

const post = async (source, body) => {
  const r = await fetch(`${BASE}/api?source=${source}&key=${KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (qs) => (await fetch(`${BASE}/api?${qs}&key=${KEY}`)).json();
const ok = (c, m, extra = '') => { console.log(`  ${c ? '✓' : '✗'} ${m}${extra ? '  ' + extra : ''}`); if (!c) process.exitCode = 1; };
const reread = (id) => N.notion('GET', `/pages/${id}`);
const track = (r) => { if (r.report) MADE.reports.push(r.report); if (r.signoff) MADE.signoffs.push(r.signoff); if (r.discord) MADE.discord.push(r.discord); };

async function cleanup() {
  const leads = await N.queryAll(N.DB.sales, { property: 'Email', email: { equals: EMAIL } });
  const reports = await N.queryAll(N.DB.eod, { property: 'Report', title: { contains: NAME } });
  const orphans = await N.queryAll(N.DB.eod, { property: 'Report', title: { contains: 'Nobody At All' } });
  const signoffs = N.DB.signoff ? await N.queryAll(N.DB.signoff, { or: Object.values(REP).map((r) => ({ property: 'Rep', select: { equals: r } })) }) : [];
  const todays = signoffs.filter((s) => N.readProp(s, 'Date') === today && (N.readProp(s, 'Rep') === REP.setter || (N.readProp(s, 'Reports') || []).some((id) => reports.some((r) => r.id === id))));
  const setter = await N.queryAll(N.DB.setter, { property: 'Setter', rich_text: { contains: 'E2E' } });
  const urls = new Set();
  for (const p of [...reports, ...orphans, ...todays]) { const u = N.readProp(p, 'Discord'); if (u) urls.add(u); }
  for (const p of [...leads, ...reports, ...orphans, ...todays, ...setter]) await N.notion('PATCH', `/pages/${p.id}`, { archived: true });
  let deleted = 0;
  for (const u of urls) {
    const m = u.match(/channels\/\d+\/(\d+)\/(\d+)$/);
    if (m) { try { await D.remove(m[1], m[2]); deleted++; } catch (e) { console.log('  could not delete', u, e.message); } }
  }
  console.log(`cleaned up ${leads.length} lead(s), ${reports.length + orphans.length} report(s), ${todays.length} sign-off(s), ${setter.length} setter row(s), ${deleted} Discord post(s)`);
}

(async () => {
  if (process.argv.includes('--cleanup')) return cleanup();
  console.log(`\ne2e (EOD) against ${BASE}\n`);

  const existing = await N.findLeadByEmail(EMAIL);
  if (existing) await N.notion('PATCH', `/pages/${existing.id}`, { archived: true });
  const lead = await N.createPage(N.DB.sales, { Lead: NAME, Email: EMAIL, Applied: today, Source: 'Inbound', Stage: 'Contacted', Pipeline: 'Leads Pipeline' });
  ok(true, 'created sacrificial lead', lead.id);

  // ------------------------------------------------------------ search
  const s = await get(`action=leads&q=${encodeURIComponent('EOD Test')}`);
  ok((s.leads || []).some((l) => l.id === lead.id), 'lead picker finds the lead by name');
  const s2 = await get(`action=leads&q=${encodeURIComponent('eod-e2e@')}`);
  ok((s2.leads || []).some((l) => l.id === lead.id), 'lead picker finds the lead by email');
  const one = await get(`action=lead&e=${Buffer.from(EMAIL).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`);
  ok(one.lead && one.lead.id === lead.id, 'pre-linked open resolves the lead');

  // ------------------------------------------------------------ 1. setter books
  const at = new Date(Date.now() + 3600e3).toISOString();
  const r1 = await post('call_report', { role: 'setter', rep: REP.setter, date: today, lead_id: lead.id, outcome: 'booked', booked_for: at, booked_with: REP.triage, lead_source: (CFG.lead_sources || ['Other'])[0], notes: 'e2e' });
  track(r1.json);
  ok(r1.json.status === 'received' && r1.json.matched, 'setter report filed and matched', r1.json.stage || '');
  let row = await reread(lead.id);
  ok(N.readProp(row, 'Stage') === 'Triage Call Booked', 'CRM stage → Triage Call Booked', N.readProp(row, 'Stage') || '');
  ok(!!N.readProp(row, 'Next Call At') && N.readProp(row, 'Next Call Type') === 'Triage', 'next call stamped on the lead', N.readProp(row, 'Next Call At') || '');
  ok(!!r1.json.discord, 'card posted to Discord', r1.json.discord || '(no token?)');

  const b = await get(`action=board&role=triage&rep=${encodeURIComponent(REP.triage)}&date=${today}`);
  ok((b.due || []).some((l) => l.id === lead.id), 'triage board lists the call as due');

  // ------------------------------------------------------------ 2. triage qualifies
  const at2 = new Date(Date.now() + 2 * 86400e3).toISOString();
  const r2 = await post('call_report', { role: 'triage', rep: ALIAS_OF(REP.closer), date: today, lead_id: lead.id, outcome: 'closing_booked', fit: 'Strong', budget_band: BUDGET, decision_maker: 'Sole', timeline: 'Now', package: PACKAGE, booked_for: at2, booked_with: REP.closer, objections: 'timing', recording_url: 'https://example.com/rec', notes: 'e2e' });
  track(r2.json);
  ok(r2.json.status === 'received' && r2.json.matched, `triage report filed (rep alias "${ALIAS_OF(REP.closer)}")`, r2.json.stage || '');
  row = await reread(lead.id);
  ok(N.readProp(row, 'Stage') === 'Closing Call Booked', 'CRM stage → Closing Call Booked', N.readProp(row, 'Stage') || '');
  ok(N.readProp(row, 'Journey #') === 6, 'journey → stage 6', N.readProp(row, 'Journey Stage') || '');
  ok(N.readProp(row, 'Triage Outcome') === 'Showed — advancing', 'triage outcome stamped');
  ok(N.readProp(row, 'Next Call Type') === 'Closing', 'next call is now the closing call');
  const rep2 = await reread(r2.json.report);
  ok(N.readProp(rep2, 'Rep') === REP.closer, 'alias resolved to the team spelling', N.readProp(rep2, 'Rep') || '');
  ok(N.readProp(rep2, 'Role') === 'Triage' && N.readProp(rep2, 'Fit') === 'Strong', 'qualification fields stored');

  // ------------------------------------------------------------ 3. closer wins with cash
  const r3 = await post('call_report', { role: 'closer', rep: REP.closer, date: today, lead_id: lead.id, outcome: 'closed_won', package: PACKAGE, payment_type: 'Deposit', ticket: 25000, cash_collected: 5000, notes: 'e2e' });
  track(r3.json);
  ok(r3.json.status === 'received' && r3.json.stage === 'Closed', 'closer win with cash → Closed', r3.json.stage || '');
  row = await reread(lead.id);
  ok(N.readProp(row, 'Journey #') === 8, 'journey → stage 8 Payment', N.readProp(row, 'Journey Stage') || '');
  ok(N.readProp(row, 'Deal Size') === 25000 && N.readProp(row, 'Cash Collected') === 5000, 'deal size + cash on the lead');
  ok(N.readProp(row, 'Paid Date') === today, 'paid date stamped');
  ok(!N.readProp(row, 'Next Call At'), 'next call cleared after the closing call');

  // ------------------------------------------------------------ 4. unmatched report
  const r4 = await post('call_report', { role: 'closer', rep: REP.closer, date: today, prospect_name: 'Nobody At All', prospect_email: 'nobody@example.test', outcome: 'no_show' });
  track(r4.json);
  ok(r4.json.status === 'received' && r4.json.matched === false, 'unmatched lead still files, flagged unlinked');

  // ------------------------------------------------------------ 5. sign-offs
  const so1 = await post('signoff', { role: 'setter', rep: REP.setter, date: today, messages_sent: 40, outbounds: 25, inbounds: 15, calls_booked: 1, hit_kpis: 'Yes', wins: 'e2e', notes: 'e2e' });
  track(so1.json);
  ok(so1.json.status === 'received' && so1.json.counts.booked === 1, 'setter sign-off counted the booking', JSON.stringify(so1.json.counts).slice(0, 80));
  const setterRows = await N.queryAll(N.DB.setter, { property: 'Day', title: { equals: `${today} · ${REP.setter}` } });
  ok(setterRows.length === 1 && N.readProp(setterRows[0], 'Inbounds') === 15, 'Setter Daily Activity mirrored (stage 1 feed)');

  const so2 = await post('signoff', { role: 'closer', rep: REP.closer, date: today, hit_kpis: 'Partial', blockers: 'e2e' });
  track(so2.json);
  ok(so2.json.status === 'received' && so2.json.counts.won === 1 && so2.json.counts.no_shows === 1, 'closer sign-off: 1 won, 1 no-show', JSON.stringify(so2.json.counts).slice(0, 90));
  const so2b = await post('signoff', { role: 'closer', rep: REP.closer, date: today, hit_kpis: 'Yes' });
  ok(so2b.json.signoff === so2.json.signoff, 'second sign-off updates the same row (idempotent)');
  const soRow = await reread(so2.json.signoff);
  ok((N.readProp(soRow, 'Reports') || []).length === 2, 'sign-off linked to its 2 reports');
  const repRow = await reread(r3.json.report);
  ok((N.readProp(repRow, 'Sign-off') || [])[0] === so2.json.signoff, 'report points back at the sign-off');
  ok(!!so2.json.discord, 'sign-off card posted', so2.json.discord || '');

  // ------------------------------------------------------------ 6. dashboard + board
  const html = await (await fetch(`${BASE}/reports?range=today&key=${KEY}`)).text();
  ok(html.includes(NAME) && html.includes('Closed Won'), 'dashboard shows the report');
  ok(html.includes(REP.setter), 'dashboard lists the setter');
  const b2 = await get(`action=board&role=closer&rep=${encodeURIComponent(ALIAS_OF(REP.closer))}&date=${today}`);
  ok((b2.filed || []).length === 2 && b2.signed === true, 'closer board: 2 filed, signed off');

  console.log(`\nmade ${MADE.reports.length} reports, ${MADE.signoffs.length} sign-offs, ${MADE.discord.length} Discord posts`);
  console.log('run with --cleanup to remove them.\n');
})().catch((e) => { console.error(e); process.exit(1); });
