// The branded VSL watch page, and the tracking that makes stages 4 and 6 real.
//
// Watch depth is the point: an opened link proves nothing, and a lead who
// skimmed 6% of the pitch is not a lead who watched it. The page reports
// open / play / 25 / 50 / 75 / complete, and the furthest percentage reached.

const B = require('./brand');

const PROVIDERS = [
  { test: /youtu\.?be/i,  kind: 'youtube' },
  { test: /vimeo\.com/i,  kind: 'vimeo' },
  { test: /loom\.com/i,   kind: 'loom' },
  { test: /\.(mp4|webm|m4v|mov)(\?|$)/i, kind: 'file' },
];

function providerOf(url) {
  if (!url) return null;
  const hit = PROVIDERS.find((p) => p.test.test(url));
  return hit ? hit.kind : 'iframe';
}

function youtubeId(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}
function vimeoId(url) {
  const m = String(url).match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return m ? m[1] : null;
}

const CSS = `
.hero{padding:clamp(38px,6vw,66px) 0 clamp(20px,3vw,30px)}
.hero__grid{display:grid;gap:10px}
.stage{position:relative;background:#000;border:1px solid rgba(163,163,163,.28);
  aspect-ratio:16/9;overflow:hidden}
.stage iframe,.stage video{position:absolute;inset:0;width:100%;height:100%;border:0;object-fit:contain}
.holding{position:absolute;inset:0;display:grid;place-content:center;gap:14px;text-align:center;
  padding:32px;background:
    linear-gradient(rgba(10,10,10,.82),rgba(10,10,10,.92)),
    ${B.ASSETS.cover ? `url('${B.ASSETS.cover}') center/cover no-repeat` : '#111'}}
.holding .kicker{margin-bottom:4px}
.holding p{margin:0;color:rgba(245,245,245,.66);max-width:44ch;font-size:.94rem}
.meta{display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center;
  padding-top:14px;font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;
  color:rgba(245,245,245,.45)}
.meta .dot{width:4px;height:4px;background:var(--gold);border-radius:50%}
.progress{height:2px;background:rgba(163,163,163,.16);margin-top:2px}
.progress i{display:block;height:100%;width:0;background:var(--gold);transition:width .4s var(--ease)}
.after{padding:clamp(28px,5vw,52px) 0 8px;border-top:1px solid rgba(163,163,163,.2);margin-top:clamp(30px,5vw,54px)}
.after__grid{display:grid;gap:26px;grid-template-columns:1.25fr .85fr;align-items:start}
@media (max-width:820px){.after__grid{grid-template-columns:1fr}}
.pts{list-style:none;margin:18px 0 0;padding:0;display:grid;gap:12px}
.pts li{display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:baseline;
  color:rgba(245,245,245,.72);font-size:.95rem}
.pts b{color:var(--gold);font-weight:400;font-family:var(--serif);font-size:.9rem}
.card{border:1px solid rgba(163,163,163,.3);padding:26px 24px;background:rgba(163,163,163,.05)}
.card h3{font-family:var(--serif);font-weight:300;font-size:1.25rem;margin:0 0 8px}
.card p{margin:0 0 20px;color:rgba(245,245,245,.68);font-size:.92rem}
.you{font-size:.72rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);margin:0 0 10px}
`;

/**
 * @param asset  {slug,title,kicker,blurb,videoUrl,duration}
 * @param lead   {name,firstName,id,email} | null
 * @param next   {label,url,note} | null   what to do after watching
 */
function page({ asset, lead, next, token }) {
  const kind = providerOf(asset.videoUrl);
  const yt = kind === 'youtube' ? youtubeId(asset.videoUrl) : null;
  const vm = kind === 'vimeo' ? vimeoId(asset.videoUrl) : null;

  let player;
  if (!asset.videoUrl) {
    player = `<div class="holding">
        <p class="kicker">Arriving shortly</p>
        <p>This film is being finished. Your link stays live — it will play here the moment it is ready, and nothing about your place in the process changes.</p>
      </div>`;
  } else if (kind === 'file') {
    player = `<video id="v" controls playsinline preload="metadata" ${B.ASSETS.cover ? `poster="${B.ASSETS.cover}"` : ""}>
        <source src="${B.esc(asset.videoUrl)}"></video>`;
  } else if (yt) {
    player = `<div id="yt"></div>`;
  } else if (vm) {
    player = `<iframe id="vm" src="https://player.vimeo.com/video/${vm}?dnt=1" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  } else {
    player = `<iframe id="fr" src="${B.esc(asset.videoUrl)}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  }

  const hello = lead?.firstName
    ? `<p class="you">Prepared for ${B.esc(lead.firstName)}</p>` : '';

  const cta = next ? `<div class="card">
      <h3>${B.esc(next.label)}</h3>
      <p>${B.esc(next.note || '')}</p>
      ${next.url ? `<a class="btn" href="${B.esc(next.url)}" target="_blank" rel="noopener" id="cta">${B.esc(next.cta || 'Book it')}</a>` : ''}
    </div>` : '';

  const body = `
<main>
  <section class="hero"><div class="wrap">
    ${hello}
    <p class="kicker">${B.esc(asset.kicker || B.NAME)}</p>
    <h1 class="display">${B.esc(asset.title)}</h1>
    ${asset.blurb ? `<p class="lede">${B.esc(asset.blurb)}</p>` : ''}
    <div class="hero__grid" style="margin-top:26px">
      <div class="stage">${player}</div>
      <div class="progress"><i id="bar"></i></div>
      <div class="meta">
        ${asset.duration ? `<span>${B.esc(asset.duration)}</span><span class="dot"></span>` : ''}
        <span id="state">Ready when you are</span>
      </div>
    </div>
  </div></section>

  <section class="after"><div class="wrap after__grid">
    <div>
      <h2 class="display">What happens after you watch</h2>
      <ul class="pts">
        <li><b>01</b><span>Watch it through. It is short on purpose and it answers most of what people ask on a first call.</span></li>
        <li><b>02</b><span>We speak. The call is a conversation about fit, not a pitch — both directions.</span></li>
        <li><b>03</b><span>If it is right, we build the year around what you actually want from it.</span></li>
      </ul>
    </div>
    ${cta}
  </div></section>
</main>`;

  const script = `
(function(){
  var TOKEN=${JSON.stringify(token || '')}, SLUG=${JSON.stringify(asset.slug)};
  var sent={}, best=0, bar=document.getElementById('bar'), st=document.getElementById('state');
  function beat(ev,pct){
    if(ev!=='progress' && sent[ev]) return; sent[ev]=1;
    var b=JSON.stringify({t:TOKEN,slug:SLUG,event:ev,pct:Math.round(pct||0)});
    try{
      if(navigator.sendBeacon) navigator.sendBeacon('/api?source=vsl_event', new Blob([b],{type:'application/json'}));
      else fetch('/api?source=vsl_event',{method:'POST',headers:{'Content-Type':'application/json'},body:b,keepalive:true});
    }catch(e){}
  }
  function mark(pct){
    if(!isFinite(pct)) return;
    if(pct>best){best=pct; if(bar) bar.style.width=Math.min(100,best)+'%';}
    [25,50,75].forEach(function(g){ if(best>=g && !sent['p'+g]){sent['p'+g]=1; beat('progress',g);} });
    if(best>=95 && !sent.complete){ beat('complete',100); if(st) st.textContent='Watched'; }
    else if(st && best>0) st.textContent='Watching \\u00b7 '+Math.round(best)+'%';
  }
  beat('open',0);
  window.addEventListener('pagehide',function(){ if(best>0) beat('depth',best); });

  var v=document.getElementById('v');
  if(v){
    v.addEventListener('play',function(){ beat('play',0); });
    v.addEventListener('timeupdate',function(){ if(v.duration) mark(v.currentTime/v.duration*100); });
    v.addEventListener('ended',function(){ mark(100); });
  }
  ${yt ? `
  var tag=document.createElement('script'); tag.src='https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
  window.onYouTubeIframeAPIReady=function(){
    var p=new YT.Player('yt',{videoId:${JSON.stringify(yt)},
      playerVars:{rel:0,modestbranding:1,playsinline:1},
      events:{onStateChange:function(e){
        if(e.data===YT.PlayerState.PLAYING){ beat('play',0);
          clearInterval(window.__t); window.__t=setInterval(function(){
            var d=p.getDuration(); if(d) mark(p.getCurrentTime()/d*100);
          },1000);
        }
        if(e.data===YT.PlayerState.ENDED){ mark(100); clearInterval(window.__t); }
      }}});
  };` : ''}
  ${vm ? `
  var s=document.createElement('script'); s.src='https://player.vimeo.com/api/player.js';
  s.onload=function(){
    var p=new Vimeo.Player(document.getElementById('vm'));
    p.on('play',function(){ beat('play',0); });
    p.on('timeupdate',function(d){ mark(d.percent*100); });
    p.on('ended',function(){ mark(100); });
  };
  document.head.appendChild(s);` : ''}
  var cta=document.getElementById('cta');
  if(cta) cta.addEventListener('click',function(){ beat('cta',best); });
})();`;

  return B.shell({
    title: `${asset.title} · ${B.NAME}`,
    description: asset.blurb,
    body, css: CSS, script,
  });
}

module.exports = { page, providerOf, youtubeId, vimeoId };
