// /reports — the EOD dashboard.
//
// What was filed, by whom, with what result; the call funnel it adds up to;
// who is sitting on a booked call with no report; and who has not signed off.
// Server-rendered from Notion on every request, same shell as /journey.

const CFG = require('../journey.config.json');
const STATE = require('./state');
const N = require('./notion');
const B = require('./brand');
const EOD = require('./eod');
const DG = require('./digest');

const shift = (ymd, days) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const money = (n) => (n ? `$${Math.round(n).toLocaleString('en-US')}` : '$0');
const fmtWhen = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return String(iso);
  const dateOnly = !String(iso).includes('T');
  return d.toLocaleString('en-GB', { timeZone: CFG.eod?.timezone || 'Europe/London', day: 'numeric', month: 'short', ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }) });
};

function windowOf(q) {
  const today = DG.localParts().date;
  const key = q.range || (q.since ? 'custom' : '7d');
  const W = {
    today:     { since: today, until: today, label: 'Today' },
    yesterday: { since: shift(today, -1), until: shift(today, -1), label: 'Yesterday' },
    '7d':      { since: shift(today, -6), until: today, label: 'Last 7 days' },
    '30d':     { since: shift(today, -29), until: today, label: 'Last 30 days' },
    all:       { since: null, until: null, label: 'All time' },
  };
  if (key === 'custom') return { key, since: q.since || null, until: q.until || today, label: `${q.since || 'start'} → ${q.until || today}`, today };
  return { key, ...(W[key] || W['7d']), today };
}

async function gather(q = {}) {
  const w = windowOf(q);
  const [allReports, allSignoffs] = await Promise.all([
    EOD.reportsBetween(w.since, w.until),
    EOD.signoffsBetween(w.since, w.until),
  ]);
  const repF = q.rep ? EOD.canonicalRep(q.rep).toLowerCase() : null;
  const roleF = q.role && ['setter', 'triage', 'closer'].includes(q.role) ? q.role : null;
  const reports = allReports.filter((r) => (!repF || r.rep.toLowerCase() === repF) && (!roleF || r.role === roleF));
  const signoffs = allSignoffs.filter((r) => (!repF || r.rep.toLowerCase() === repF) && (!roleF || r.role === roleF));

  // per rep
  const per = new Map();
  for (const r of reports) {
    if (!r.rep) continue;
    const k = `${r.rep}|${r.role}`;
    if (!per.has(k)) per.set(k, { rep: r.rep, role: r.role, list: [], signoffs: [], days: new Set() });
    per.get(k).list.push(r); per.get(k).days.add(r.date);
  }
  for (const so of signoffs) {
    const k = `${so.rep}|${so.role}`;
    if (!per.has(k)) per.set(k, { rep: so.rep, role: so.role, list: [], signoffs: [], days: new Set() });
    per.get(k).signoffs.push(so); per.get(k).days.add(so.date);
  }
  const order = { setter: 0, triage: 1, closer: 2 };
  const reps = [...per.values()].map((p) => {
    const t = EOD.tally(p.list);
    const kp = { Yes: 0, Partial: 0, No: 0 };
    for (const so of p.signoffs) if (so.hit_kpis in kp) kp[so.hit_kpis]++;
    const dms = p.signoffs.reduce((a, so) => a + (so.messages || 0), 0);
    return { ...p, t, kp, dms, days: p.days.size };
  }).sort((a, b) => (order[a.role] - order[b.role]) || a.rep.localeCompare(b.rep));

  const totals = EOD.tally(reports);
  const byRole = { setter: EOD.tally(reports.filter((r) => r.role === 'setter')),
                   triage: EOD.tally(reports.filter((r) => r.role === 'triage')),
                   closer: EOD.tally(reports.filter((r) => r.role === 'closer')) };

  // outcome mix per role
  const mix = {};
  for (const role of ['setter', 'triage', 'closer']) {
    const m = new Map();
    for (const r of reports.filter((x) => x.role === role)) m.set(r.outcome || '—', (m.get(r.outcome || '—') || 0) + 1);
    mix[role] = [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  // objections and loss reasons
  const obj = new Map();
  for (const r of reports) {
    const t = (r.objection || '').trim();
    if (!t) continue;
    const k = t.toLowerCase().slice(0, 70);
    if (!obj.has(k)) obj.set(k, { text: t.slice(0, 90), n: 0, roles: new Set() });
    obj.get(k).n++; obj.get(k).roles.add(r.role);
  }
  const objections = [...obj.values()].sort((a, b) => b.n - a.n).slice(0, 10);

  // booked calls that have passed with no report since
  const nowIso = new Date().toISOString();
  const dueRows = await N.queryAll(N.DB.sales, { and: [
    { property: 'Next Call At', date: { on_or_before: nowIso } },
  ] }, [{ property: 'Next Call At', direction: 'descending' }], 60);
  const lookback = shift(w.today, -30);
  const recentReports = await EOD.reportsBetween(lookback, w.today);
  const lastReportFor = new Map();
  for (const r of recentReports) {
    if (!r.leadId) continue;
    const cur = lastReportFor.get(r.leadId);
    if (!cur || r.created > cur) lastReportFor.set(r.leadId, r.created);
  }
  const waiting = dueRows.map(EOD.leadView).filter((l) => {
    const last = lastReportFor.get(l.id);
    return !last || last < l.nextCallAt;
  });

  // today's sign-off status
  const today = await DG.dayRows(w.today);
  const unsigned = today.rows.filter((r) => !r.signed).map((r) => ({ rep: r.rep, role: r.role, calls: r.calls }));

  const allReps = [...new Set(allReports.map((r) => r.rep).concat(allSignoffs.map((s) => s.rep)).filter(Boolean))].sort();

  return {
    window: w, filters: { rep: q.rep || '', role: roleF || '' }, allReps,
    reports, signoffs, reps, totals, byRole, mix, objections, waiting,
    missingToday: today.missing.map((m) => m.name), unsigned, todayTotals: today.totals,
    at: new Date().toISOString(),
  };
}

/* ---------------------------------------------------------------- CSS */
const CSS = `
body{background:var(--ink);font-size:15px}
.wrap{max-width:1180px}
main{padding-bottom:20px}
.top{padding:26px 0 18px;border-bottom:1px solid rgba(163,163,163,.18)}
.top__row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:18px 30px;justify-content:space-between}
.top h1{font-family:var(--serif);font-weight:300;font-size:clamp(1.5rem,2.6vw,2rem);margin:0;line-height:1.1}
.top .kicker{margin:0 0 6px}
.filters{display:flex;flex-wrap:wrap;gap:8px 6px;margin-top:16px;align-items:center}
.filters .lbl{font-size:.56rem;letter-spacing:.22em;text-transform:uppercase;color:rgba(245,245,245,.38);margin-right:6px}
.chip{font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;padding:6px 10px;border:1px solid rgba(163,163,163,.28);
  color:rgba(245,245,245,.7);white-space:nowrap}
.chip:hover{border-color:var(--gold);color:var(--cream)}
.chip--on{border-color:var(--gold);background:rgba(163,163,163,.14);color:var(--cream)}
.filters .sep{width:1px;height:18px;background:rgba(163,163,163,.2);margin:0 6px}
.dates{display:inline-flex;gap:6px;align-items:center;margin-left:6px;color:rgba(245,245,245,.38);font-size:.7rem}
.dates input{font:inherit;font-size:.7rem;color:var(--cream);background:transparent;border:1px solid rgba(163,163,163,.28);padding:5px 7px;color-scheme:dark}
.dates button{font-family:inherit;background:transparent;cursor:pointer}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:9px;margin-top:20px}
.stat{border:1px solid rgba(163,163,163,.2);background:rgba(163,163,163,.035);padding:12px 13px 11px}
.stat b{display:block;font-family:var(--serif);font-weight:300;font-size:1.6rem;line-height:1;color:var(--cream);font-variant-numeric:tabular-nums}
.stat span{display:block;font-size:.55rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(245,245,245,.42);margin-top:7px}
.stat small{display:block;font-size:.62rem;color:rgba(163,163,163,.7);margin-top:4px;font-variant-numeric:tabular-nums}
.stat--bad b{color:#E2857F}.stat--good b{color:#9FD6A8}
.alert{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:baseline;border:1px solid rgba(226,133,127,.34);
  background:rgba(226,133,127,.07);padding:12px 16px;margin:16px 0 0;font-size:.88rem;line-height:1.5}
.alert b{color:#E2857F;font-weight:500}
.alert--ok{border-color:rgba(159,214,168,.32);background:rgba(159,214,168,.06)}.alert--ok b{color:#9FD6A8}
.alert a{color:var(--gold)}

/* funnel */
.funnel{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin-top:22px}
.fcard{position:relative;border:1px solid rgba(163,163,163,.22);background:rgba(163,163,163,.035);padding:11px 12px}
.fcard__n{font-size:.58rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(163,163,163,.7)}
.fcard__v{font-family:var(--serif);font-weight:300;font-size:1.7rem;line-height:1;color:var(--cream);margin:8px 0 4px;font-variant-numeric:tabular-nums}
.fcard__s{font-size:.62rem;color:rgba(245,245,245,.42);min-height:1em}
.fcard__c{position:absolute;right:-9px;top:50%;transform:translateY(-50%);font-size:.62rem;padding:2px 5px;
  background:var(--ink);border:1px solid rgba(163,163,163,.3);color:var(--gold-lite);z-index:2;font-variant-numeric:tabular-nums}
.fcard:last-child .fcard__c{display:none}
@media (max-width:760px){.fcard__c{display:none}}

/* sections + tables */
.sec{margin-top:34px;padding-top:20px;border-top:1px solid rgba(163,163,163,.18)}
.sec__h{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
.sec h2{font-family:var(--serif);font-weight:300;font-size:1.12rem;margin:0}
.sec__n{font-size:.62rem;letter-spacing:.16em;text-transform:uppercase;color:rgba(245,245,245,.36)}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:.82rem}
th{text-align:right;font-size:.56rem;letter-spacing:.18em;text-transform:uppercase;color:rgba(245,245,245,.36);font-weight:500;padding:7px 10px;border-bottom:1px solid rgba(163,163,163,.2)}
th:first-child,th.l{text-align:left}
td{padding:9px 10px;border-bottom:1px solid rgba(163,163,163,.09);color:rgba(245,245,245,.74);text-align:right;font-variant-numeric:tabular-nums;vertical-align:top}
td:first-child,td.l{text-align:left;color:var(--cream)}
td small{display:block;font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(245,245,245,.3);margin-top:2px}
td .sub{display:block;font-size:.72rem;color:rgba(245,245,245,.45);margin-top:3px;letter-spacing:0;text-transform:none;white-space:normal}
.pill{font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;padding:3px 7px;border:1px solid;white-space:nowrap}
.p-red{color:#E2857F;border-color:rgba(226,133,127,.42)}.p-green{color:#9FD6A8;border-color:rgba(159,214,168,.4)}
.p-amber{color:var(--gold-lite);border-color:rgba(212,212,212,.42)}.p-grey{color:rgba(245,245,245,.5);border-color:rgba(245,245,245,.2)}
.p-blue{color:#9EC5E8;border-color:rgba(158,197,232,.4)}.p-purple{color:#C9A9E0;border-color:rgba(201,169,224,.4)}
.go{color:var(--gold);white-space:nowrap}
.wrapx{overflow-x:auto}
.tgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:9px;margin-top:12px}
.tbox{border:1px solid rgba(163,163,163,.2);background:rgba(163,163,163,.03);padding:11px 13px}
.tbox h3{margin:0 0 9px;font-size:.58rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(245,245,245,.4);font-weight:500}
.brow{display:grid;grid-template-columns:1fr 34px;gap:8px;align-items:center;font-size:.78rem;padding:3px 0;color:rgba(245,245,245,.74)}
.brow b{text-align:right;font-weight:400;color:var(--cream);font-variant-numeric:tabular-nums}
.bar{position:relative;height:16px;background:rgba(163,163,163,.1);overflow:hidden}
.bar i{position:absolute;inset:0 auto 0 0;background:rgba(163,163,163,.42)}
.bar span{position:absolute;left:8px;top:0;line-height:16px;font-size:.66rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;right:6px}
.empty{font-size:.8rem;color:rgba(245,245,245,.42);margin:12px 0 0;line-height:1.6}
.foot{margin-top:26px;padding-top:16px}
.note{font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(245,245,245,.3)}
.nav{display:flex;gap:18px;flex-wrap:wrap;font-size:.66rem;letter-spacing:.16em;text-transform:uppercase}
.nav a{color:var(--gold)}
.wait{display:grid;gap:6px;margin-top:12px}
.wrow{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;border:1px solid rgba(226,133,127,.28);background:rgba(226,133,127,.05);padding:9px 12px;font-size:.82rem}
.wrow b{font-weight:400;color:var(--cream)}
.wrow .when{color:#E2857F;font-variant-numeric:tabular-nums}
.wrow .meta{color:rgba(245,245,245,.45);font-size:.72rem}
.wrow .go{margin-left:auto}
@media (max-width:640px){ body{font-size:14.5px} }
`;

/* --------------------------------------------------------------- page */
function page(d, base) {
  const e = B.esc;
  const w = d.window;
  const qs = (over) => {
    const p = new URLSearchParams();
    const cur = { range: w.key === 'custom' ? undefined : w.key, since: w.key === 'custom' ? w.since : undefined,
                  until: w.key === 'custom' ? w.until : undefined, rep: d.filters.rep || undefined, role: d.filters.role || undefined, ...over };
    for (const [k, v] of Object.entries(cur)) if (v) p.set(k, v);
    const s = p.toString();
    return `${base}/reports${s ? '?' + s : ''}`;
  };
  const chip = (label, href, on) => `<a class="chip ${on ? 'chip--on' : ''}" href="${href}">${e(label)}</a>`;

  const filters = `<div class="filters">
    <span class="lbl">Range</span>
    ${['today', 'yesterday', '7d', '30d', 'all'].map((k) => chip({ today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7d', '30d': 'Last 30d', all: 'All' }[k], qs({ range: k, since: undefined, until: undefined }), w.key === k)).join('')}
    <form class="dates" method="get" action="${base}/reports">
      <input type="date" name="since" value="${e(w.since || '')}" max="${e(w.today)}" aria-label="From date" required>
      <span>→</span>
      <input type="date" name="until" value="${e(w.until || '')}" max="${e(w.today)}" aria-label="To date" required>
      ${d.filters.rep ? `<input type="hidden" name="rep" value="${e(d.filters.rep)}">` : ''}${d.filters.role ? `<input type="hidden" name="role" value="${e(d.filters.role)}">` : ''}
      <button class="chip ${w.key === 'custom' ? 'chip--on' : ''}" type="submit">Apply</button>
    </form>
    <span class="sep"></span><span class="lbl">Role</span>
    ${chip('All', qs({ role: undefined }), !d.filters.role)}
    ${['setter', 'triage', 'closer'].map((r) => chip(EOD.ROLE_LABEL[r], qs({ role: r }), d.filters.role === r)).join('')}
    ${d.allReps.length ? `<span class="sep"></span><span class="lbl">Rep</span>${chip('All', qs({ rep: undefined }), !d.filters.rep)}${d.allReps.map((r) => chip(r, qs({ rep: r }), d.filters.rep.toLowerCase() === r.toLowerCase())).join('')}` : ''}
  </div>`;

  const T = d.totals, S = d.byRole.setter, R = d.byRole.triage, C = d.byRole.closer;
  const showRate = pct(T.showed, T.scheduled);
  const qualRate = pct(R.qualified, R.showed);
  const closeRate = pct(C.won, C.showed);
  const stat = (v, l, sub = '', cls = '') => `<div class="stat ${cls}"><b>${v}</b><span>${e(l)}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const stats = `<div class="stats">
    ${stat(T.calls, 'Reports filed', `${S.calls} setting · ${R.calls} triage · ${C.calls} closing`)}
    ${stat(S.booked, 'Calls booked', 'by setters')}
    ${stat(T.scheduled, 'Calls scheduled', `${T.showed} showed · ${T.no_shows} no-show`)}
    ${stat(showRate === null ? '—' : showRate + '%', 'Show rate', '', showRate === null ? '' : showRate >= 70 ? 'stat--good' : showRate < 50 ? 'stat--bad' : '')}
    ${stat(qualRate === null ? '—' : qualRate + '%', 'Triage → qualified', `${R.closing_booked} closing booked · ${R.nurture} nurture`)}
    ${stat(closeRate === null ? '—' : closeRate + '%', 'Close rate', `${C.won} won · ${C.lost} lost`, closeRate === null ? '' : closeRate >= 30 ? 'stat--good' : '')}
    ${stat(money(T.cash), 'Cash collected', C.deal ? `${money(C.deal)} contracted` : '')}
  </div>`;

  // today's accountability line
  const missing = d.missingToday, unsigned = d.unsigned;
  const acc = (missing.length || unsigned.length)
    ? `<div class="alert"><span>${missing.length ? `<b>No report today from ${e(missing.join(', '))}.</b> ` : ''}${unsigned.length ? `${unsigned.map((u) => `${e(u.rep)} has ${u.calls} call${u.calls === 1 ? '' : 's'} filed but no sign-off`).join('; ')}.` : ''}</span><a href="${base}/eod" style="margin-left:auto">File a report ↗</a></div>`
    : `<div class="alert alert--ok"><span><b>Everyone has reported today.</b> ${d.todayTotals.calls} call${d.todayTotals.calls === 1 ? '' : 's'} filed.</span></div>`;

  // funnel
  const f = [
    { n: 'Booked', v: S.booked, s: 'by setters' },
    { n: 'Triage held', v: R.scheduled, s: `${R.showed} showed`, c: pct(R.scheduled, S.booked) },
    { n: 'Qualified', v: R.qualified, s: `${R.closing_booked} to closing`, c: pct(R.qualified, R.showed) },
    { n: 'Closing held', v: C.scheduled, s: `${C.showed} showed`, c: pct(C.scheduled, R.closing_booked) },
    { n: 'Won', v: C.won, s: money(C.cash) + ' collected', c: pct(C.won, C.showed) },
  ];
  const funnel = `<div class="funnel">${f.map((x, i) => `<div class="fcard">
      <div class="fcard__n">${e(x.n)}</div><div class="fcard__v">${x.v}</div><div class="fcard__s">${e(x.s)}</div>
      ${i < f.length - 1 ? `<div class="fcard__c">${f[i + 1].c === null ? '—' : f[i + 1].c + '%'} →</div>` : ''}
    </div>`).join('')}</div>`;

  // reps table
  const kpiCell = (kp) => (kp.Yes + kp.Partial + kp.No) ? `<span class="pill p-green">${kp.Yes} yes</span> <span class="pill p-amber">${kp.Partial}</span> <span class="pill p-red">${kp.No}</span>` : '—';
  const repRows = d.reps.map((p) => {
    const t = p.t;
    const main = p.role === 'setter' ? `${t.booked} booked` : p.role === 'triage' ? `${t.qualified} qualified · ${t.closing_booked} closing` : `${t.won} won · ${t.lost} lost`;
    return `<tr>
      <td>${e(p.rep)}<small>${e(EOD.ROLE_LABEL[p.role])}</small></td>
      <td>${p.role === 'setter' ? (p.dms || '—') : t.scheduled}</td>
      <td>${p.role === 'setter' ? '—' : `${t.showed}${t.scheduled ? ` <span class="sub">${pct(t.showed, t.scheduled)}%</span>` : ''}`}</td>
      <td class="l">${main}</td>
      <td>${money(t.cash)}</td>
      <td>${p.signoffs.length} / ${p.days}</td>
      <td class="l">${kpiCell(p.kp)}</td>
      <td><a class="go" href="${qs({ rep: p.rep })}">filter</a></td>
    </tr>`;
  }).join('');

  // outcome mix
  const mixBox = (role) => {
    const list = d.mix[role]; const max = list[0]?.[1] || 1;
    return `<div class="tbox"><h3>${e(EOD.ROLE_LABEL[role])} outcomes</h3>${list.length ? list.map(([k, v]) =>
      `<div class="brow"><div class="bar"><i style="width:${(v / max) * 100}%"></i><span>${e(k)}</span></div><b>${v}</b></div>`).join('')
      : '<div class="empty" style="margin:0">Nothing filed.</div>'}</div>`;
  };
  const objBox = `<div class="tbox"><h3>Objections &amp; loss reasons</h3>${d.objections.length ? d.objections.map((o) =>
    `<div class="brow"><div class="bar"><i style="width:${(o.n / d.objections[0].n) * 100}%"></i><span>${e(o.text)}</span></div><b>${o.n}</b></div>`).join('')
    : '<div class="empty" style="margin:0">None recorded.</div>'}</div>`;

  // waiting
  const waiting = d.waiting.length ? `<div class="wait">${d.waiting.slice(0, 25).map((l) => `<div class="wrow">
      <b>${e(l.name || l.email)}</b>
      <span class="when">${e(l.nextCallType || 'Call')} · ${e(fmtWhen(l.nextCallAt))}</span>
      <span class="meta">${e([l.nextCallWith ? 'with ' + l.nextCallWith : '', l.stage].filter(Boolean).join(' · '))}</span>
      <a class="go" href="${base}/eod?report=${l.nextCallType === 'Closing' ? 'closer' : 'triage'}&l=${l.id.replace(/-/g, '')}">file report ↗</a>
      <a class="go" href="${l.url}" target="_blank" rel="noopener">notion ↗</a>
    </div>`).join('')}</div>` : '<p class="empty">Every booked call that has passed has a report.</p>';

  // recent reports
  const pillFor = (r) => {
    const o = r.outcome;
    const cls = /Won|booked|nurture/i.test(o) && !/not/i.test(o) ? 'p-green' : /Lost|rejected|Not interested/i.test(o) ? 'p-red' : /Follow|Held|No response/i.test(o) ? 'p-amber' : 'p-grey';
    return `<span class="pill ${cls}">${e(o)}</span>`;
  };
  const rolePill = { setter: 'p-blue', triage: 'p-amber', closer: 'p-purple' };
  const recent = d.reports.slice(0, 40).map((r) => `<tr>
      <td>${e(fmtWhen(r.created))}<small>${e(r.rep)}</small></td>
      <td class="l"><span class="pill ${rolePill[r.role]}">${e(EOD.ROLE_LABEL[r.role])}</span></td>
      <td class="l">${r.leadUrl ? `<a class="go" href="${r.leadUrl}" target="_blank" rel="noopener">${e(r.name)}</a>` : `${e(r.name)}<small>unlinked</small>`}</td>
      <td class="l">${pillFor(r)}${r.stageSet ? `<span class="sub">→ ${e(r.stageSet)}</span>` : ''}</td>
      <td class="l"><span class="sub" style="margin:0">${e([r.bookedFor ? `booked ${fmtWhen(r.bookedFor)}${r.bookedWith ? ' with ' + r.bookedWith : ''}` : '', r.next ? `next: ${r.next}` : '', r.objection ? `obj: ${r.objection}` : ''].filter(Boolean).join(' · ').slice(0, 160) || '—')}</span></td>
      <td>${r.cash ? money(r.cash) : '—'}</td>
      <td>${r.discord ? `<a class="go" href="${r.discord}" target="_blank" rel="noopener">discord ↗</a>` : ''} <a class="go" href="${r.url}" target="_blank" rel="noopener">row ↗</a></td>
    </tr>`).join('');

  const signRows = d.signoffs.slice(0, 20).map((s) => `<tr>
      <td>${e(s.date)}<small>${e(s.rep)} · ${e(EOD.ROLE_LABEL[s.role] || s.role)}</small></td>
      <td class="l">${s.hit_kpis ? `<span class="pill ${s.hit_kpis === 'Yes' ? 'p-green' : s.hit_kpis === 'No' ? 'p-red' : 'p-amber'}">${e(s.hit_kpis)}</span>` : '—'}${s.no_calls ? ' <span class="pill p-grey">no calls</span>' : ''}</td>
      <td>${s.role === 'setter' ? `${s.messages} DMs · ${s.booked} booked` : `${s.held} held · ${s.showed} showed`}</td>
      <td>${money(s.cash)}</td>
      <td class="l"><span class="sub" style="margin:0">${e([s.wins ? 'Wins: ' + s.wins : '', s.blockers ? 'Blockers: ' + s.blockers : '', s.notes].filter(Boolean).join(' · ').slice(0, 200) || '—')}</span></td>
      <td>${s.discord ? `<a class="go" href="${s.discord}" target="_blank" rel="noopener">discord ↗</a>` : ''} <a class="go" href="${s.url}" target="_blank" rel="noopener">row ↗</a></td>
    </tr>`).join('');

  const notionEod = STATE.eod_page ? `https://www.notion.so/${STATE.eod_page.replace(/-/g, '')}` : (STATE.page ? `https://www.notion.so/${STATE.page.replace(/-/g, '')}` : '');

  const body = `<main><div class="wrap">
  <section class="top"><div class="top__row">
    <div><p class="kicker">EOD reports &middot; ${e(w.label)}</p><h1>What the team filed</h1></div>
    <span class="nav"><a href="${base}/scorecard${w.key === 'custom' ? `?start=${w.since || ''}&end=${w.until}` : w.key === 'all' ? '' : `?range=${w.key}`}">Scorecard</a><a href="${notionEod}" target="_blank" rel="noopener">Notion</a></span>
  </div>
  ${filters}
  ${acc}
  ${stats}
  </section>

  <section class="sec"><div class="sec__h"><h2>The call funnel</h2><span class="sec__n">${e(w.label)} &middot; arrows are stage-to-stage</span></div>${funnel}</section>

  <section class="sec"><div class="sec__h"><h2>By rep</h2><span class="sec__n">${d.reps.length} rep${d.reps.length === 1 ? '' : 's'}</span></div>
    ${d.reps.length ? `<div class="wrapx"><table><thead><tr><th>Rep</th><th>Calls / DMs</th><th>Showed</th><th class="l">Result</th><th>Cash</th><th>Sign-offs / days</th><th class="l">KPIs hit</th><th></th></tr></thead><tbody>${repRows}</tbody></table></div>`
      : '<p class="empty">No reports in this window. The first one filed on the EOD report appears here within a second.</p>'}
  </section>

  <section class="sec"><div class="sec__h"><h2>Outcomes</h2><span class="sec__n">what the calls turned into</span></div>
    <div class="tgrid">${mixBox('setter')}${mixBox('triage')}${mixBox('closer')}${objBox}</div>
  </section>

  <section class="sec"><div class="sec__h"><h2>Waiting for a report</h2><span class="sec__n">${d.waiting.length} booked call${d.waiting.length === 1 ? '' : 's'} passed with nothing filed</span></div>${waiting}</section>

  <section class="sec"><div class="sec__h"><h2>Reports</h2><span class="sec__n">${d.reports.length} in window &middot; newest first</span></div>
    ${d.reports.length ? `<div class="wrapx"><table><thead><tr><th>Filed</th><th class="l">Type</th><th class="l">Lead</th><th class="l">Outcome</th><th class="l">Detail</th><th>Cash</th><th></th></tr></thead><tbody>${recent}</tbody></table></div>` : '<p class="empty">Nothing yet.</p>'}
  </section>

  <section class="sec"><div class="sec__h"><h2>Sign-offs</h2><span class="sec__n">${d.signoffs.length} in window</span></div>
    ${d.signoffs.length ? `<div class="wrapx"><table><thead><tr><th>Day</th><th class="l">KPIs</th><th>Volume</th><th>Cash</th><th class="l">Notes</th><th></th></tr></thead><tbody>${signRows}</tbody></table></div>` : '<p class="empty">No sign-offs yet. The nightly digest goes to daily-standup at 9pm UK either way.</p>'}
  </section>

  <section class="sec foot"><div class="sec__h">
    <span class="nav"><a href="${base}/eod">End of Day report</a><a href="${base}/journey">Live funnel</a><a href="${notionEod}" target="_blank" rel="noopener">Notion EOD page</a></span>
    <span class="note">${new Date(d.at).toUTCString()} &middot; live from Notion</span>
  </div></section>
  </div></main>`;

  return B.shell({ title: `EOD Reports · ${B.NAME}`, description: 'What the sales team filed, and what it adds up to', body, css: CSS, head: '<script src="/auth.js" data-allow="owner,manager"></script>' });
}

module.exports = { gather, page, windowOf };
