/* ===================================================================
   Site tracker
   Records a visit, then how far that visitor gets through the
   application, and reports both to the journey service.

   Add it to your website with
     <script src="https://your-eod-app.example.com/t.js" defer></script>
   It posts back to the server it was loaded from. Two rules govern everything here:
   it must never throw into the page, and it must never block it.
   Every call is wrapped, every failure is swallowed, and the payload
   is sent as text/plain so the browser treats it as a simple CORS
   request — application/json would force a preflight that sendBeacon
   cannot satisfy.
   =================================================================== */
(function () {
  "use strict";
  if (window.__eodTracker) return;
  window.__eodTracker = 1;

  // The API lives wherever this script was served from.
  var API  = (function () {
    try { return new URL(document.currentScript.src).origin + "/api"; } catch (e) { return "/api"; }
  })();
  var SID  = "eod_sid";
  var ATTR = "eod_attr";

  function ls(store, key) {
    try { return window[store].getItem(key) || ""; } catch (e) { return ""; }
  }
  function lsSet(store, key, val) {
    try { window[store].setItem(key, val); } catch (e) {}
  }

  function post(source, data, cb) {
    var body;
    try { body = JSON.stringify(data); } catch (e) { return; }
    var url = API + "?source=" + source;
    try {
      if (!cb && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: "text/plain;charset=UTF-8" }));
        return;
      }
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: body,
        keepalive: true,
        credentials: "omit"
      }).then(function (r) { return r.json(); })
        .then(function (j) { if (cb) cb(j); })
        .catch(function () {});
    } catch (e) {}
  }

  function attr() {
    try { return JSON.parse(ls("localStorage", ATTR) || "null") || {}; }
    catch (e) { return {}; }
  }

  function device() {
    var ua = navigator.userAgent || "";
    if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return "Tablet";
    if (/Mobi|Android|iPhone|iPod|IEMobile|BlackBerry/i.test(ua)) return "Mobile";
    return "Desktop";
  }

  /* ------------------------------------------------------- the visit */
  var sid = ls("sessionStorage", SID);
  var a = attr();

  post("site_view", {
    sid: sid || null,
    path: location.pathname || "/",
    ref: document.referrer || "",
    channel: a.lead_channel || "",
    campaign: a.utm_campaign || "",
    landing: a.landing_page || location.pathname || "/",
    device: device(),
    title: (document.title || "").slice(0, 120)
  }, function (res) {
    if (res && res.sid) { sid = res.sid; lsSet("sessionStorage", SID, sid); flush(); }
  });

  /* ------------------------------------- how far through the form */
  var reach = 0, label = "", started = false, done = false, email = "", dirty = false;

  function screens() {
    try { return [].slice.call(document.querySelectorAll("[data-tf-screen]")); }
    catch (e) { return []; }
  }

  function read() {
    var list = screens();
    if (!list.length) return;
    var last = list.length - 1;             // the success card
    var visible = null;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!el.hidden && el.offsetParent !== null) { visible = el; break; }
    }
    if (!visible) return;

    var n = Number(visible.getAttribute("data-tf-screen"));
    if (isNaN(n)) return;

    if (n > 0) started = true;
    if (n >= last) done = true;
    if (n > reach) {
      reach = n;
      var h = visible.querySelector(".tf-qt");
      label = h ? (h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) : "";
      dirty = true;
    }
    var box = document.querySelector('input[name="email"]');
    if (box && box.value && box.value !== email) { email = box.value.trim(); dirty = true; }
  }

  function flush() {
    if (!dirty || !sid) return;
    dirty = false;
    post("form_step", {
      sid: sid, step: reach, label: label,
      started: started, completed: done, email: email
    });
  }

  try {
    var form = document.querySelector("[data-tf-screen]");
    if (form) {
      read();
      // The form toggles `hidden` on the screen divs, so that is the signal.
      var mo = new MutationObserver(function () { read(); flush(); });
      mo.observe(document.body, {
        subtree: true, attributes: true, attributeFilter: ["hidden", "class"]
      });
      document.addEventListener("change", function () { read(); flush(); }, true);
      // A slow safety net, in case a transition never mutates what we watch.
      setInterval(function () { read(); flush(); }, 5000);
    }
  } catch (e) {}

  window.addEventListener("pagehide", function () { read(); dirty = true; flush(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { read(); dirty = true; flush(); }
  });
})();
