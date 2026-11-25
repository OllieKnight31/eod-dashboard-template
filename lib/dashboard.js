// /journey — the scorecard funnel.
//
// Nine stage cards, each carrying its own KPI and the conversion arrow to the
// next one. The arrow is the point: it shows what actually converts, what was
// supposed to, and the gap in percentage points. A bad step is meant to be
// visible before you have read a single word.

const CFG = require('../journey.config.json');
const N = require('./notion');
const J = require('./journey');
const B = require('./brand');
const SITE = require('./site');
const STATE = require('./state');

async function gather({ since = CFG.cohort_start } = {}) {
  const health = await N.queryAll(N.DB.stages);
  const byName = new Map(health.map((r) => [N.readProp(r, 'Stage'), r]));

  const out = await J.recompute({ since, writeLeads: false, writeHealth: false });

  const stages = out.stages.map((s) => {
    const row = byName.get(s.stage);
    const target = row ? (N.readProp(row, 'KPI Target %') ?? s.target) : s.target;
    const def = CFG.stages.find((x) => x.no === s.no);
    let entered = s.entered, conversion = s.conversion;
    if (def.metric_source === 'manual' && row) {
      entered = N.readProp(row, 'Entered');
      conversion = entered ? Math.round((s.advanced / entered) * 1000) / 10 : null;
    }
    const thin = def.metric_source === 'sessions' && entered && entered < (CFG.session_min_sample || 20);
    const health_ = s.no === 9 ? 'end'
      : !entered ? 'none'
      : thin ? 'none'
      : conversion === null ? 'none'
      : conversion >= target ? 'good' : conversion >= target - 10 ? 'watch' : 'bad';
    return {
      ...s, entered, conversion, target, health: health_,
      delta: conversion === null || !entered ? null : Math.round((conversion - target) * 10) / 10,
      // Leads lost against target — what the gap actually costs.
      cost: conversion === null || !entered ? 0 : Math.max(0, ((target - conversion) / 100) * entered),
      owner: def.owner, auto: def.auto, source: def.metric_source,
      thin,
      why: thin ? `${entered} visit${entered === 1 ? '' : 's'} tracked — needs ${CFG.session_min_sample || 20} to score`
        : { setter:   'Awaiting setter EOD reports',
            sessions: 'Tracker live — awaiting visits',
            manual:   'Enter site sessions in Notion',
            asset:    'No asset sent yet',
            cohort:   'Nobody here yet' }[def.metric_source] || '',
      short: def.short || def.name.replace(/^\d+\.\s*/, ''),
    };
  });

  // Share of the cohort still alive at each stage — the card's own percentage,
  // distinct from the arrow's stage-to-stage conversion.
  const base = out.cohort.leads || stages.find((x) => x.entered)?.entered || 0;
  for (const s of stages) s.share = s.entered && base ? Math.round((s.entered / base) * 1000) / 10 : null;

  const assets = (await N.queryAll(N.DB.assets)).map((r) => ({
    title: N.readProp(r, 'Asset'), slug: N.readProp(r, 'Slug'),
    type: N.readProp(r, 'Type'), status: N.readProp(r, 'Status'),
    sent: N.readProp(r, 'Sent') || 0, opened: N.readProp(r, 'Opened') || 0,
    played: N.readProp(r, 'Played') || 0, completed: N.readProp(r, 'Completed') || 0,
    avg: N.readProp(r, 'Avg watch %'), video: !!N.readProp(r, 'Video URL'),
  }));

  const site = await SITE.summary({ since }).catch(() => null);

  return { since, cohort: out.cohort, stages, assets, site, at: new Date().toISOString() };
}

/* --------------------------------------------------------------- styles */
const CSS = `
body{background:var(--ink);font-size:15px}
.wrap{max-width:1180px}
main{padding-bottom:20px}

/* ---- masthead row: title, cohort, stats, all on one band ---- */
.top{padding:26px 0 18px;border-bottom:1px solid rgba(163,163,163,.18)}
.top__row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:18px 30px;justify-content:space-between}
.top h1{font-family:var(--serif);font-weight:300;font-size:clamp(1.5rem,2.6vw,2rem);margin:0;line-height:1.1}
.top .kicker{margin:0 0 6px}
.stats{display:flex;gap:26px;flex-wrap:wrap}
.stat b{display:block;font-family:var(--serif);font-weight:300;font-size:1.5rem;line-height:1;
  color:var(--cream);font-variant-numeric:tabular-nums}
.stat span{display:block;font-size:.56rem;letter-spacing:.22em;text-transform:uppercase;
  color:rgba(245,245,245,.42);margin-top:6px}
.stat--bad b{color:#E2857F}

/* ---- the verdict strip ---- */
.fix{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:baseline;
  border:1px solid rgba(226,133,127,.34);background:rgba(226,133,127,.07);
  padding:12px 16px;margin:16px 0 0;font-size:.88rem;line-height:1.5}
.fix b{color:#E2857F;font-weight:500}
.fix--ok{border-color:rgba(159,214,168,.32);background:rgba(159,214,168,.06)}
.fix--ok b{color:#9FD6A8}
.fix__act{margin-left:auto;font-size:.64rem;letter-spacing:.14em;text-transform:uppercase;
  color:var(--gold);white-space:nowrap}
.fix__then{flex-basis:100%;font-size:.64rem;letter-spacing:.12em;text-transform:uppercase;
  color:rgba(245,245,245,.38)}

/* ---- the scorecard chain ---- */
.chain{display:grid;grid-template-columns:repeat(auto-fit,minmax(186px,1fr));
  gap:9px;margin-top:22px}
.card{position:relative;border:1px solid rgba(163,163,163,.22);background:rgba(163,163,163,.035);
  padding:11px 12px 0;display:flex;flex-direction:column;min-width:0}
.card--bad{border-color:rgba(226,133,127,.5);background:rgba(226,133,127,.07)}
.card--watch{border-color:rgba(212,212,212,.42)}
.card--good{border-color:rgba(159,214,168,.36)}
.card__h{display:flex;align-items:center;justify-content:space-between;gap:8px}
.card__n{font-family:var(--serif);font-size:.82rem;color:rgba(163,163,163,.72);letter-spacing:.04em}
.dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.d-good{background:#9FD6A8}.d-watch{background:var(--gold-lite)}
.d-bad{background:#E2857F}.d-none{background:rgba(245,245,245,.22)}.d-end{background:rgba(163,163,163,.5)}
.card__name{font-size:.82rem;line-height:1.25;color:var(--cream);margin:6px 0 0}
.card__kpi{display:flex;align-items:baseline;gap:7px;margin:7px 0 3px;flex-wrap:wrap}
.card__kpi b{font-family:var(--serif);font-weight:300;font-size:1.72rem;line-height:1;
  color:var(--cream);font-variant-numeric:tabular-nums}
.card__kpi s{text-decoration:none;font-size:.56rem;letter-spacing:.2em;text-transform:uppercase;
  color:rgba(245,245,245,.38)}
.card__share{font-size:.62rem;letter-spacing:.08em;color:rgba(163,163,163,.62);
  font-variant-numeric:tabular-nums}
.card__open{font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;
  color:rgba(245,245,245,.34);margin:5px 0 11px;min-height:.9em}

/* the arrow to the next stage — the whole point of the card */
.step{margin:auto -12px 0;padding:8px 12px 9px;border-top:1px solid rgba(163,163,163,.16)}
.step__top{display:flex;align-items:center;gap:8px}
.step__a{font-size:.9rem;color:rgba(163,163,163,.85);line-height:1}
.step__v{font-family:var(--serif);font-size:1.05rem;font-weight:300;line-height:1;
  font-variant-numeric:tabular-nums}
.step__t{display:flex;justify-content:space-between;gap:8px;margin-top:6px;
  font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;
  color:rgba(245,245,245,.36);white-space:nowrap}
.step__t b{font-weight:400;color:rgba(245,245,245,.5)}
.step__d{margin-left:auto;font-size:.64rem;font-weight:500;letter-spacing:.03em;
  padding:3px 6px;border:1px solid;font-variant-numeric:tabular-nums;white-space:nowrap}
.card__why{font-size:.62rem;line-height:1.35;color:rgba(245,245,245,.3);margin:4px 0 11px}
.s-good .step__v{color:#9FD6A8}   .s-good .step__d{color:#9FD6A8;border-color:rgba(159,214,168,.4)}
.s-watch .step__v{color:var(--gold-lite)} .s-watch .step__d{color:var(--gold-lite);border-color:rgba(212,212,212,.42)}
.s-bad .step__v{color:#E2857F}    .s-bad .step__d{color:#E2857F;border-color:rgba(226,133,127,.48)}
.s-none .step__v,.s-none .step__t{color:rgba(245,245,245,.3)}
.s-end{justify-content:flex-start}
.s-end .step__t{color:rgba(163,163,163,.6)}

/* the connector between cards — decoration; the meaning is in .step */
.card::after{content:"";position:absolute;top:50%;right:-9px;width:9px;height:1px;
  background:rgba(163,163,163,.3);z-index:1}
.card:last-child::after{display:none}
@media (max-width:900px){ .card::after{display:none} }

/* ---- assets ---- */
.sec{margin-top:34px;padding-top:20px;border-top:1px solid rgba(163,163,163,.18)}
.sec__h{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
.sec h2{font-family:var(--serif);font-weight:300;font-size:1.12rem;margin:0}
.sec__n{font-size:.62rem;letter-spacing:.16em;text-transform:uppercase;color:rgba(245,245,245,.36)}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:.82rem}
th{text-align:right;font-size:.56rem;letter-spacing:.18em;text-transform:uppercase;
  color:rgba(245,245,245,.36);font-weight:500;padding:7px 10px;
  border-bottom:1px solid rgba(163,163,163,.2)}
th:first-child{text-align:left}
td{padding:9px 10px;border-bottom:1px solid rgba(163,163,163,.09);
  color:rgba(245,245,245,.74);text-align:right;font-variant-numeric:tabular-nums}
td:first-child{text-align:left;color:var(--cream)}
td small{display:block;font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;
  color:rgba(245,245,245,.3);margin-top:2px}
.pill{font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;padding:3px 7px;border:1px solid;
  white-space:nowrap}
.p-red{color:#E2857F;border-color:rgba(226,133,127,.42)}
.p-green{color:#9FD6A8;border-color:rgba(159,214,168,.4)}
.p-amber{color:var(--gold-lite);border-color:rgba(212,212,212,.42)}
.go{color:var(--gold)}
.foot{margin-top:26px;padding-top:16px}
.note{font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(245,245,245,.3)}
.nav{display:flex;gap:18px;flex-wrap:wrap;font-size:.66rem;letter-spacing:.16em;
  text-transform:uppercase}
.nav a{color:var(--gold)}
.wrapx{overflow-x:auto}

/* ---- live traffic ---- */
.live{display:flex;align-items:center;gap:8px;font-size:.62rem;letter-spacing:.18em;
  text-transform:uppercase;color:rgba(245,245,245,.4)}
.live i{width:6px;height:6px;border-radius:50%;background:#9FD6A8;display:inline-block;
  animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
.tgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:9px;margin-top:12px}
.tbox{border:1px solid rgba(163,163,163,.2);background:rgba(163,163,163,.03);padding:11px 13px}
.tbox h3{margin:0 0 9px;font-size:.58rem;letter-spacing:.2em;text-transform:uppercase;
  color:rgba(245,245,245,.4);font-weight:500}
.trow{display:flex;justify-content:space-between;gap:10px;font-size:.8rem;padding:3px 0;
  color:rgba(245,245,245,.74)}
.trow b{font-weight:400;color:var(--cream);font-variant-numeric:tabular-nums}
.tnums{display:flex;gap:22px;flex-wrap:wrap}
.tnum b{display:block;font-family:var(--serif);font-weight:300;font-size:1.35rem;line-height:1;
  color:var(--cream);font-variant-numeric:tabular-nums}
.tnum span{display:block;font-size:.55rem;letter-spacing:.2em;text-transform:uppercase;
  color:rgba(245,245,245,.4);margin-top:5px}

/* ---- application drop-off ---- */
.drop{margin-top:12px;display:grid;gap:4px}
.qrow{display:grid;grid-template-columns:26px 1fr 54px 64px;gap:10px;align-items:center;
  font-size:.78rem;color:rgba(245,245,245,.74)}
.qrow__n{font-family:var(--serif);font-size:.76rem;color:rgba(163,163,163,.6)}
.qrow__q{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qbar{position:relative;height:16px;background:rgba(163,163,163,.1);overflow:hidden}
.qbar i{position:absolute;inset:0 auto 0 0;background:rgba(163,163,163,.42)}
.qrow__v{text-align:right;font-variant-numeric:tabular-nums;color:var(--cream)}
.qrow__d{text-align:right;font-size:.68rem;font-variant-numeric:tabular-nums;color:#E2857F}
.qrow--worst .qbar i{background:rgba(226,133,127,.6)}
.empty{font-size:.8rem;color:rgba(245,245,245,.42);margin:12px 0 0;line-height:1.6}
@media (max-width:640px){ body{font-size:14.5px} .chain{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))} }
`;

/* ----------------------------------------------------------------- page */
function page(d, base) {
  const fmt = (n) => (n === null || n === undefined ? '—' : n);
  const pct = (n) => (n === null ? '—' : `${n}%`);
  const CLS = { good: 'good', watch: 'watch', bad: 'bad', none: 'none', end: 'end' };

  // Rank by leads lost against target, not by the percentage gap: 95 points
  // under on 3 leads costs 3; 65 under on 268 costs 174.
  const problems = d.stages
    .filter((s) => (s.health === 'bad' || s.health === 'watch') && s.cost > 0)
    .sort((a, b) => b.cost - a.cost);
  const worst = problems[0];

  const cards = d.stages.map((s, i) => {
    const next = d.stages[i + 1];
    const cls = CLS[s.health];
    let step;
    if (s.no === 9) {
      step = `<div class="step s-end"><span class="step__t">End of the journey</span></div>`;
    } else if (s.conversion === null || !s.entered || s.thin) {
      step = `<div class="step s-none">
          <div class="step__top"><span class="step__a">→</span><span class="step__v">—</span></div>
          <span class="step__t"><span>to ${B.esc(next.short)}</span><span>tgt ${s.target}%</span></span>
        </div>`;
    } else {
      const d_ = s.delta;
      const sign = d_ > 0 ? '+' : '';
      step = `<div class="step s-${cls}">
          <div class="step__top">
            <span class="step__a">→</span><span class="step__v">${s.conversion}%</span>
            <span class="step__d">${sign}${d_} pp</span>
          </div>
          <span class="step__t"><span><b>${s.advanced}</b> of ${s.entered}</span><span>tgt ${s.target}%</span></span>
        </div>`;
    }
    return `<div class="card card--${cls}">
        <div class="card__h">
          <span class="card__n">${String(s.no).padStart(2, '0')}</span>
          <span class="dot d-${cls}"></span>
        </div>
        <div class="card__name">${B.esc(s.stage.replace(/^\d+\.\s*/, ''))}</div>
        <div class="card__kpi"><b>${fmt(s.entered)}</b><s>reached</s>
          ${s.share === null ? '' : `<span class="card__share">${s.share}% of cohort</span>`}</div>
        <div class="card__open">${s.open ? `${s.open} open` : ''}${s.lost ? `${s.open ? ' &middot; ' : ''}${s.lost} lost` : ''}</div>
        ${s.health === 'none' && s.why ? `<div class="card__why">${B.esc(s.why)}</div>` : ''}
        ${step}
      </div>`;
  }).join('');

  const assetRows = d.assets.map((a) => `<tr>
      <td>${B.esc(a.title)}<small>${B.esc(a.type || '')}</small></td>
      <td><span class="pill ${a.video ? 'p-green' : 'p-red'}">${a.video ? 'Live' : 'Needs video'}</span></td>
      <td>${a.sent}</td><td>${a.opened}</td><td>${a.played}</td><td>${a.completed}</td>
      <td>${a.avg === null ? '—' : a.avg + '%'}</td>
      <td><a class="go" href="${base}/v/${B.esc(a.slug)}" target="_blank" rel="noopener">open&nbsp;↗</a></td>
    </tr>`).join('');

  /* ---------------------------------------- live traffic + drop-off */
  const st = d.site;
  let siteSection;
  if (!st) {
    siteSection = `<section class="sec">
      <div class="sec__h"><h2>The website</h2><span class="sec__n">live tracking</span></div>
      <p class="empty">No visits recorded yet. The tracker goes live the moment
      <code>t.js</code> is on the site — every visit, where it came from, and how far it
      gets through the application will land here.</p>
    </section>`;
  } else {
    const maxReach = st.reached.length ? st.reached[0].reached : 1;
    const worstDrop = st.reached.reduce((w, r, i) => {
      const prev = i === 0 ? st.sessions : st.reached[i - 1].reached;
      const lost = prev - r.reached;
      return lost > (w?.lost ?? -1) ? { step: r.step, lost } : w;
    }, null);

    const qrows = st.reached.map((r, i) => {
      const prev = i === 0 ? st.started : st.reached[i - 1].reached;
      const lost = Math.max(0, prev - r.reached);
      return `<div class="qrow ${worstDrop && worstDrop.step === r.step && lost ? 'qrow--worst' : ''}">
          <span class="qrow__n">${String(r.step).padStart(2, '0')}</span>
          <span class="qbar"><i style="width:${maxReach ? (r.reached / maxReach) * 100 : 0}%"></i>
            <span class="qrow__q" style="position:absolute;left:8px;top:0;line-height:16px;font-size:.68rem">${B.esc(r.label)}</span></span>
          <span class="qrow__v">${r.reached}</span>
          <span class="qrow__d">${lost ? '−' + lost : ''}</span>
        </div>`;
    }).join('');

    const chRows = st.channels.slice(0, 6).map(([k, v]) =>
      `<div class="trow"><span>${B.esc(k)}</span><b>${v}</b></div>`).join('');
    const lpRows = st.landings.slice(0, 6).map(([k, v]) =>
      `<div class="trow"><span>${B.esc(k)}</span><b>${v}</b></div>`).join('');

    siteSection = `<section class="sec">
      <div class="sec__h">
        <h2>The website</h2>
        <span class="live">${st.live ? `<i></i>${st.live} on the site now` : 'live tracking'}</span>
      </div>
      <div class="tnums" style="margin-top:14px">
        <div class="tnum"><b>${st.sessions}</b><span>Visits</span></div>
        <div class="tnum"><b>${st.last24}</b><span>Last 24h</span></div>
        <div class="tnum"><b>${st.lastHour}</b><span>Last hour</span></div>
        <div class="tnum"><b>${st.started}</b><span>Started the form</span></div>
        <div class="tnum"><b>${st.completed}</b><span>Applied</span></div>
        <div class="tnum"><b>${st.startRate === null ? '—' : st.startRate + '%'}</b><span>Visit → start</span></div>
        <div class="tnum"><b>${st.finishRate === null ? '—' : st.finishRate + '%'}</b><span>Start → applied</span></div>
      </div>
      <div class="tgrid">
        <div class="tbox"><h3>Where they came from</h3>${chRows || '<div class="trow"><span>—</span></div>'}</div>
        <div class="tbox"><h3>Landed on</h3>${lpRows || '<div class="trow"><span>—</span></div>'}</div>
      </div>
      <div class="sec__h" style="margin-top:22px">
        <h2 style="font-size:1rem">Application drop-off</h2>
        <span class="sec__n">${st.started} started &middot; ${st.completed} finished${worstDrop && worstDrop.lost ? ` &middot; worst fall at Q${worstDrop.step}` : ''}</span>
      </div>
      ${qrows ? `<div class="drop">${qrows}</div>`
              : '<p class="empty">Nobody has opened the application yet.</p>'}
    </section>`;
  }

  const open = d.stages.reduce((t, s) => t + (s.open || 0), 0);
  const lost = d.stages.reduce((t, s) => t + (s.lost || 0), 0);
  const under = d.stages.filter((s) => s.health === 'bad').length;

  const others = problems.slice(1, 4)
    .map((s) => `${B.esc(s.stage.replace(/^\d+\.\s*/, ''))} ${s.delta} pp`)
    .join(' &middot; ');

  const verdict = worst
    ? `<div class="fix">
         <span><b>Fix first: ${B.esc(worst.stage.replace(/^\d+\.\s*/, ''))}.</b>
         ${worst.entered} reached it, ${worst.advanced} moved on — ${worst.conversion}% against ${worst.target}%.
         Closing that gap is worth about <b>${Math.round(worst.cost)} leads</b>${worst.open ? `, and ${worst.open} are sitting there right now` : ''}.</span>
         <span class="fix__act">${B.esc(worst.auto ? 'Automated — check the send' : worst.owner + ' owns this')}</span>
         ${others ? `<span class="fix__then">Then: ${others}</span>` : ''}
       </div>`
    : `<div class="fix fix--ok"><span><b>No stage is under target.</b> Nothing is leaking against the KPIs you have set.</span></div>`;


  const body = `<main><div class="wrap">

  <section class="top"><div class="top__row">
    <div>
      <p class="kicker">Client journey &middot; live</p>
      <h1>Where the leads stop</h1>
    </div>
    <div class="stats">
      <div class="stat"><b>${d.cohort.leads}</b><span>Cohort</span></div>
      <div class="stat"><b>${open}</b><span>Open</span></div>
      <div class="stat"><b>${lost}</b><span>Lost</span></div>
      <div class="stat ${under ? 'stat--bad' : ''}"><b>${under}</b><span>Under target</span></div>
    </div>
  </div>
  ${verdict}
  </section>

  <section class="chain">${cards}</section>

  ${siteSection}

  <section class="sec">
    <div class="sec__h"><h2>Assets</h2><span class="sec__n">watch depth, not clicks</span></div>
    <div class="wrapx"><table>
      <thead><tr><th>Asset</th><th style="text-align:left">Status</th><th>Sent</th><th>Opened</th>
        <th>Played</th><th>Finished</th><th>Depth</th><th></th></tr></thead>
      <tbody>${assetRows}</tbody>
    </table></div>
  </section>

  <section class="sec foot"><div class="sec__h">
    <span class="nav">
      ${STATE.page ? `<a href="https://www.notion.so/${STATE.page.replace(/-/g, '')}" target="_blank" rel="noopener">Notion dashboard</a>` : ''}
      <a href="${base}/eod" target="_blank" rel="noopener">End of Day report</a>
    </span>
    <span class="note">${new Date(d.at).toUTCString()} &middot; cohort ${B.esc(d.since || 'all time')} &middot; ?since=all for full history</span>
  </div></section>

  </div></main>`;

  return B.shell({ title: `Client Journey · ${B.NAME}`, description: 'Live funnel scorecard', body, css: CSS, head: '<script src="/auth.js" data-allow="owner,manager"></script>' });
}

module.exports = { gather, page };
