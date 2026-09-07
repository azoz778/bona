/* Consent-gated tag loader for Google Analytics 4, the Meta Pixel, the Snap Pixel and the TikTok Pixel
   (spec §3.2). Inlined into <head> by Head.astro right after attribution.js.

   Ids arrive in window.BONA_TAGS = { ga4, metaPixel, snapPixel, tiktokPixel } (from site.json → analytics);
   the visitor's choice lives in localStorage `bona_consent` = { v:1, analytics, ads, ts } (written by
   Consent.astro). Two gates, and a tag needs both:

     - an id. A null id in site.json is not "off pending configuration", it is inert: the vendor is not in
       BONA_TAGS, nothing is injected, nothing is requested, and the site behaves exactly as it does today with
       every id null. Paste a real id into site.json → analytics and that vendor starts on the next deploy,
       with no code change anywhere.
     - consent. window.bonaTagsLoad() is idempotent: it runs once here and again after every consent choice, and
       only then does it inject a vendor script — with no consent record, or with "Essential only", nothing from
       Google, Meta, Snap or TikTok is ever requested. GA4 rides on the analytics choice; the three ad pixels
       ride on the ads choice.

   GA4 uses Consent Mode v2 (default all denied, then an update that mirrors the choice; ads storage stays denied
   when only analytics was accepted). Page views re-fire on astro:page-load.
   Plain ES2017, no imports, never throws. */
(function () {
  if (window.__bonaTags) return;
  window.__bonaTags = true;

  var CONSENT_KEY = 'bona_consent';
  var loaded = { ga: false, meta: false, snap: false, tiktok: false };
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

  function loadTiktok(id) {
    if (loaded.tiktok) return;
    loaded.tiktok = true;
    /* TikTok's own loader, verbatim apart from formatting. `ttq.page()` is left out: the page view is fired from
       pageView() below, so a view transition counts exactly like a fresh document. */
    (function (w, d, t) {
      w.TiktokAnalyticsObject = t;
      var ttq = w[t] = w[t] || [];
      ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent'];
      ttq.setAndDefer = function (o, m) { o[m] = function () { o.push([m].concat(Array.prototype.slice.call(arguments, 0))); }; };
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
      ttq.instance = function (k) { var e = ttq._i[k] || [], n; for (n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e; };
      ttq.load = function (e, n) {
        var r = 'https://analytics.tiktok.com/i18n/pixel/events.js';
        ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r;
        ttq._t = ttq._t || {}; ttq._t[e] = +new Date();
        ttq._o = ttq._o || {}; ttq._o[e] = n || {};
        var s = d.createElement('script');
        s.type = 'text/javascript'; s.async = !0; s.src = r + '?sdkid=' + e + '&lib=' + t;
        var f = d.getElementsByTagName('script')[0];
        if (f && f.parentNode) f.parentNode.insertBefore(s, f); else (d.head || d.documentElement).appendChild(s);
      };
      ttq.load(id);
    })(window, document, 'ttq');
  }

  /** One page view per page, per loaded tag. Safe to call repeatedly (a consent accept mid-page, a navigation). */
  function pageView() {
    var href = location.href;
    if (viewed === href) return;
    viewed = href;
    try { if (loaded.ga && typeof gtag === 'function') gtag('event', 'page_view'); } catch (e) { /* ignore */ }
    try { if (loaded.meta && typeof fbq === 'function') fbq('track', 'PageView'); } catch (e) { /* ignore */ }
    try { if (loaded.snap && typeof snaptr === 'function') snaptr('track', 'PAGE_VIEW'); } catch (e) { /* ignore */ }
    try { if (loaded.tiktok && window.ttq) window.ttq.page(); } catch (e) { /* ignore */ }
  }

  function load() {
    var c = consent();
    if (!c || !(c.analytics || c.ads)) return; // undecided or essential only: nothing loads
    var t = tags();
    var before = loaded.ga + loaded.meta + loaded.snap + loaded.tiktok;
    try { if (c.analytics && t.ga4) loadGa(String(t.ga4), c.analytics, c.ads); } catch (e) { /* ignore */ }
    try { if (c.ads && t.metaPixel) loadMeta(String(t.metaPixel)); } catch (e) { /* ignore */ }
    try { if (c.ads && t.snapPixel) loadSnap(String(t.snapPixel)); } catch (e) { /* ignore */ }
    try { if (c.ads && t.tiktokPixel) loadTiktok(String(t.tiktokPixel)); } catch (e) { /* ignore */ }
    // A tag that has just been switched on still owes a view for the page it woke up on.
    if (loaded.ga + loaded.meta + loaded.snap + loaded.tiktok > before) viewed = '';
    pageView();
  }

  window.bonaTagsLoad = function () { try { load(); } catch (e) { /* ignore */ } };

  window.bonaTagsLoad();
  document.addEventListener('astro:after-swap', function () { navigated = true; });
  document.addEventListener('astro:page-load', function () { if (!navigated) return; try { pageView(); } catch (e) { /* ignore */ } });
})();
