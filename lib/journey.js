// The client-journey engine.
//
// A lead's stage is DERIVED from the evidence on their row, never trusted from
// the column itself. That is what lets the board repair itself after a bad
// import, a mis-drag or a webhook that never arrived — and it is why a manual
// move sticks only until the evidence contradicts it.

const CFG = require('../journey.config.json');
const N   = require('./notion');

const STAGES = CFG.stages;
const BY_NO  = new Map(STAGES.map((s) => [s.no, s]));
const BY_KEY = new Map(STAGES.map((s) => [s.key, s]));
const EXIT_NAME = { lost: '✕ Lost', rejected: '✕ Rejected' };

const day = (d) => (d ? String(d).slice(0, 10) : null);
const nowIso = () => new Date().toISOString();
const daysBetween = (a, b) =>
  a && b ? Math.round((new Date(b) - new Date(a)) / 86400000) : null;

/* ------------------------------------------------------- stage evidence */

// The timestamp that marks entry into each stage, where one exists.
function stampsOf(row) {
  const r = (k) => N.readProp(row, k);
  return {
    1: null,
    2: null,
    3: day(r('Applied')),
    4: day(r('VSL 1 Viewed')),
    5: day(r('Triage Date')) || day(r('Booked Call Date')),
    6: day(r('VSL 2 Viewed')),
    7: day(r('Closing Date')),
    8: day(r('Paid Date')),
    9: day(r('Onboarded Date')),
  };
}

/**
 * Furthest stage a lead can be shown to have reached, plus whether they exited.
 * Evidence beats the CRM stage; the CRM stage only ever raises the floor.
 */
function derive(row) {
  const r = (k) => N.readProp(row, k);
  const st = stampsOf(row);
  const why = [];
  let no = 1;

  const lift = (n, reason) => { if (n > no) { no = n; why.length = 0; why.push(reason); } else if (n === no) why.push(reason); };

  if (st[3]) lift(3, 'application');
  if (st[4]) lift(4, 'watched the initial VSL');
  if (st[5]) lift(5, 'triage call');
  if (st[6]) lift(6, 'opened the nurture pack');
  if (st[7]) lift(7, 'closing call');
  if (st[8] || (r('Cash Collected') || 0) > 0 || r('Closing Outcome') === 'Won') lift(8, 'payment');
  if (st[9]) lift(9, 'onboarded');

  // A CRM stage raises the floor but never lowers it.
  const crmStage = r('Stage');
  const floor = CFG.stage_floor[crmStage];
  if (floor) lift(floor, `CRM stage “${crmStage}”`);

  // Anyone with an email and no application at least reached the site.
  if (no === 1 && (r('Email') || r('Source'))) lift(2, 'known contact');

  // Exits
  let exited = CFG.exit_stages[crmStage] || null;
  if (!exited && r('Opp Status') === 'lost') exited = 'lost';
  if (!exited && r('Triage Outcome') === 'Rejected') exited = 'rejected';
  if (!exited && r('Closing Outcome') === 'Lost') exited = 'lost';
  const manual = r('Journey Stage');
  if (!exited && (manual === '✕ Lost' || manual === '✕ Rejected')) {
    exited = manual === '✕ Lost' ? 'lost' : 'rejected';
  }

  return { no, exited, why: why.join(' + '), stamps: st };
}

function stageName(d) {
  return d.exited ? EXIT_NAME[d.exited] : BY_NO.get(d.no).name;
}

/* ------------------------------------------------------------- cohort */

function cohortDate(row) {
  const applied = day(N.readProp(row, 'Applied'));
  if (applied) return applied;
  // A row created on a bulk-import day with no application date is backfill,
  // not a lead that walked this funnel — it gets no cohort date at all.
  const created = day(row.created_time);
  if ((CFG.import_dates || []).includes(created)) return null;
  return created;
}

/* ----------------------------------------------------------- recompute */

/**
 * Re-derives every lead's stage, writes back any that changed, and rewrites the
 * Funnel Health table. `since` bounds the cohort the percentages are measured
 * over; leads outside it still get their own stage corrected.
 */
async function recompute({ since = CFG.cohort_start, until = null, writeLeads = true,
                          writeHealth = true, maxWrites = 120 } = {}) {
  const leads = await N.queryAll(N.DB.sales);
  const derived = leads.map((row) => ({ row, d: derive(row) }));

  // 1. write back any lead whose stage the evidence disagrees with
  // Capped so a single run cannot outlive the function. Whatever is left is
  // picked up by the next run, and the numbers below are computed from the
  // derivation either way — so the table is correct even mid-catch-up.
  let moved = 0, pending = 0;
  if (writeLeads) {
    const todo = [];
    for (const { row, d } of derived) {
      const want = stageName(d);
      const wantNo = d.exited ? null : d.no;
      const haveStage = N.readProp(row, 'Journey Stage');
      const haveNo = N.readProp(row, 'Journey #');
      const src = N.readProp(row, 'Journey Source');

      // A hand-drag is respected until the evidence outranks it.
      const manualAhead = src === 'manual' && haveStage && !d.exited &&
        (BY_NO_INDEX(haveStage) || 0) > d.no;
      if (haveStage === want && haveNo === wantNo) continue;
      if (manualAhead) continue;

      todo.push({ row, want, wantNo, src });
    }
    pending = Math.max(0, todo.length - maxWrites);
    const batch = todo.slice(0, maxWrites);
    // Notion tolerates a handful of concurrent writes; the client retries 429.
    // Sequentially this loop outlives a 60s function on the first backfill.
    await pool(batch, 3, async ({ row, want, wantNo, src }) => {
      await N.updatePage(row.id, N.DB.sales, {
        'Journey Stage': want,
        'Journey #': wantNo,
        'Journey Updated': nowIso(),
        'Journey Source': src === 'manual' ? 'manual' : 'ghl-stage',
      });
      moved++;
    });
  }

  // 2. metrics over the cohort
  const inWindow = derived.filter(({ row }) => {
    const c = cohortDate(row);
    if (!c) return false;
    if (since && c < since) return false;
    if (until && c > until) return false;
    return true;
  });

  // Stage 1 counts conversations, not CRM rows — every row in 💰 Sales is by
  // definition past the DM. That number only exists on the setter report.
  let dmVolume = null;
  if (N.DB.setter) {
    try {
      const filter = { and: [] };
      if (since) filter.and.push({ property: 'Date', date: { on_or_after: since } });
      if (until) filter.and.push({ property: 'Date', date: { on_or_before: until } });
      const days = await N.queryAll(N.DB.setter, filter.and.length ? filter : null);
      if (days.length) {
        dmVolume = days.reduce((t, r) =>
          t + (N.readProp(r, 'Inbounds') || 0) + (N.readProp(r, 'Outbounds') || 0), 0);
      }
    } catch (e) { /* setter db not reachable — fall back to CRM rows */ }
  }

  // Stage 2 is the live website: visits tracked on your website (public/t.js), and
  // how many of those visits finished the application. Both numbers come from
  // the same rows, so the conversion is internally consistent even though the
  // CRM's application history reaches back further than the tracker does.
  let site = null;
  if (N.DB.sessions && STAGES.some((s) => s.metric_source === 'sessions')) {
    try {
      const f = { and: [] };
      if (since) f.and.push({ property: 'Started', date: { on_or_after: since } });
      if (until) f.and.push({ property: 'Started', date: { on_or_before: until } });
      const visits = await N.queryAll(N.DB.sessions, f.and.length ? f : null, null, 3000);
      site = {
        sessions: visits.length,
        completed: visits.filter((v) => N.readProp(v, 'Completed')).length,
        started: visits.filter((v) => N.readProp(v, 'Form started')).length,
      };
    } catch (e) { /* tracker not live yet */ }
  }

  const rows = [];
  for (const s of STAGES) {
    const entered  = inWindow.filter(({ d }) => d.no >= s.no);
    const advanced = inWindow.filter(({ d }) => d.no >= s.no + 1);
    const openNow  = inWindow.filter(({ d }) => !d.exited && d.no === s.no);
    const lostHere = inWindow.filter(({ d }) => d.exited && d.no === s.no);

    const gaps = entered
      .map(({ d }) => daysBetween(d.stamps[s.no], d.stamps[s.no + 1]))
      .filter((n) => n !== null && n >= 0);
    const avg = gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10 : null;

    // How this stage is counted depends on what can honestly be observed.
    let enteredN = entered.length;
    let advancedN = advanced.length;
    let manualEntered = false;

    if (s.metric_source === 'setter') {
      // Every row in 💰 Sales is already past the DM, so the CRM cannot supply
      // this denominator. Logged conversations can.
      enteredN = dmVolume !== null ? dmVolume : null;
    } else if (s.metric_source === 'asset') {
      // A lead lifted over a VSL stage by a CRM stage change proves nothing was
      // watched. Sent vs actually opened is the only honest reading.
      const sentProp = s.metric_props.sent, viewProp = s.metric_props.viewed;
      enteredN  = inWindow.filter(({ row }) => N.readProp(row, sentProp)).length;
      advancedN = inWindow.filter(({ row }) => N.readProp(row, viewProp)).length;
    } else if (s.metric_source === 'sessions') {
      enteredN = site ? site.sessions : null;
      advancedN = site ? site.completed : 0;
    } else if (s.metric_source === 'manual') {
      // Site sessions live in analytics, not the CRM. Whatever is typed into
      // Entered stands; everything else is derived from it.
      manualEntered = true;
    }

    const conv = enteredN
      ? Math.round((advancedN / enteredN) * 1000) / 10
      : null;

    rows.push({
      stage: s,
      manualEntered,
      Entered: enteredN,
      Advanced: advancedN,
      'Conversion %': s.no === 9 ? null : conv,
      'Open now': openNow.length,
      'Avg days to advance': avg,
      'Lost here': lostHere.length,
    });
  }

  // 3. write the Funnel Health table
  const health = writeHealth ? await N.queryAll(N.DB.stages) : [];
  const byName = new Map(health.map((r) => [N.readProp(r, 'Stage'), r]));
  for (const m of rows) {
    const target = byName.get(m.stage.name);
    if (!target) continue;
    if (m.manualEntered) {
      const typed = N.readProp(target, 'Entered');
      m.Entered = typed;
      m['Conversion %'] = typed ? Math.round((m.Advanced / typed) * 1000) / 10 : null;
    }
    await N.updatePage(target.id, N.DB.stages, {
      Entered: m.manualEntered ? undefined : m.Entered,
      Advanced: m.Advanced,
      'Conversion %': m['Conversion %'],
      'Open now': m['Open now'],
      'Avg days to advance': m['Avg days to advance'],
      'Lost here': m['Lost here'],
      'Last computed': nowIso(),
    });
  }

  return {
    cohort: { since, until, leads: inWindow.length, of: leads.length },
    site, moved, pending,
    stages: rows.map((m) => ({
      no: m.stage.no, stage: m.stage.name, entered: m.Entered,
      advanced: m.Advanced, conversion: m['Conversion %'],
      target: m.stage.kpi_target, open: m['Open now'], lost: m['Lost here'],
    })),
  };
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool(items, n, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await fn(item); } catch (e) { console.error('[pool]', e.message); }
    }
  });
  await Promise.all(workers);
}

// Journey Stage name -> number, for the manual-move guard.
function BY_NO_INDEX(name) {
  const hit = STAGES.find((s) => s.name === name);
  return hit ? hit.no : null;
}

/* ------------------------------------------------- moving a single lead */

/** Raise a lead to at least `stageNo`, stamping the reason. Never lowers. */
async function advance(row, stageNo, source, extra = {}) {
  const cur = N.readProp(row, 'Journey #') || 0;
  const patch = { ...extra, 'Journey Updated': nowIso(), 'Journey Source': source };
  if (stageNo && stageNo > cur) {
    patch['Journey Stage'] = BY_NO.get(stageNo).name;
    patch['Journey #'] = stageNo;
  }
  await N.updatePage(row.id, N.DB.sales, patch);
  return { id: row.id, from: cur, to: Math.max(cur, stageNo || 0) };
}

/** Send a lead to an exit column. */
async function exit(row, kind, extra = {}) {
  await N.updatePage(row.id, N.DB.sales, {
    ...extra,
    'Journey Stage': EXIT_NAME[kind],
    'Journey #': null,
    'Journey Updated': nowIso(),
    'Journey Source': 'eod-report',
  });
  return { id: row.id, to: EXIT_NAME[kind] };
}

module.exports = {
  CFG, STAGES, BY_NO, BY_KEY, EXIT_NAME,
  derive, stageName, stampsOf, cohortDate, recompute, advance, exit, daysBetween, nowIso, day,
};
