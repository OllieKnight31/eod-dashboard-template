// Sign-in guard + the top bar, shared by every page.
//
//   <script src="/auth.js" data-allow="owner,manager"></script>      (in <head>)
//
// Not signed in → the login page. Signed in but not allowed here → that role's home.
// This only decides what is SHOWN; the API enforces the same rules on the data.
//
// Pages can wait for `window.EOD_AUTH` (a promise of the signed-in user) and mark any
// element with data-roles="owner,manager" to have it removed for everyone else.
(function () {
  var allow = (document.currentScript.dataset.allow || 'owner,manager,setter,triage,closer').split(',');
  var root = document.documentElement;
  // Opened straight from disk (the preview copy of the report): there is no server to ask.
  if (location.protocol === 'file:') { window.EOD_AUTH = Promise.resolve(null); return; }
  root.style.visibility = 'hidden';                       // no flash of a page you can't use
  var never = new Promise(function () {});
  var ROLE_NAME = { owner: 'Owner', manager: 'Manager', setter: 'Setter', triage: 'Triage', closer: 'Closer' };

  function ready(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }
  function el(tag, props, kids) {
    var n = Object.assign(document.createElement(tag), props || {});
    (kids || []).forEach(function (k) { if (k) n.append(k); });
    return n;
  }

  function bar(user) {
    var manages = user.role === 'owner' || user.role === 'manager';
    var links = manages
      ? [['/reports', 'Reports'], ['/scorecard', 'Scorecard'], ['/journey', 'Client journey'], ['/eod', 'Submit EOD']]
      : [['/eod', 'Submit EOD'], ['/scorecard', 'My scorecard']];
    var here = location.pathname.replace(/\/$/, '') || '/';
    if (here === '/eod-report.html') here = '/eod';
    var nav = el('nav', { className: 'authbar__nav' }, links.map(function (l) {
      return el('a', { href: l[0], textContent: l[1], className: here === l[0] ? 'on' : '' });
    }));
    var out = el('button', { type: 'button', className: 'authbar__out', textContent: 'Log out' });
    out.onclick = function () {
      fetch('/api?source=auth_logout', { method: 'POST' }).finally(function () { location.href = '/login'; });
    };
    // Logins off: no name to show and nothing to log out of.
    var right = el('div', { className: 'authbar__who' }, user.open
      ? [el('span', { className: 'authbar__role', textContent: 'Open access' })]
      : [
        el('span', { className: 'authbar__name', textContent: user.name }),
        el('span', { className: 'authbar__role', textContent: ROLE_NAME[user.role] || user.role }),
        out,
      ]);
    if (user.role === 'owner') {
      var gear = el('a', { href: '/settings', className: 'authbar__gear' + (here === '/settings' ? ' on' : ''), title: 'Settings' });
      gear.setAttribute('aria-label', 'Settings');
      gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03z"/></svg>';
      right.append(gear);
    }
    return el('div', { className: 'authbar' }, [el('div', { className: 'authbar__in' }, [nav, right])]);
  }

  // The house style: ink, cream, gold hairlines, square edges.
  var CSS = '.authbar{background:#0A0A0A;border-bottom:1px solid rgba(163,163,163,.22);font-family:"Inter Tight","Helvetica Neue",Arial,sans-serif;text-align:left}'
    + '.authbar__in{display:flex;align-items:center;justify-content:space-between;gap:10px 18px;flex-wrap:wrap;max-width:1180px;margin:0 auto;padding:9px clamp(18px,4vw,40px)}'
    + '.authbar__nav{display:flex;gap:2px;flex-wrap:wrap}'
    + '.authbar__nav a{padding:7px 12px;font-size:10.5px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;text-decoration:none;color:rgba(245,245,245,.62);white-space:nowrap;border:1px solid transparent}'
    + '.authbar__nav a:hover{color:#F5F5F5}'
    + '.authbar__nav a.on{color:#D4D4D4;border-color:rgba(163,163,163,.42);background:rgba(163,163,163,.1)}'
    + '.authbar__who{display:flex;align-items:center;gap:10px;font-size:12.5px;color:rgba(245,245,245,.6)}'
    + '.authbar__name{color:#F5F5F5}'
    + '.authbar__role{font-size:9.5px;font-weight:500;text-transform:uppercase;letter-spacing:.18em;padding:3px 8px;border:1px solid rgba(163,163,163,.38);color:#A3A3A3}'
    + '.authbar__out{font:inherit;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:inherit;background:none;border:1px solid rgba(245,245,245,.2);padding:7px 11px;cursor:pointer;border-radius:0}'
    + '.authbar__out:hover,.authbar__gear:hover,.authbar__gear.on{color:#D4D4D4;border-color:#A3A3A3}'
    + '.authbar__gear{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid rgba(245,245,245,.2);color:inherit}'
    + '.authbar__gear svg{width:16px;height:16px}'
    + '.authbar a:focus-visible,.authbar button:focus-visible{outline:2px solid #A3A3A3;outline-offset:2px}';

  window.EOD_AUTH = fetch('/api?action=me', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.status !== 'ok') { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search)); return never; }
      if (allow.indexOf(d.user.role) < 0) { location.replace(d.home); return never; }
      window.EOD_USER = d.user;
      ready(function () {
        document.head.append(el('style', { textContent: CSS }));
        document.body.prepend(bar(d.user));
        document.querySelectorAll('[data-roles]').forEach(function (node) {
          if (node.dataset.roles.split(',').indexOf(d.user.role) < 0) node.remove();
        });
        root.style.visibility = '';
      });
      return d.user;
    })
    .catch(function () { root.style.visibility = ''; return never; });
})();
