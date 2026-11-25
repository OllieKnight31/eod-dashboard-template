#!/usr/bin/env node
/**
 * End-to-end test against the live deployment, using a sacrificial lead.
 *   node scripts/e2e.js            create the lead + run every path
 *   node scripts/e2e.js --cleanup  archive everything it made
 * Nothing here touches a real record: the lead is created by this script and
 * matched only by its own unique email.
 */
const N = require('../lib/notion');
const J = require('../lib/journey');
const L = require('../lib/leads');

const CFG = require('../journey.config.json');
const BASE = process.env.PUBLIC_BASE_URL || CFG.public_base;
if (!BASE) { console.error('Set PUBLIC_BASE_URL (or public_base in journey.config.json) to the deployed app.'); process.exit(1); }
// Test reps come from the team in journey.config.json: the first person in each seat.
const TEAM = (CFG.eod && CFG.eod.team) || [];
const first = (role, fallback) => (TEAM.find((t) => t.role === role) || {}).name || fallback;
const ALIAS_OF = (name) => ((TEAM.find((t) => t.name === name) || {}).aka || [])[0] || name;
const PACKAGE = ((CFG.eod && CFG.eod.pathways) || ['Option A'])[0];
const BUDGET = ((CFG.eod && CFG.eod.budget_bands) || ['Discuss on the call'])[0];
const EMAIL = 'journey-e2e@example.test';
const NAME = 'E2E Sacrificial Lead';
const today = J.day(new Date().toISOString());

const post = async (source, body) => {
  const r = await fetch(`${BASE}/api?source=${source}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (c, m, extra = '') => console.log(`  ${c ? '✓' : '✗'} ${m}${extra ? '  ' + extra : ''}`);
const reread = async (id) => N.notion('GET', `/pages/${id}`);

async function findAll() {
  const leads = await N.queryAll(N.DB.sales, { property: 'Email', email: { equals: EMAIL } });
  // Includes the deliberately-unmatched call, which is filed under its own name.
  const mine = await N.queryAll(N.DB.eod, { property: 'Report', title: { contains: NAME } });
  const orphans = await N.queryAll(N.DB.eod, { property: 'Report', title: { contains: 'Nobody At All' } });
  const reports = [...mine, ...orphans];
  const setters = await N.queryAll(N.DB.setter, { property: 'Setter', rich_text: { contains: 'E2E' } });
  return { leads, reports, setters };
}

(async () => {
  if (process.argv.includes('--cleanup')) {
    const { leads, reports, setters } = await findAll();
    for (const p of [...leads, ...reports, ...setters]) {
      await N.notion('PATCH', `/pages/${p.id}`, { archived: true });
    }
    console.log(`cleaned up ${leads.length} lead(s), ${reports.length} report(s), ${setters.length} setter row(s)`);
    // Roll the asset counters back to where the test found them.
    const assets = await N.queryAll(N.DB.assets, { property: 'Slug', rich_text: { equals: 'initial-vsl' } });
    if (assets[0]) {
      await N.updatePage(assets[0].id, N.DB.assets, { Sent: 0, Opened: 0, Played: 0, Completed: 0, 'Avg watch %': null });
      console.log('reset initial-vsl counters');
    }
    return;
  }

  console.log(`\ne2e against ${BASE}\n`);

  // ---------------------------------------------------------------- setup
  const existing = await N.findLeadByEmail(EMAIL);
  if (existing) await N.notion('PATCH', `/pages/${existing.id}`, { archived: true });
  const lead = await N.createPage(N.DB.sales, {
    Lead: NAME, Email: EMAIL, Applied: today, Source: 'Inbound', Stage: 'Applied',
  });
  ok(true, 'created sacrificial lead', lead.id);

  // ------------------------------------------------------------ 1. VSL play
  const token = L.tokenFrom({ e: L.b64url.enc(EMAIL) });
  await post('vsl_event', { t: token, slug: 'initial-vsl', event: 'open', pct: 0 });
  const play = await post('vsl_event', { t: token, slug: 'initial-vsl', event: 'play', pct: 0 });
  await post('vsl_event', { t: token, slug: 'initial-vsl', event: 'progress', pct: 50 });
  await post('vsl_event', { t: token, slug: 'initial-vsl', event: 'complete', pct: 100 });
  let row = await reread(lead.id);
  ok(N.readProp(row, 'Journey #') === 4, 'VSL play moved the lead to stage 4',
     `stage=${N.readProp(row, 'Journey Stage')}`);
  ok(!!N.readProp(row, 'VSL 1 Viewed'), 'VSL 1 Viewed stamped', N.readProp(row, 'VSL 1 Viewed') || '');
  ok(N.readProp(row, 'VSL 1 Watch %') === 100, 'watch depth recorded',
     `${N.readProp(row, 'VSL 1 Watch %')}%`);
  ok(play.json.advanced === true, 'play beacon reported the advance');

  // -------------------------------------------------------- 2. triage call
  const triage = await post('closer_eod', {
    closer: first('closer', 'Closer 1'), date: today,
    calls: [{
      call_type: 'triage', prospect_name: NAME, prospect_email: EMAIL,
      outcome: 'closing_booked', lead_source: 'Instagram DM',
      follow_up_action: 'Closing call Thursday 2pm', follow_up_date: today,
      objections: 'Wants to understand the Strategic tier', notes: 'e2e',
    }],
  });
  ok(triage.json.status === 'received' && triage.json.moved === 1,
     'triage EOD filed and moved the lead', JSON.stringify(triage.json));
  row = await reread(lead.id);
  ok(N.readProp(row, 'Journey #') === 6, 'lead is at stage 6 (post-triage nurture)',
     `stage=${N.readProp(row, 'Journey Stage')}`);
  ok(N.readProp(row, 'Triage Outcome') === 'Showed — advancing', 'triage outcome written',
     N.readProp(row, 'Triage Outcome') || '');
  ok(N.readProp(row, 'Next Action') === 'Closing call Thursday 2pm', 'next action written');
  ok((N.readProp(row, 'Call Reports') || []).length === 1, 'call report linked to the lead');

  // ------------------------------------------------------- 3. closing call
  const closing = await post('closer_eod', {
    closer: first('closer', 'Closer 1'), date: today,
    calls: [{
      call_type: 'closing', prospect_name: NAME, prospect_email: EMAIL,
      outcome: 'closed_won', package: PACKAGE, ticket: '15000',
      cash_collected: '5000', lead_source: 'Instagram DM', notes: 'e2e',
    }],
  });
  ok(closing.json.moved === 1, 'closing EOD filed and moved the lead');
  row = await reread(lead.id);
  ok(N.readProp(row, 'Journey #') === 8, 'lead is at stage 8 (payment)',
     `stage=${N.readProp(row, 'Journey Stage')}`);
  ok(N.readProp(row, 'Cash Collected') === 5000, 'cash collected written');
  ok(N.readProp(row, 'Deal Size') === 15000, 'deal size written');
  ok(N.readProp(row, 'Tier') === PACKAGE, 'tier written', N.readProp(row, 'Tier') || '');
  ok(!!N.readProp(row, 'Paid Date'), 'paid date stamped');

  // -------------------------------------------------- 4. unmatched call
  const orphan = await post('closer_eod', {
    closer: first('closer', 'Closer 1'), date: today,
    calls: [{ call_type: 'triage', prospect_name: 'Nobody At All', prospect_email: '', outcome: 'follow_up' }],
  });
  ok(orphan.json.unmatched?.length === 1, 'a call with no CRM match is filed and reported back',
     JSON.stringify(orphan.json.unmatched));

  // ------------------------------------------------------ 5. setter report
  const setter = await post('setter_eod', {
    setter: 'E2E Setter', date: today, lead_source: 'Instagram DM',
    messages_sent: '120', outbounds: '80', inbounds: '40',
    calls_booked: '6', calls_held: '4', closing_calls_booked: '2', notes: 'e2e',
  });
  ok(setter.json.status === 'received', 'setter report filed', setter.json.row || '');

  // -------------------------------------------------------- 6. asset counters
  const asset = (await N.queryAll(N.DB.assets, { property: 'Slug', rich_text: { equals: 'initial-vsl' } }))[0];
  ok(N.readProp(asset, 'Played') >= 1, 'asset Played counter incremented',
     `sent=${N.readProp(asset, 'Sent')} opened=${N.readProp(asset, 'Opened')} played=${N.readProp(asset, 'Played')} completed=${N.readProp(asset, 'Completed')}`);

  // ------------------------------------------------------- 7. stage 1 metric
  const stage1 = (await N.queryAll(N.DB.stages, { property: 'Stage', title: { contains: '1. Social' } }))[0];
  ok(N.readProp(stage1, 'Entered') === 120, 'stage 1 Entered came from the setter report',
     `entered=${N.readProp(stage1, 'Entered')} (80 outbound + 40 inbound)`);

  console.log('\nrun `node scripts/e2e.js --cleanup` to remove everything this created.\n');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
