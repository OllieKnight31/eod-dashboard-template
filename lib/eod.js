// Turning a report into journey movement, CRM movement and a Discord card.
//
// Three reports, one lead each: the setter's (a call booked, or not), the
// triage report (the first call) and the closer's. Each writes one row into
// Call EOD Reports, stamps the lead in 💰 Sales, moves them on the journey
// board, sets the CRM stage (which the GHL⇄Notion sync pushes to GHL) and
// posts a card. The sign-off at the end of the day counts what was filed.

const CFG = require('../journey.config.json');
const N = require('./notion');
const J = require('./journey');
const D = require('./discord');
const LIVE = require('./live');

const C = D.COLOUR;
const ROLE_LABEL = { setter: 'Setter', triage: 'Triage', closer: 'Closer' };
const CALL_TYPE  = { setter: 'Setting', triage: 'Triage Call', closer: 'Closing Call' };
const ROLE_OF_TYPE = { Setting: 'setter', 'Triage Call': 'triage', 'Closing Call': 'closer' };
// Triage and closing are two seats but often one person takes both, so
// the form's board and the sign-off cover both; the reports stay separate.
const CALL_SEATS = ['triage', 'closer'];

// role -> outcome key -> what it means. `stage` is the CRM stage written to
// 💰 Sales (the sync carries it to GHL); `journey` the board stage; `exit` an
// exit column; `tri`/`clo` the outcome stamped on the lead.
const OUTCOMES = {
  setter: {
    booked:         { label: 'Triage call booked',       attend: 'Booked',   stage: 'Triage Call Booked', emoji: '📅', colour: C.green },
    follow_up:      { label: 'Follow-up — not booked',   attend: 'Not held', emoji: '🔁', colour: C.amber },
    not_interested: { label: 'Not interested',           attend: 'Not held', stage: 'Lost', exit: 'lost', emoji: '🔴', colour: C.red },
    not_qualified:  { label: 'Not qualified — rejected', attend: 'Not held', stage: 'Rejected', exit: 'rejected', emoji: '⛔', colour: C.red },
    no_response:    { label: 'No response',              attend: 'Not held', emoji: '📣', colour: C.grey },
  },
  triage: {
    closing_booked: { label: 'Closing call booked',      attend: 'Showed', stage: 'Closing Call Booked', journey: 6, tri: 'Showed — advancing', emoji: '🎤', colour: C.green },
    advance:        { label: 'Sending nurture pack',     attend: 'Showed', journey: 6, tri: 'Showed — advancing', emoji: '📨', colour: C.blue },
    not_qualified:  { label: 'Not qualified — rejected', attend: 'Showed', stage: 'Rejected', exit: 'rejected', tri: 'Rejected', emoji: '⛔', colour: C.red },
    follow_up:      { label: 'Follow-up booked',         attend: 'Showed', stage: 'Follow-Up', journey: 5, tri: 'Showed — follow-up', emoji: '🔁', colour: C.amber },
    live_no_close:  { label: 'Held — no decision',       attend: 'Showed', journey: 5, tri: 'Showed — follow-up', emoji: '⏸️', colour: C.grey },
    no_show:        { label: 'No-show',                  attend: 'No-show', stage: 'No-Show', journey: 5, tri: 'No-show', emoji: '🙈', colour: C.grey },
    rescheduled:    { label: 'Rescheduled',              attend: 'Rescheduled', journey: 5, tri: 'Rescheduled', emoji: '📆', colour: C.grey },
  },
  closer: {
    // `label` stays what the data and stats read; `shown` is what people see.
    closed_won:     { label: 'Closed Won', shown: 'Contract Signed', attend: 'Showed', journey: 8, clo: 'Won', emoji: '🏆', colour: C.gold },
    closed_lost:    { label: 'Closed Lost',              attend: 'Showed', stage: 'Lost', exit: 'lost', clo: 'Lost', emoji: '🔴', colour: C.red },
    follow_up:      { label: 'Follow-up booked',         attend: 'Showed', stage: 'Follow-Up', journey: 7, clo: 'Follow-up', emoji: '🔁', colour: C.amber },
    live_no_close:  { label: 'Held — no decision',       attend: 'Showed', journey: 7, clo: 'Follow-up', emoji: '⏸️', colour: C.grey },
    not_qualified:  { label: 'Not qualified — rejected', attend: 'Showed', stage: 'Rejected', exit: 'rejected', emoji: '⛔', colour: C.red },
    no_show:        { label: 'No-show',                  attend: 'No-show', stage: 'No-Show', journey: 7, clo: 'No-show', emoji: '🙈', colour: C.grey },
    rescheduled:    { label: 'Rescheduled',              attend: 'Rescheduled', journey: 7, emoji: '📆', colour: C.grey },
  },
};

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const nurl = (id) => `https://www.notion.so/${String(id).replace(/-/g, '')}`;
const s = (v) => (v === undefined || v === null ? '' : String(v).trim());

function normaliseRole(p) {
  const r = s(p.role).toLowerCase();
  if (r === 'setter' || r === 'triage' || r === 'closer') return r;
  const t = s(p.call_type).toLowerCase();
  if (t === 'closing') return 'closer';
  if (t === 'triage') return 'triage';
  if (t === 'setting') return 'setter';
  return 'closer';
}

/** A typed name → the team's spelling, so a nickname and a full name (set as aka in the team list) file as one person. */
function canonicalRep(name) {
  const t = D.teamMember(name);
  return t ? t.name : s(name);
}

const sameRep = (a, b) => canonicalRep(a).toLowerCase() === canonicalRep(b).toLowerCase();
const rostered = (seat, rep) => (LIVE.live.roster[seat] || []).some((t) => sameRep(t.name, rep));

function leadView(row) {
  if (!row) return null;
  const no = N.readProp(row, 'Journey #');
  const jst = N.readProp(row, 'Journey Stage');
  return {
    id: row.id,
    name: N.readProp(row, 'Lead') || '',
    email: N.readProp(row, 'Email') || '',
    phone: N.readProp(row, 'Phone') || '',
    instagram: N.readProp(row, 'Instagram') || '',
    stage: N.readProp(row, 'Stage') || '',
    journey: jst || '',
    journeyNo: no,
    stageLine: [N.readProp(row, 'Stage'), jst].filter(Boolean).join(' · '),
    ghl: N.readProp(row, 'GHL Link') || '',
    url: nurl(row.id),
    nextCallAt: N.readProp(row, 'Next Call At'),
    nextCallType: N.readProp(row, 'Next Call Type'),
    nextCallWith: N.readProp(row, 'Next Call With'),
    calendly: N.readProp(row, 'Calendly Link') || '',
  };
}

async function resolveLead(call) {
  if (s(call.lead_id)) {
    try { const p = await N.notion('GET', `/pages/${s(call.lead_id)}`); if (p && !p.archived) return p; } catch (e) { /* fall through */ }
  }
  return (await N.findLeadByEmail(s(call.prospect_email))) || (await N.findLeadByName(s(call.prospect_name)));
}

function mapLoss(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/price|cost|afford|budget|money|financ/.test(t)) return 'Price';
  if (/tim|later|not now|next year|think/.test(t)) return 'Timing';
  if (/qualif|not right|wrong fit|bad fit/.test(t)) return 'Bad Fit';
  if (/ghost|silen|no reply|unrespons|no response/.test(t)) return 'Ghosted';
  return 'Other';
}

/* ================================================================ a call */

/**
 * Files one report and moves its lead.
 * call: { lead_id?, prospect_name, prospect_email, outcome, booked_for, booked_with,
 *         lead_source, setter, fit, budget_band, decision_maker, timeline, package,
 *         payment_type, ticket, cash_collected, lost_reason, objections,
 *         follow_up_date, follow_up_action, recording_url, notes }
 */
async function fileCall({ role, rep, date, call, base }) {
  const R = normaliseRole({ role, call_type: call.call_type });
  const def = OUTCOMES[R][s(call.outcome)];
  if (!def) throw new Error(`Unknown ${R} outcome "${s(call.outcome)}"`);
  rep = canonicalRep(rep);

  const row = await resolveLead(call);
  const lead = leadView(row);
  const name = lead?.name || s(call.prospect_name) || s(call.prospect_email) || 'Unnamed lead';
  const cash = num(call.cash_collected), ticket = num(call.ticket);

  let stage = def.stage || null;
  if (R === 'closer' && call.outcome === 'closed_won') stage = cash > 0 ? 'Closed' : 'Awaiting Payment';

  const bookedFor = s(call.booked_for) || null;
  const objection = [s(call.lost_reason), s(call.objections)].filter(Boolean).join(' — ');

  const report = await N.createPage(N.DB.eod, {
    Report: `${date} · ${CALL_TYPE[R]} · ${name}`,
    Date: date,
    'Call type': CALL_TYPE[R],
    Role: ROLE_LABEL[R],
    Rep: rep,
    Attendance: def.attend,
    Outcome: def.label,
    'Tier discussed': s(call.package) || null,
    'Budget band': s(call.budget_band) || null,
    Fit: s(call.fit) || null,
    'Decision maker': s(call.decision_maker) || null,
    Timeline: s(call.timeline) || null,
    'Payment type': s(call.payment_type) || null,
    Ticket: ticket,
    'Cash collected': cash,
    'Collection amount': call.outcome === 'closed_won' ? num(call.collection_amount) : null,
    'Collection date': (call.outcome === 'closed_won' && s(call.collection_date)) || null,
    'Main objection': objection,
    'Next step': s(call.follow_up_action),
    'Next step due': s(call.follow_up_date) || null,
    'Booked for': bookedFor,
    'Booked with': s(call.booked_with),
    Setter: s(call.setter),
    Recording: s(call.recording_url) || null,
    Notes: s(call.notes),
    Source: s(call.lead_source) || null,
    'Applied to journey': !!row,
    'Stage set': stage || '',
    Lead: row ? [row.id] : [],
  });

  let moved = false;
  if (row) {
    const patch = {};
    if (stage) patch.Stage = stage;
    if (s(call.lead_source) && !N.readProp(row, 'Source')) patch.Source = mapSource(call.lead_source);

    if (R === 'setter') {
      patch['Set By'] = rep;
      if (call.outcome === 'booked') {
        patch['Next Call At'] = bookedFor;
        patch['Next Call Type'] = 'Triage';
        patch['Next Call With'] = s(call.booked_with) || null;
      }
      if (s(call.follow_up_date)) patch['Next Action Due'] = s(call.follow_up_date);
    }

    if (R === 'triage') {
      patch['Triage Date'] = date;
      if (def.tri) patch['Triage Outcome'] = def.tri;
      if (s(call.package)) patch.Tier = s(call.package);
      if (s(call.budget_band)) patch.Budget = s(call.budget_band);
      if (call.outcome === 'closing_booked') {
        patch['Next Call At'] = bookedFor;
        patch['Next Call Type'] = 'Closing';
        patch['Next Call With'] = s(call.booked_with) || null;
      } else if (call.outcome === 'rescheduled') {
        patch['Next Call At'] = bookedFor;
        patch['Next Call Type'] = 'Triage';
      } else {
        // the triage call this row was waiting on has now happened
        patch['Next Call At'] = null; patch['Next Call Type'] = null; patch['Next Call With'] = null;
      }
    }

    if (R === 'closer') {
      patch['Closing Date'] = date;
      if (def.clo) patch['Closing Outcome'] = def.clo;
      if (s(call.package)) patch.Tier = s(call.package);
      if (call.outcome === 'closed_won') {
        if (cash > 0) patch['Paid Date'] = date;
        if (ticket !== null) patch['Deal Size'] = ticket;
        if (cash !== null) patch['Cash Collected'] = cash;
        patch['Opp Status'] = 'Won';
      } else if (call.outcome === 'closed_lost') {
        patch['Loss Reason'] = mapLoss(objection);
        patch['Opp Status'] = 'Lost';
      } else if (cash > 0) {
        patch['Cash Collected'] = (N.readProp(row, 'Cash Collected') || 0) + cash;
      }
      if (call.outcome === 'rescheduled') {
        patch['Next Call At'] = bookedFor; patch['Next Call Type'] = 'Closing';
      } else {
        patch['Next Call At'] = null; patch['Next Call Type'] = null; patch['Next Call With'] = null;
      }
    }

    if (s(call.follow_up_action)) patch['Next Action'] = null; // multi-select in Sales; the text lives on the report
    if (s(call.follow_up_date)) patch['Next Action Due'] = s(call.follow_up_date);

    const before = N.readProp(row, 'Journey #') || 0;
    if (def.exit) { await J.exit(row, def.exit, patch); moved = true; }
    else if (def.journey) { await J.advance(row, def.journey, 'eod-report', patch); moved = def.journey > before; }
    else await N.updatePage(row.id, N.DB.sales, patch);
  }

  // The card. Best-effort: a Discord failure is logged, never thrown.
  let msg = null;
  try {
    msg = await D.post(D.channelFor(R), D.callCard({
      role: R, rep, date, outcome: def, lead, call, stage, moved, base,
    }));
    if (msg) await N.updatePage(report.id, N.DB.eod, { Discord: msg.url });
  } catch (e) { console.error('[eod] discord', e.message); }

  return {
    report: report.id, reportUrl: nurl(report.id),
    lead, matched: !!row, moved, stage, outcome: def.shown || def.label,
    discord: msg ? msg.url : null, who: name,
  };
}

// The form's lead sources → the Sales `Source` select (its options are fixed).
function mapSource(v) {
  const t = String(v || '').toLowerCase();
  if (/ads|paid/.test(t)) return 'Ads';
  if (/referr|introduc/.test(t)) return 'Referral';
  if (/website|applic|inbound|dm/.test(t)) return 'Inbound';
  if (/webinar/.test(t)) return 'Webinar';
  if (/instagram|organic|event|podcast|press/.test(t)) return 'Organic';
  return 'Other';
}

/* =========================================================== counting */

function reportView(r) {
  const type = N.readProp(r, 'Call type');
  const leadIds = N.readProp(r, 'Lead') || [];
  const title = N.readProp(r, 'Report') || '';
  return {
    id: r.id, url: nurl(r.id),
    created: r.created_time,
    date: N.readProp(r, 'Date'),
    type, role: ROLE_OF_TYPE[type] || 'closer',
    rep: N.readProp(r, 'Rep') || '',
    outcome: N.readProp(r, 'Outcome') || '',
    attendance: N.readProp(r, 'Attendance') || '',
    cash: N.readProp(r, 'Cash collected') || 0,
    ticket: N.readProp(r, 'Ticket') || 0,
    tier: N.readProp(r, 'Tier discussed'),
    objection: N.readProp(r, 'Main objection') || '',
    next: N.readProp(r, 'Next step') || '',
    nextDue: N.readProp(r, 'Next step due'),
    bookedFor: N.readProp(r, 'Booked for'),
    bookedWith: N.readProp(r, 'Booked with') || '',
    stageSet: N.readProp(r, 'Stage set') || '',
    discord: N.readProp(r, 'Discord'),
    notes: N.readProp(r, 'Notes') || '', source: N.readProp(r, 'Source') || '', setter: N.readProp(r, 'Setter') || '',
    recording: N.readProp(r, 'Recording'),
    leadId: leadIds[0] || null,
    leadUrl: leadIds[0] ? nurl(leadIds[0]) : null,
    name: title.split(' · ').slice(2).join(' · ') || title,
    fit: N.readProp(r, 'Fit'), budget: N.readProp(r, 'Budget band'),
    timeline: N.readProp(r, 'Timeline'), decision: N.readProp(r, 'Decision maker'),
  };
}

/** Counts over a list of reportViews. */
function tally(list) {
  const t = { calls: list.length, scheduled: 0, held: 0, showed: 0, no_shows: 0, rescheduled: 0,
    booked: 0, qualified: 0, closing_booked: 0, nurture: 0, rejected: 0, won: 0, lost: 0,
    follow_ups: 0, not_interested: 0, cash: 0, deal: 0, setting: 0, triage: 0, closing: 0 };
  for (const r of list) {
    t[r.role === 'setter' ? 'setting' : r.role === 'triage' ? 'triage' : 'closing']++;
    if (r.attendance === 'Showed') { t.showed++; t.held++; t.scheduled++; }
    else if (r.attendance === 'No-show') { t.no_shows++; t.scheduled++; }
    else if (r.attendance === 'Rescheduled') { t.rescheduled++; t.scheduled++; }
    switch (r.outcome) {
      case 'Triage call booked': t.booked++; break;
      case 'Closing call booked': t.qualified++; t.closing_booked++; break;
      case 'Sending nurture pack': t.qualified++; t.nurture++; break;
      case 'Not qualified — rejected': t.rejected++; break;
      case 'Closed Won': t.won++; t.deal += r.ticket || 0; break;
      case 'Closed Lost': t.lost++; break;
      case 'Follow-up booked': case 'Held — no decision': case 'Follow-up — not booked': t.follow_ups++; break;
      case 'Not interested': t.not_interested++; break;
      default: break;
    }
    t.cash += r.cash || 0;
  }
  return t;
}

const dayFilter = (since, until, prop = 'Date') => {
  const and = [];
  if (since) and.push({ property: prop, date: { on_or_after: since } });
  if (until) and.push({ property: prop, date: { on_or_before: until } });
  return and.length ? { and } : null;
};

async function reportsBetween(since, until, extra = []) {
  const f = dayFilter(since, until);
  const filter = extra.length ? { and: [...(f ? f.and : []), ...extra] } : f;
  const rows = await N.queryAll(N.DB.eod, filter, [{ timestamp: 'created_time', direction: 'descending' }], 2000);
  return rows.map(reportView);
}

function signoffView(r) {
  return {
    id: r.id, url: nurl(r.id), date: N.readProp(r, 'Date'), created: r.last_edited_time || r.created_time,
    rep: N.readProp(r, 'Rep') || '', role: (N.readProp(r, 'Role') || '').toLowerCase(),
    hit_kpis: N.readProp(r, 'Hit KPIs'), no_calls: !!N.readProp(r, 'No calls'),
    held: N.readProp(r, 'Calls held') || 0, showed: N.readProp(r, 'Showed') || 0,
    no_shows: N.readProp(r, 'No-shows') || 0, qualified: N.readProp(r, 'Qualified') || 0,
    closing_booked: N.readProp(r, 'Closing calls booked') || 0,
    won: N.readProp(r, 'Won') || 0, lost: N.readProp(r, 'Lost') || 0,
    cash: N.readProp(r, 'Cash collected') || 0, deal: N.readProp(r, 'Deal value') || 0,
    booked: N.readProp(r, 'Calls booked') || 0, messages: N.readProp(r, 'Messages sent') || 0,
    outbounds: N.readProp(r, 'Outbounds') || 0, inbounds: N.readProp(r, 'Inbounds') || 0,
    conversations: N.readProp(r, 'Active conversations') || 0, links: N.readProp(r, 'Links sent') || 0,
    wins: N.readProp(r, 'Wins') || '', blockers: N.readProp(r, 'Blockers') || '',
    notes: N.readProp(r, 'Notes') || '', hottest: N.readProp(r, 'Hottest lead') || '',
    discord: N.readProp(r, 'Discord'),
  };
}

async function signoffsBetween(since, until) {
  if (!N.DB.signoff) return [];
  const rows = await N.queryAll(N.DB.signoff, dayFilter(since, until), [{ property: 'Date', direction: 'descending' }], 1000);
  return rows.map(signoffView);
}

/* ============================================================ sign-off */

async function fileSignoff({ role, rep, date, p, base }) {
  const R = normaliseRole({ role });
  rep = canonicalRep(rep);
  const n = (k) => num(p[k]);

  // Notion refuses a filter on a select value that is not yet an option, and a
  // new rep's name is exactly that — so filter by date, match role and name here.
  const mine = (await reportsBetween(date, date)).filter((r) => sameRep(r.rep, rep));

  // One sign-off closes every call seat the rep filed in today, so two triage
  // reports signed off under Closer still count. Each seat keeps its own row.
  const seatList = R === 'setter' ? ['setter']
    : CALL_SEATS.filter((k) => k === R || mine.some((r) => r.role === k) || rostered(k, rep));
  const seats = seatList.map((k) => {
    const reports = mine.filter((r) => r.role === k);
    return { role: k, reports, counts: tally(reports) };
  });
  // The day's words (wins, blockers, notes) sit on one row: the seat signed under
  // if it has calls, else the seat that does.
  const primary = (seats.find((x) => x.role === R && x.reports.length) || seats.find((x) => x.reports.length) || seats.find((x) => x.role === R)).role;

  const existing = N.DB.signoff ? (await N.queryAll(N.DB.signoff, { property: 'Date', date: { equals: date } }, null, 100))
    .filter((r) => sameRep(N.readProp(r, 'Rep'), rep)) : [];

  const rows = {};
  for (const seat of seats) {
    const k = seat.role, counts = seat.counts, main = k === primary;
    const values = {
      'Sign-off': `${date} · ${rep} · ${ROLE_LABEL[k]}`,
      Date: date, Rep: rep, Role: ROLE_LABEL[k],
      'Hit KPIs': s(p.hit_kpis) || null,
      'No calls': !seat.reports.length && (k !== R || !!p.no_calls),
      'Calls held': counts.scheduled, Showed: counts.showed, 'No-shows': counts.no_shows,
      Qualified: counts.qualified, 'Closing calls booked': counts.closing_booked,
      Won: counts.won, Lost: counts.lost,
      'Cash collected': counts.cash || null, 'Deal value': counts.deal || null,
      'Calls booked': k === 'setter' ? (n('calls_booked') ?? counts.booked) : (k === 'triage' ? (n('calls_booked') ?? counts.closing_booked) : null),
      'Messages sent': n('messages_sent'), Outbounds: n('outbounds'), Inbounds: n('inbounds'),
      'Active conversations': n('active_conversations'), 'Links sent': n('links_sent'),
      'Hottest lead': s(p.hottest_lead),
      Wins: main ? s(p.wins) : '', Blockers: main ? s(p.blockers) : '',
      Notes: main ? [s(p.notes), p.no_calls && s(p.no_calls_notes) ? `No calls: ${s(p.no_calls_notes)}` : ''].filter(Boolean).join('\n') : '',
      Reports: seat.reports.map((r) => r.id),
    };
    const had = existing.find((r) => (N.readProp(r, 'Role') || '').toLowerCase() === ROLE_LABEL[k].toLowerCase());
    if (had) { await N.updatePage(had.id, N.DB.signoff, values); rows[k] = had; }
    else rows[k] = await N.createPage(N.DB.signoff, values);
    seat.values = values;

    // Each report points back at the sign-off that closed its day.
    await Promise.all(seat.reports.map((r) => N.updatePage(r.id, N.DB.eod, { 'Sign-off': [rows[k].id] }).catch(() => {})));
  }
  const row = rows[primary];
  const reports = seats.flatMap((x) => x.reports);
  const counts = tally(reports);

  // Setters also feed Setter Daily Activity — stage 1's conversation volume
  // on the Client Journey reads Inbounds + Outbounds from there.
  if (R === 'setter') await mirrorSetterDay({ ...p, date, setter: rep, calls_booked: seats[0].values['Calls booked'] }).catch((e) => console.error('[eod] setter mirror', e.message));

  let msg = null;
  try {
    msg = await D.post(D.channelFor(R), D.signoffCard({ role: R, rep, date, counts, seats, p, reports, base }));
    if (msg) await Promise.all(Object.values(rows).map((r) => N.updatePage(r.id, N.DB.signoff, { Discord: msg.url })));
  } catch (e) { console.error('[eod] discord', e.message); }

  return {
    signoff: row.id, url: nurl(row.id), rep, role: R, counts,
    seats: Object.fromEntries(seats.map((x) => [x.role, x.counts])),
    reports: reports.length, discord: msg ? msg.url : null,
  };
}

async function mirrorSetterDay(p) {
  const n = (k) => num(p[k]);
  const values = {
    Day: `${p.date} · ${p.setter}`, Date: p.date, Setter: p.setter,
    Channel: s(p.lead_source) || null,
    'Active conversations': n('active_conversations'),
    'Messages sent': n('messages_sent'), Outbounds: n('outbounds'), Inbounds: n('inbounds'),
    'Links sent': n('links_sent'), 'Calls booked': n('calls_booked'), 'Calls held': n('calls_held'),
    'Closing calls booked': n('closing_calls_booked'), Cancellations: n('cancellations'),
    'Profile visits': n('profile_visits'), 'New followers': n('new_followers'),
    'Lead quality': s(p.lead_quality), 'Hottest lead': s(p.hottest_lead), 'Hit KPIs': s(p.hit_kpis),
    Notes: s(p.notes),
  };
  const have = await N.queryAll(N.DB.setter, { property: 'Day', title: { equals: values.Day } }, null, 5);
  if (have[0]) return N.updatePage(have[0].id, N.DB.setter, values);
  return N.createPage(N.DB.setter, values);
}

/* ============================================================ the form's boot */

/** What the form needs when it opens: calls waiting for a report, what this rep filed today, names. */
async function board({ role, rep, date }) {
  const R = normaliseRole({ role });
  const dayEnd = `${date}T23:59:59.000Z`;
  const seatList = R === 'setter' ? ['setter'] : CALL_SEATS;
  let due = [];
  if (R === 'triage' || R === 'closer') {
    const TYPE = { triage: 'Triage', closer: 'Closing' };
    const callsDue = (k) => N.queryAll(N.DB.sales, { and: [
      { property: 'Next Call Type', select: { equals: TYPE[k] } },
      { property: 'Next Call At', date: { on_or_before: dayEnd } },
    ] }, [{ property: 'Next Call At', direction: 'ascending' }], 40);
    const other = CALL_SEATS.find((k) => k !== R);
    const [own, theirs] = await Promise.all([callsDue(R), rep ? callsDue(other).catch(() => []) : []]);
    // The other seat's calls only when they are this rep's: on that roster, or booked with them.
    const also = theirs.filter((row) => rostered(other, rep) || sameRep(N.readProp(row, 'Next Call With') || '', rep));
    due = [...own, ...also].map(leadView)
      .sort((a, b) => String(a.nextCallAt || '').localeCompare(String(b.nextCallAt || '')));
  } else {
    const rows = await N.queryAll(N.DB.sales, { and: [
      { property: 'Next Action Due', date: { on_or_before: date } },
      { property: 'Next Call At', date: { is_empty: true } },
      { or: ['New Lead', 'Contacted', 'In conversation', 'Applied', 'No response. Reach out!', 'Follow-Up']
          .map((st) => ({ property: 'Stage', select: { equals: st } })) },
    ] }, [{ property: 'Next Action Due', direction: 'ascending' }], 30);
    due = rows.map(leadView);
  }

  const filedAll = await reportsBetween(date, date);
  const mine = filedAll.filter((r) => seatList.includes(r.role) && (!rep || sameRep(r.rep, rep)));
  const seats = Object.fromEntries(seatList.map((k) => {
    const list = mine.filter((r) => r.role === k);
    return [k, { filed: list.length, counts: tally(list) }];
  }));
  const since = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const recent = await reportsBetween(since, null);
  const names = new Set(LIVE.live.team.map((t) => t.name));
  for (const r of recent) if (r.rep) names.add(r.rep);
  const signed = rep && N.DB.signoff ? (await N.queryAll(N.DB.signoff, { property: 'Date', date: { equals: date } }, null, 100))
    .some((r) => sameRep(N.readProp(r, 'Rep'), rep) && seatList.includes((N.readProp(r, 'Role') || '').toLowerCase())) : false;

  return {
    role: R, date, due,
    // filed: this seat's reports, plus the other call seat's when the rep took both.
    filed: mine.map((r) => ({ id: r.id, role: r.role, name: r.name, outcome: r.outcome, at: r.created, url: r.url, discord: r.discord, leadUrl: r.leadUrl })),
    counts: seats[R].counts,
    seats,
    people: { all: [...names], byRole: Object.fromEntries(['setter', 'triage', 'closer'].map((k) =>
      [k, LIVE.live.roster[k].map((t) => t.name)])) },
    signed,
  };
}

module.exports = {
  OUTCOMES, ROLE_LABEL, CALL_TYPE, CALL_SEATS, rostered, fileCall, fileSignoff, board, tally,
  reportsBetween, signoffsBetween, reportView, signoffView, leadView, canonicalRep, normaliseRole, nurl,
};
