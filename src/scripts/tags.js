/* Consent-gated tag loader for Google Analytics 4, the Meta Pixel and the Snap Pixel (spec §3.2). Inlined into
   <head> by Head.astro right after attribution.js.

   Ids arrive in window.BONA_TAGS = { ga4, metaPixel, snapPixel } (from site.json → analytics); the visitor's
   choice lives in localStorage `bona_consent` = { v:1, analytics, ads, ts } (written by Consent.astro).
   window.bonaTagsLoad() is idempotent: it runs once here and again after every consent choice, and only then
   does it inject the vendor scripts — with no consent record, or with "Essential only", nothing from Google,
   Meta or Snap is ever requested. GA4 uses Consent Mode v2 (default all denied, then an update that mirrors the
   choice; ads storage stays denied when only analytics was accepted). Page views re-fire on astro:page-load.
   Plain ES2017, no imports, never throws. */
(function () {
  if (window.__bonaTags) return;
  window.__bonaTags = true;

  var CONSENT_KEY = 'bona_consent';
  var loaded = { ga: false, meta: false, snap: false };
  var viewed = ''; // href the loaded tags last recorded a page view for
  var navigated = false;

  function tags() { var t = window.BONA_TAGS; return t && typeof t === 'object' ? t : {}; }
  function consent() {
    try {
      var c = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null');
      if (!c || typeof c !== 'object') return null;
      return { analytics: c.analytics === true, ads: c.ads === true };
    } catch (e) { return null; }
  }
  function inject(src) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    (document.head || document.documentElement).appendChild(s);
  }

  function loadGa(id, analytics, ads) {
    if (!loaded.ga) {
      loaded.ga = true;
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
      gtag('consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
      gtag('js', new Date());
      gtag('config', id, { send_page_view: false, anonymize_ip: true });
      inject('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id));
    }
    gtag('consent', 'update', {
      analytics_storage: analytics ? 'granted' : 'denied',
      ad_storage: ads ? 'granted' : 'denied',
      ad_user_data: ads ? 'granted' : 'denied',
      ad_personalization: ads ? 'granted' : 'denied',
    });
  }

  function loadMeta(id) {
    if (loaded.meta) return;
    loaded.meta = true;
    /* Meta's own loader, verbatim apart from formatting. */
    (function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0];
      if (s && s.parentNode) s.parentNode.insertBefore(t, s); else (b.head || b.documentElement).appendChild(t);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    fbq('consent', 'grant');
    fbq('init', id);
  }

  function loadSnap(id) {
    if (loaded.snap) return;
    loaded.snap = true;
    /* Snap's own loader, verbatim apart from formatting. */
    (function (e, t, n) {
      if (e.snaptr) return; var a = e.snaptr = function () { a.handleRequest ? a.handleRequest.apply(a, arguments) : a.queue.push(arguments); };
      a.queue = []; var s = 'script'; var r = t.createElement(s); r.async = !0; r.src = n; var u = t.getElementsByTagName(s)[0];
      if (u && u.parentNode) u.parentNode.insertBefore(r, u); else (t.head || t.documentElement).appendChild(r);
    })(window, document, 'https://sc-static.net/scevent.min.js');
    snaptr('init', id, {});
  }

  /** One page view per page, per loaded tag. Safe to call repeatedly (a consent accept mid-page, a navigation). */
  function pageView() {
    var href = location.href;
    if (viewed === href) return;
    viewed = href;
    try { if (loaded.ga && typeof gtag === 'function') gtag('event', 'page_view'); } catch (e) { /* ignore */ }
    try { if (loaded.meta && typeof fbq === 'function') fbq('track', 'PageView'); } catch (e) { /* ignore */ }
    try { if (loaded.snap && typeof snaptr === 'function') snaptr('track', 'PAGE_VIEW'); } catch (e) { /* ignore */ }
  }

  function load() {
    var c = consent();
    if (!c || !(c.analytics || c.ads)) return; // undecided or essential only: nothing loads
    var t = tags();
    var before = loaded.ga + loaded.meta + loaded.snap;
    try { if (c.analytics && t.ga4) loadGa(String(t.ga4), c.analytics, c.ads); } catch (e) { /* ignore */ }
    try { if (c.ads && t.metaPixel) loadMeta(String(t.metaPixel)); } catch (e) { /* ignore */ }
    try { if (c.ads && t.snapPixel) loadSnap(String(t.snapPixel)); } catch (e) { /* ignore */ }
    // A tag that has just been switched on still owes a view for the page it woke up on.
    if (loaded.ga + loaded.meta + loaded.snap > before) viewed = '';
    pageView();
  }

  window.bonaTagsLoad = function () { try { load(); } catch (e) { /* ignore */ } };

  window.bonaTagsLoad();
  document.addEventListener('astro:after-swap', function () { navigated = true; });
  document.addEventListener('astro:page-load', function () { if (!navigated) return; try { pageView(); } catch (e) { /* ignore */ } });
})();
