/* ============================================================
   RDM FUNNEL ANALYTICS — GA4 + Meta Pixel, centralized.

   ▶ TO GO LIVE: paste your two real IDs into the constants below.
     - GA4_ID   = Google Analytics 4 Measurement ID  (GA Admin → Data streams → looks like "G-ABCD1234EF")
     - PIXEL_ID = Meta (Facebook) Pixel ID            (Meta Events Manager → looks like "1234567890")
   Until BOTH are real, this file is a SAFE NO-OP: nothing loads, no errors,
   window.rdmTrack() still works (it just does nothing). So it can ship now.

   What it gives every page that loads it:
     • auto page_view (GA4) + PageView (Pixel)
     • window.rdmTrack(name, params)  → sends to BOTH GA4 and the Pixel
     • auto click tracking on any element with  data-track="EventName"
       (optional data-track-params='{"value":147,"currency":"USD","product":"Method"}')
   ============================================================ */
(function () {
  var GA4_ID   = "G-R3GJ1VENHY";       // <-- paste GA4 Measurement ID here
  var PIXEL_ID = "XXXXXXXXXXXXXXX";    // <-- paste Meta Pixel ID here

  // "On" only when a REAL id is set — the placeholders below are treated as off (so this ships as a no-op).
  var gaOn = /^G-[A-Z0-9]{6,}$/.test(GA4_ID) && GA4_ID !== "G-XXXXXXXXXX";
  var pxOn = /^[0-9]{6,}$/.test(PIXEL_ID) && PIXEL_ID !== "XXXXXXXXXXXXXXX";

  // ---- GA4 (gtag.js) ----
  if (gaOn) {
    var g = document.createElement("script"); g.async = true;
    g.src = "https://www.googletagmanager.com/gtag/js?id=" + GA4_ID;
    document.head.appendChild(g);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag("js", new Date());
    gtag("config", GA4_ID);
  }

  // ---- Meta Pixel ----
  if (pxOn) {
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    fbq("init", PIXEL_ID);
    fbq("track", "PageView");
  }

  // ---- Unified tracker ----
  // Meta standard events get sent as-is (good for ad optimization); everything else
  // goes to the Pixel as a custom event. GA4 receives the raw event name + params.
  var FB_STANDARD = { Lead: 1, Purchase: 1, InitiateCheckout: 1, Schedule: 1, CompleteRegistration: 1, ViewContent: 1, Contact: 1 };
  window.rdmTrack = function (name, params) {
    params = params || {};
    try { if (gaOn && window.gtag) gtag("event", name, params); } catch (e) {}
    try {
      if (pxOn && window.fbq) {
        var fbParams = {};
        if (params.value != null) fbParams.value = params.value;
        if (params.currency) fbParams.currency = params.currency;
        if (params.product) fbParams.content_name = params.product;
        if (FB_STANDARD[name]) fbq("track", name, fbParams);
        else fbq("trackCustom", name, params);
      }
    } catch (e) {}
  };

  // ---- Declarative click tracking: add data-track="EventName" to any button/link ----
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-track]");
    if (!el) return;
    var name = el.getAttribute("data-track");
    var params = {};
    var raw = el.getAttribute("data-track-params");
    if (raw) { try { params = JSON.parse(raw); } catch (_) {} }
    window.rdmTrack(name, params);
  }, true);
})();
