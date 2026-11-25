// Brands any page from journey.config.json -> business, via /api?action=config
// (open even when signed out, so the login page can use it too).
//
//   [data-brand-name]  gets the business name as text
//   [data-brand-mark]  gets the logo if one is set, otherwise the name
//   the favicon and the tab title suffix are set as well
(function () {
  if (location.protocol === 'file:') return;
  fetch('/api?action=config', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var b = (d && d.brand) || {};
      if (!b.name) return;
      document.querySelectorAll('[data-brand-name]').forEach(function (n) { n.textContent = b.name; });
      document.querySelectorAll('[data-brand-mark]').forEach(function (n) {
        if (b.logo) {
          var img = document.createElement('img');
          img.src = b.logo; img.alt = b.name;
          n.textContent = ''; n.append(img);
        } else n.textContent = b.name;
      });
      if (document.title.indexOf(b.name) < 0) document.title = document.title + ' · ' + b.name;
      if (b.favicon) {
        var l = document.createElement('link'); l.rel = 'icon'; l.href = b.favicon; document.head.append(l);
      }
    })
    .catch(function () {});
})();
