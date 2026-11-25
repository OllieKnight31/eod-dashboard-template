// The scorecard: everyone's numbers against target, for a day or a period.
//
//   GET /api?action=scorecard_data&range=7d      JSON for /scorecard (see getScorecard)
//
// Built from the same two Notion databases the reports write to (Call EOD Reports and
// 📝 EOD Sign-offs), so it needs no extra setup. A day counts as filed when the person
// logged a call report or signed off. Anyone on the team with nothing in the period is
// listed under "not filed".
//
// Also here: the missed-report reminder (runNudge), which shares the same reading of
// who has filed.

const CFG = require('../journey.config.json');
const D = require('./discord');
const EOD = require('./eod');
const LIVE = require('./live');
const { firstRun } = require('./store');

const { live, ROLES } = LIVE;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);
const key = (name) => EOD.canonicalRep(name).toLowerCase();

function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// What a report's outcome amounts to, for the colour of its chip on the page.
function outcomeKind(r) {
  if (r.attendance === 'No-show') return 'no_show';
  if (r.attendance === 'Rescheduled') return 'rescheduled';
  const o = r.outcome;
  if (o === 'Closed Won' || o === 'Closing call booked' || o === 'Sending nurture pack' || o === 'Triage call booked') return 'won';
  if (o === 'Closed Lost' || o === 'Not qualified — rejected' || o === 'Not interested') return 'lost';
  return 'follow_up';
}

const callOf = (r) => ({
  prospect: r.name || 'Unnamed lead', outcome: r.outcome, kind: outcomeKind(r),
  ticket: r.cash || 0, source: r.source || '', setter: r.setter || '',
  lost_reason: r.objection || '', follow_up_date: r.nextDue || '', notes: r.notes || '', url: r.leadUrl || r.url,
});

/* ---------------------------------------------- one person, one day → a card */
// `reports` are that person's call reports for the day, `so` their sign-off (or null).

function dayNotes(so) {
  if (!so) return '';
  return [so.wins && `Wins: ${so.wins}`, so.blockers && `Blockers: ${so.blockers}`, so.notes].filter(Boolean).join(' · ');
}

const CARD = {
  setter(name, reports, so) {
    const t = EOD.tally(reports);
    return {
      name, messages: so?.messages || 0, outbounds: so?.outbounds || 0, inbounds: so?.inbounds || 0,
      conversations: so?.conversations || 0, links: so?.links || 0, calls_booked: so?.booked || t.booked,
      lead_reports: reports.length, follow_up: t.follow_ups, not_interested: t.not_interested, rejected: t.rejected,
      hottest_lead: so?.hottest || '', call_list: reports.map(callOf),
    };
  },
  triage(name, reports, so) {
    const t = EOD.tally(reports);
    return {
      name, zero_call: !reports.length && Boolean(so?.no_calls),
      calls: t.scheduled, showed: t.showed, no_show: t.no_shows, rescheduled: t.rescheduled,
      qualified: t.qualified, closing_booked: t.closing_booked, nurture: t.nurture, rejected: t.rejected, follow_up: t.follow_ups,
      call_list: reports.map(callOf),
    };
  },
  closer(name, reports, so) {
    const t = EOD.tally(reports);
    return {
      name, zero_call: !reports.length && Boolean(so?.no_calls),
      calls: t.scheduled, showed: t.showed, no_show: t.no_shows, rescheduled: t.rescheduled,
      won: t.won, lost: t.lost, follow_up: t.follow_ups, revenue: t.cash, deal: t.deal,
      call_list: reports.map(callOf),
    };
  },
};

/* ------------------------------------------------------------- KPI scoring */
// Each person's card is a list of metric rows. A row is one number, its target, how it
// did, and how it moved against the previous period of the same length.
//
//   ok   = on target                        (green,  "ON TARGET")
//   warn = at least 70% of the way there    (amber,  "BELOW")
//   crit = further off than that            (red,    "CRITICAL")
//   na   = no target set, or nothing to measure
//
// Targets are per day, so counts are shown as a per-day average over the days filed.
// `fill` is the meter width: it runs 0 → 2× target, so the target tick sits mid-bar.
const WARN_AT = 0.7;
const round = (n, dp = 1) => { const f = 10 ** dp; return Math.round(n * f) / f; };
const perDay = (total, days) => (days > 0 ? round(total / days) : null);

function show(value, unit) {
  if (value == null) return 'n/a';
  if (unit === 'money') return `${live.currency_symbol}${Math.round(value).toLocaleString((CFG.business || {}).locale || 'en-US')}`;
  if (unit === 'pct') return `${value}%`;
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

// How a value moved against the previous period: rates in points, everything else in %.
function delta(value, prev, unit) {
  if (value == null || prev == null) return null;
  let txt, dir;
  if (unit === 'pct') {
    const pts = value - prev;
    if (Math.abs(pts) < 0.05) return { txt: '0 pts', dir: 0, good: null };
    txt = `${round(Math.abs(pts), Math.abs(pts) < 10 ? 1 : 0)} pts`; dir = pts > 0 ? 1 : -1;
  } else if (prev === 0) {
    if (value === 0) return { txt: '0', dir: 0, good: null };
    txt = 'from 0'; dir = value > 0 ? 1 : -1;
  } else {
    const pc = ((value - prev) / Math.abs(prev)) * 100;
    if (Math.abs(pc) < 0.5) return { txt: '0%', dir: 0, good: null };
    txt = Math.abs(pc) > 999 ? '>999%' : `${round(Math.abs(pc), Math.abs(pc) < 10 ? 1 : 0)}%`; dir = pc > 0 ? 1 : -1;
  }
  return { txt, dir, good: dir > 0 };
}

// row: { key, label, value, target, unit }  →  the finished metric
function finish(row, prev) {
  const { value, unit = 'num' } = row;
  const target = row.target || null;
  const m = {
    key: row.key, label: row.label, value, target, unit,
    display: show(value, unit),
    target_display: target ? `target ≥ ${show(target, unit)}` : 'no target',
    status: 'na', fill: 0,
    delta: delta(value, prev, unit),
  };
  if (!target || value == null) return m;
  const ratio = value / target;
  m.status = ratio >= 1 ? 'ok' : ratio >= WARN_AT ? 'warn' : 'crit';
  m.fill = Math.max(0, Math.min(100, round(ratio * 50)));
  return m;
}

// The rows on each seat's card. `c` is one person's numbers for the period (or one day),
// `n` the number of days they filed.
const ROWS = {
  setter(c, n) {
    const T = live.targets.setter;
    return [
      { key: 'messages',  label: 'Messages / day',     value: perDay(c.messages, n),     target: T.messages },
      { key: 'outbounds', label: 'Outbounds / day',    value: perDay(c.outbounds, n),    target: T.outbounds },
      { key: 'conversations', label: 'Active convos / day', value: perDay(c.conversations, n) },
      { key: 'links',     label: 'Links sent / day',   value: perDay(c.links, n) },
      { key: 'bookings',  label: 'Bookings / day',     value: perDay(c.calls_booked, n), target: T.calls_booked },
      { key: 'leads',     label: 'Lead reports / day', value: perDay(c.lead_reports, n) },
    ];
  },
  triage(c, n) {
    const T = live.targets.triage;
    return [
      { key: 'calls',     label: 'Calls taken / day',       value: perDay(c.calls, n),            target: T.calls },
      { key: 'show_rate', label: 'Show rate',               value: pct(c.showed, c.calls),        target: T.show_rate,      unit: 'pct' },
      { key: 'qualified', label: 'Qualified rate on shows', value: pct(c.qualified, c.showed),    target: T.qualified_rate, unit: 'pct' },
      { key: 'closing',   label: 'Closing calls booked / day', value: perDay(c.closing_booked, n) },
    ];
  },
  closer(c, n) {
    const T = live.targets.closer;
    return [
      { key: 'calls',      label: 'Calls taken / day',   value: perDay(c.calls, n),     target: T.calls },
      { key: 'show_rate',  label: 'Show rate',           value: pct(c.showed, c.calls), target: T.show_rate,  unit: 'pct' },
      { key: 'close_rate', label: 'Close rate on shows', value: pct(c.won, c.showed),   target: T.close_rate, unit: 'pct' },
      { key: 'revenue',    label: 'Cash collected / day', value: perDay(c.revenue, n),  target: T.revenue, unit: 'money' },
      { key: 'collected',  label: 'Cash collected',      value: c.revenue, unit: 'money' },
      { key: 'contracted', label: 'Contracted',          value: c.deal, unit: 'money' },
      { key: 'aov',        label: 'Cash per deal won',   value: c.won ? Math.round(c.revenue / c.won) : null, unit: 'money' },
      { key: 'per_call',   label: 'Cash per call taken', value: c.calls ? Math.round(c.revenue / c.calls) : null, unit: 'money' },
    ];
  },
};

// prev: the same person's merged numbers for the previous period (or null).
function scoreCard(role, c, n, prev, prevN) {
  const before = prev ? Object.fromEntries(ROWS[role](prev, prevN).map((r) => [r.key, r.value])) : {};
  const metrics = ROWS[role](c, n).map((r) => finish(r, r.key in before ? before[r.key] : null));
  const scored = metrics.filter((m) => m.status !== 'na');
  return {
    metrics, kpis_total: scored.length,
    kpis_hit: scored.filter((m) => m.status === 'ok').length,
    kpis_crit: scored.filter((m) => m.status === 'crit').length,
  };
}

/* ---------------------------------- several days rolled into one card per person */
const add = (list, k) => list.reduce((a, c) => a + (c[k] || 0), 0);
const lastOf = (list, k) => { for (let i = list.length - 1; i >= 0; i--) if (list[i][k]) return list[i][k]; return ''; };
// Notes across days, newest first, each tagged with its date.
const datedNotes = (list) => list.filter((c) => c.notes).slice(-5).reverse().map((c) => `${c.date}: ${c.notes}`).join('\n');

const SUM = {
  setter: ['conversations', 'messages', 'outbounds', 'inbounds', 'links', 'calls_booked', 'lead_reports', 'follow_up', 'not_interested', 'rejected'],
  triage: ['calls', 'showed', 'no_show', 'rescheduled', 'qualified', 'closing_booked', 'nurture', 'rejected', 'follow_up'],
  closer: ['calls', 'showed', 'no_show', 'rescheduled', 'won', 'lost', 'follow_up', 'revenue', 'deal'],
};

function merge(role, days) {
  const out = { name: days[days.length - 1].name, ...Object.fromEntries(SUM[role].map((k) => [k, add(days, k)])) };
  return {
    ...out,
    // every day in the period was a zero-call day
    zero_call: role !== 'setter' && days.every((c) => c.zero_call),
    zero_call_days: days.filter((c) => c.zero_call).length,
    signoffs: days.filter((c) => c.signed).length,
    hottest_lead: lastOf(days, 'hottest_lead'),
    call_list: days.flatMap((c) => c.call_list.map((call) => ({ ...call, date: c.date }))).reverse(),
    notes: days.length === 1 ? days[0].notes : datedNotes(days),
  };
}

const LIST = { setter: 'setters', triage: 'triages', closer: 'closers' };
const ROLE_PLURAL = { setter: 'Setters', triage: 'Triage', closer: 'Closers' };
const MAX_RANGE_DAYS = 92;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();

// Query: range=today|yesterday|7d|30d  ·  or date=YYYY-MM-DD  ·  or start= & end=
//        role=setter|triage|closer  ·  person=<name>
async function getScorecard(query = {}) {
  const today = LIVE.localNow().date;
  // range=today|yesterday|7d|30d is worked out here so "today" is the business's today,
  // not the browser's.
  const preset = { today: [today, today], yesterday: [shiftDate(today, -1), shiftDate(today, -1)],
    '7d': [shiftDate(today, -6), today], '30d': [shiftDate(today, -29), today] }[query.range];
  let start = preset ? preset[0] : isDate(query.start) ? query.start : isDate(query.date) ? query.date : today;
  let end = preset ? preset[1] : isDate(query.end) ? query.end : isDate(query.date) ? query.date : isDate(query.start) ? today : start;
  if (end < start) [start, end] = [end, start];
  if (shiftDate(start, MAX_RANGE_DAYS - 1) < end) start = shiftDate(end, -(MAX_RANGE_DAYS - 1));
  const dates = [];
  for (let d = start; d <= end; d = shiftDate(d, 1)) dates.push(d);
  // The period just before this one, same length, what the ▲▼ arrows compare against.
  const prevDates = dates.map((_, i) => shiftDate(start, -(dates.length - i)));

  const roleFilter = ROLES.includes(query.role) ? query.role : '';
  const personFilter = query.person ? key(query.person) : '';
  const roles = roleFilter ? [roleFilter] : ROLES;

  const [reports, signoffs] = await Promise.all([
    EOD.reportsBetween(prevDates[0], end),
    EOD.signoffsBetween(prevDates[0], end),
  ]);

  // seat → person → day → what they filed
  const filed = Object.fromEntries(ROLES.map((r) => [r, new Map()]));
  const slot = (role, rep, date) => {
    if (!filed[role] || !rep || !date) return null;
    const people = filed[role], k = key(rep);
    if (!people.has(k)) people.set(k, new Map());
    const days = people.get(k), d = String(date).slice(0, 10);
    if (!days.has(d)) days.set(d, { name: EOD.canonicalRep(rep), reports: [], so: null });
    return days.get(d);
  };
  for (const r of reports) { const s = slot(r.role, r.rep, r.date); if (s) s.reports.push(r); }
  for (const so of signoffs) { const s = slot(so.role, so.rep, so.date); if (s) s.so = so; }

  // person → their card for each day they filed, oldest first
  const collect = (within) => {
    const got = Object.fromEntries(ROLES.map((r) => [r, new Map()]));
    for (const role of ROLES) {
      for (const [k, days] of filed[role]) {
        const cards = within.filter((d) => days.has(d)).map((date) => {
          const { name, reports: rs, so } = days.get(date);
          const ts = [...rs.map((r) => r.created), so && so.created].filter(Boolean).sort().pop() || '';
          return { ...CARD[role](name, rs, so), date, ts, signed: Boolean(so), hit_kpis: so?.hit_kpis || '', notes: dayNotes(so) };
        });
        if (cards.length) got[role].set(k, cards);
      }
    }
    return got;
  };
  const byDay = collect(dates);
  const byDayPrev = collect(prevDates);

  // Everyone who could be picked in the filters: the team plus anyone who filed.
  const people = {};
  for (const role of ROLES) {
    const names = new Map(live.roster[role].map((p) => [key(p.name), p.name]));
    for (const [k, days] of byDay[role]) if (!names.has(k)) names.set(k, days[0].name);
    people[role] = [...names.values()].sort((a, b) => a.localeCompare(b));
  }

  // Days a report was expected: the reminder days, never in the future.
  const expectedDates = (within = dates) => within.filter((d) => d <= today && live.nudge.days.includes(weekday(d)));
  // "EOD filed": days filed out of days expected, as a metric row like any other.
  const filedRow = (n, expected, prevN, prevExpected) => finish(
    { key: 'filed', label: 'EOD filed', value: expected ? Math.min(100, pct(n, expected)) : null, target: 100, unit: 'pct' },
    prevExpected ? Math.min(100, pct(prevN, prevExpected)) : null);

  const out = { setters: [], triages: [], closers: [] };
  const not_filed = {};
  const expected = expectedDates();
  const prevExpected = expectedDates(prevDates);
  for (const role of roles) {
    for (const [k, days] of byDay[role]) {
      if (personFilter && k !== personFilter) continue;
      const filedDates = new Set(days.map((d) => d.date));
      const before = byDayPrev[role].get(k);
      const merged = merge(role, days);
      const scored = scoreCard(role, merged, days.length, before ? merge(role, before) : null, before ? before.length : 0);
      // a report on a day off still counts, so never show "6 of 5"
      const expectedCount = Math.max(expected.length, days.length);
      out[LIST[role]].push({
        ...merged, role, ...scored,
        days_filed: days.length,
        days_expected: expectedCount,
        days_missed: expected.filter((d) => !filedDates.has(d)),
        last_filed: days.reduce((a, d) => (d.ts > a ? d.ts : a), ''),
        filed: filedRow(days.length, expectedCount, before ? before.length : 0, prevExpected.length),
        // one scored row per filed day, the drill-down table
        by_day: days.map((d) => ({ date: d.date, zero_call: Boolean(d.zero_call), signed: d.signed, ...scoreCard(role, d, 1, null, 0) })).reverse(),
      });
    }
    out[LIST[role]].sort((a, b) => a.name.localeCompare(b.name));
    // Team members with nothing filed in the whole period, only when a report was
    // actually expected in it (nobody is "missing" on a day off).
    not_filed[role] = !expected.length ? [] : live.roster[role].map((p) => p.name)
      .filter((n) => !byDay[role].has(key(n)) && (!personFilter || key(n) === personFilter));
  }

  // ── Team KPIs: the same targets, multiplied up ────────────────────────────
  // A count target is per person per day, so the team's is target × people × days.
  // People = the team list for that seat (or whoever filed, if it is empty);
  // days = the days a report was expected. Rates keep their plain target.
  const prevCards = (role) => [...byDayPrev[role]].filter(([k]) => !personFilter || k === personFilter).map(([, days]) => merge(role, days));
  const headcount = (role) => (personFilter ? 1 : Math.max(live.roster[role].length, out[LIST[role]].length));
  const team_kpis = [];
  const teamRow = (role, k, label, pick, perPersonDay, opts = {}) => {
    const cards = out[LIST[role]], before = prevCards(role);
    const heads = headcount(role), days = expected.length || (cards.length ? dates.length : 0);
    if (!heads && !cards.length) return;                       // a seat nobody sits in has no tile
    const scale = opts.rate ? 1 : heads * days;
    const m = finish({ key: `${role}_${k}`, label, value: cards.length ? pick(cards) : null, target: perPersonDay ? perPersonDay * scale : 0, unit: opts.unit },
      before.length ? pick(before) : null);
    m.role = role;
    m.note = !m.target ? '' : opts.rate ? `${ROLE_PLURAL[role]} target`
      : `${show(perPersonDay, opts.unit)} × ${heads} ${heads === 1 ? role : ROLE_PLURAL[role].toLowerCase()} × ${days} day${days === 1 ? '' : 's'}`;
    team_kpis.push(m);
  };
  const total = (k) => (cards) => add(cards, k);
  if (roles.includes('closer')) {
    const T = live.targets.closer;
    teamRow('closer', 'revenue', 'Cash collected', total('revenue'), T.revenue, { unit: 'money' });
    teamRow('closer', 'calls', 'Closing calls taken', total('calls'), T.calls);
    teamRow('closer', 'show_rate', 'Closing show rate', (c) => pct(add(c, 'showed'), add(c, 'calls')), T.show_rate, { unit: 'pct', rate: true });
    teamRow('closer', 'close_rate', 'Close rate', (c) => pct(add(c, 'won'), add(c, 'showed')), T.close_rate, { unit: 'pct', rate: true });
  }
  if (roles.includes('triage')) {
    const T = live.targets.triage;
    teamRow('triage', 'calls', 'Triage calls taken', total('calls'), T.calls);
    teamRow('triage', 'show_rate', 'Triage show rate', (c) => pct(add(c, 'showed'), add(c, 'calls')), T.show_rate, { unit: 'pct', rate: true });
    teamRow('triage', 'qualified', 'Qualified rate', (c) => pct(add(c, 'qualified'), add(c, 'showed')), T.qualified_rate, { unit: 'pct', rate: true });
  }
  if (roles.includes('setter')) {
    const T = live.targets.setter;
    teamRow('setter', 'bookings', 'Calls booked', total('calls_booked'), T.calls_booked);
    teamRow('setter', 'messages', 'Messages', total('messages'), T.messages);
    teamRow('setter', 'outbounds', 'Outbounds', total('outbounds'), T.outbounds);
    teamRow('setter', 'links', 'Links sent', total('links'));
  }

  const { setters, triages, closers } = out;
  const everyone = [...setters, ...triages, ...closers];
  const team = {
    calls_booked: add(setters, 'calls_booked'),
    triage_calls: add(triages, 'calls'), qualified: add(triages, 'qualified'),
    calls_taken: add(closers, 'calls'), showed: add(closers, 'showed'), won: add(closers, 'won'), lost: add(closers, 'lost'),
    revenue: add(closers, 'revenue'), deal: add(closers, 'deal'),
    show_rate: pct(add(closers, 'showed'), add(closers, 'calls')), close_rate: pct(add(closers, 'won'), add(closers, 'showed')),
    messages: add(setters, 'messages'),
    reports_filed: add(everyone, 'days_filed'),
    // one day: people who haven't filed. a period: every expected report that is missing.
    reports_missing: everyone.reduce((a, c) => a + c.days_missed.length, 0)
      + roles.reduce((a, r) => a + not_filed[r].length * expected.length, 0),
  };

  const reportsExpected = team.reports_filed + team.reports_missing;
  const filedKpi = finish({ key: 'reports', label: 'Days reported', value: team.reports_filed, target: reportsExpected }, null);
  filedKpi.note = reportsExpected ? `${team.reports_missing} missing` : '';
  team_kpis.push(filedKpi);

  return {
    status: 'ok', start, end, date: end, today, days: dates.length, single_day: dates.length === 1,
    range: preset ? query.range : '',
    roles, all_roles: ROLES, people, filter: { role: roleFilter, person: query.person ? EOD.canonicalRep(query.person) : '' },
    team, team_kpis, setters, triages, closers, not_filed,
    expected_days: Object.fromEntries(roles.map((r) => [r, expected.length])),
    previous: { start: prevDates[0], end: prevDates[prevDates.length - 1] },
    targets: live.targets,
    currency_symbol: live.currency_symbol,
  };
}

/** rep|seat → how many targets they hit that day, for the digest's status dots. */
async function statusFor(date) {
  const s = await getScorecard({ date });
  const out = {};
  for (const c of [...s.setters, ...s.triages, ...s.closers]) {
    out[`${c.name.toLowerCase()}|${c.role}`] = { hit: c.kpis_hit, total: c.kpis_total, crit: c.kpis_crit };
  }
  return out;
}

/* ------------------------------------------------------- missed-report reminder */
// Pings, by name, whoever on the team has not filed today, in that seat's own EOD
// channel. Silent when everyone has filed. Someone whose calls are in but whose day
// is not signed off is asked to sign off.
//
//   GET /api?action=nudge            (cron, CRON_SECRET)
//   GET /api?action=nudge&dry=1      report who is missing, post nothing
//   GET /api?action=nudge&force=1    ignore the hour/day gate
//
// The schedule calls in every hour and this only acts when the LOCAL hour is the
// reminder hour, so the time and timezone can be changed on /settings with no redeploy.
async function runNudge(query = {}, base = '') {
  const { date: today, hour, dow } = LIVE.localNow();
  const { enabled, hour: at, days, roles } = live.nudge;
  const force = query.force === '1', dry = query.dry === '1';

  if (!force && !enabled) return { status: 'skipped', reason: 'reminders are switched off' };
  if (!force && hour !== at) return { status: 'skipped', reason: `local hour is ${hour}, reminder hour is ${at}` };
  if (!force && !days.includes(dow)) return { status: 'skipped', reason: 'not a reminder day' };
  if (!force && !dry && !(await firstRun(`nudge:${today}`))) return { status: 'skipped', reason: 'already sent today' };

  const [reports, signoffs] = await Promise.all([EOD.reportsBetween(today, today), EOD.signoffsBetween(today, today)]);
  const has = (list, role, name) => list.some((r) => r.role === role && key(r.rep) === key(name));

  const out = { status: 'ok', date: today, dry, roles: {} };
  const byChannel = new Map();                       // triage and closing share a channel: one post
  for (const role of roles) {
    const team = live.roster[role].filter((p) => p.nudge);
    if (!team.length) { out.roles[role] = { skipped: 'nobody on the team list' }; continue; }
    const missing = team.filter((p) => !has(reports, role, p.name) && !has(signoffs, role, p.name));
    const unsigned = team.filter((p) => has(reports, role, p.name) && !has(signoffs, role, p.name));
    out.roles[role] = { filed: team.length - missing.length - unsigned.length, missing: missing.map((p) => p.name), unsigned: unsigned.map((p) => p.name) };
    if (!missing.length && !unsigned.length) continue;
    const channel = D.channelFor(role);
    if (!byChannel.has(channel)) byChannel.set(channel, { lines: [], users: [], roles: [] });
    const post = byChannel.get(channel);
    // A mention only notifies with the member's own Discord ID; otherwise name them in bold.
    const who = (list) => list.map((p) => (p.discord ? `<@${p.discord}>` : `**${p.name}**`)).join(' ');
    const link = `${base}/eod?report=${role}`;
    if (missing.length) post.lines.push(`⏰ ${who(missing)}, today's ${role === 'closer' ? 'closing' : role} EOD hasn't been filed yet. [File it now](${link}) · takes two minutes, and the numbers only count if they're in.`);
    if (unsigned.length) post.lines.push(`📝 ${who(unsigned)}, your calls are in but the day isn't signed off. [Sign off](${link}&mode=signoff)`);
    post.users.push(...[...missing, ...unsigned].map((p) => p.discord).filter(Boolean));
    post.roles.push(role);
  }
  if (dry) return out;

  for (const [channel, post] of byChannel) {
    let posted;
    try {
      const msg = await D.post(channel, { content: post.lines.join('\n').slice(0, 1900), allowed_mentions: { users: [...new Set(post.users)] }, flags: 4 });
      posted = msg ? msg.url : 'no channel connected';
    } catch (e) { posted = `failed: ${e.message}`; }
    for (const role of post.roles) out.roles[role].posted = posted;
  }
  return out;
}

module.exports = { getScorecard, statusFor, runNudge, shiftDate };
