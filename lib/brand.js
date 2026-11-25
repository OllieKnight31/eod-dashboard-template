// The house style for the server-rendered pages (watch pages, /journey, /reports).
// Neutral monochrome by default. Name, logos and images come from
// journey.config.json -> business; change the CSS variables below to rebrand.

const CFG = require('../journey.config.json');
const BIZ = CFG.business || {};
const NAME = process.env.BUSINESS_NAME || BIZ.name || 'Your Brand';

// Every image is optional. With no logo the masthead shows the name as a wordmark.
const ASSETS = {
  favicon:  BIZ.favicon_url || '',
  heroLogo: BIZ.logo_url || '',
  footLogo: BIZ.footer_logo_url || BIZ.logo_url || '',
  cover:    BIZ.cover_url || '',
  og:       BIZ.og_image_url || BIZ.cover_url || '',
};

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?' +
  'family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;0,6..72,500;1,6..72,300&' +
  'family=Inter+Tight:wght@300;400;500;600&display=swap">';

const CSS = `
:root{
  --gold:#A3A3A3; --gold-deep:#737373; --gold-lite:#D4D4D4; --gold-dark:#404040;
  --ink:#0A0A0A; --charcoal:#262626; --olive:#3F3F3F; --wine:#722F37;
  --cream:#F5F5F5; --cream-2:#EEEEEE; --sand:#E5E5E5; --shell:#FAFAFA;
  --line:rgba(38,38,38,.14); --line-gold:rgba(163,163,163,.38);
  --serif:"Newsreader",Georgia,"Times New Roman",serif;
  --sans:"Inter Tight","Helvetica Neue",Arial,sans-serif;
  --ease:cubic-bezier(.22,.61,.36,1);
  --wrap:1120px;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{
  margin:0;background:var(--ink);color:var(--cream);
  font-family:var(--sans);font-weight:400;font-size:16.5px;line-height:1.6;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
}
img,video{max-width:100%;height:auto;display:block}
a{color:inherit;text-decoration:none}
:focus-visible{outline:2px solid var(--gold);outline-offset:3px}
.wrap{max-width:var(--wrap);margin:0 auto;padding:0 clamp(18px,4vw,40px)}

.display{font-family:var(--serif);font-weight:300;line-height:1.08;letter-spacing:-.012em;margin:0;
  font-size:clamp(1.9rem,4.4vw,3.1rem)}
h2.display{font-size:clamp(1.4rem,2.8vw,2rem)}
.kicker{
  font-family:var(--sans);font-size:.63rem;font-weight:500;letter-spacing:.28em;
  text-transform:uppercase;color:var(--gold);margin:0 0 14px
}
.lede{font-size:1.02rem;line-height:1.7;color:rgba(245,245,245,.74);max-width:62ch;margin:16px 0 0}
.rule{height:1px;background:var(--line-gold);border:0;margin:0}

/* masthead */
.mast{border-bottom:1px solid rgba(163,163,163,.22);background:rgba(10,10,10,.86);
  backdrop-filter:saturate(140%) blur(10px);position:sticky;top:0;z-index:40}
.mast__in{display:flex;align-items:center;justify-content:space-between;gap:20px;
  padding:15px clamp(18px,4vw,40px);max-width:var(--wrap);margin:0 auto}
.mast img{height:26px;width:auto;opacity:.95}
.mast__word{font-family:var(--serif);font-size:1.15rem;letter-spacing:.02em;color:var(--cream)}
.mast__tag{font-size:.6rem;letter-spacing:.26em;text-transform:uppercase;color:rgba(245,245,245,.5)}

/* buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;
  font-size:.72rem;font-weight:500;letter-spacing:.18em;text-transform:uppercase;
  padding:15px 30px;border:1px solid var(--gold);background:var(--gold);color:var(--ink);
  cursor:pointer;border-radius:0;transition:background .35s var(--ease),color .35s var(--ease),border-color .35s var(--ease)}
.btn:hover{background:var(--gold-dark);border-color:var(--gold-dark);color:var(--cream)}
.btn--ghost{background:transparent;color:var(--cream);border-color:rgba(163,163,163,.5)}
.btn--ghost:hover{background:rgba(163,163,163,.12);color:var(--cream);border-color:var(--gold)}

/* footer */
.foot{border-top:1px solid rgba(163,163,163,.2);margin-top:72px;padding:34px 0 44px;
  color:rgba(245,245,245,.42);font-size:.76rem}
.foot__in{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between}
.foot img{height:20px;opacity:.55}
@media (max-width:640px){ body{font-size:16px} }
`;

function shell({ title, description, body, css = '', script = '', head = '', ogImage = ASSETS.og }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description || '')}">
<meta name="robots" content="noindex,nofollow">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description || '')}">
${ogImage ? `<meta property="og:image" content="${ogImage}">` : ''}
${ASSETS.favicon ? `<link rel="icon" href="${ASSETS.favicon}">` : ''}
${FONTS}
<style>${CSS}${css}</style>
${head}
</head><body>
<header class="mast"><div class="mast__in">
  <a href="${esc(BIZ.website || '#')}">${ASSETS.heroLogo ? `<img src="${ASSETS.heroLogo}" alt="${esc(NAME)}">` : `<span class="mast__word">${esc(NAME)}</span>`}</a>
  <span class="mast__tag">${esc(BIZ.tagline || '')}</span>
</div></header>
${body}
<footer class="foot"><div class="wrap foot__in">
  ${ASSETS.footLogo ? `<img src="${ASSETS.footLogo}" alt="">` : `<span class="mast__word">${esc(NAME)}</span>`}
  <span>&copy; ${new Date().getFullYear()} ${esc(NAME)} &middot; This link was prepared for you and is not public.</span>
</div></footer>
${script ? `<script>${script}</script>` : ''}
</body></html>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// What the browser pages need to brand themselves (safe to show signed out).
function brandInfo() {
  return {
    name: NAME,
    website: BIZ.website || '',
    logo: ASSETS.heroLogo,
    favicon: ASSETS.favicon,
    currency: BIZ.currency || 'USD',
    locale: BIZ.locale || 'en-US',
  };
}

module.exports = { brandInfo, NAME, BIZ, ASSETS, CSS, FONTS, shell, esc };
