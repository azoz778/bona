/* First-party attribution (spec §3.1). Inlined into <head> by Head.astro on every page. The site's own origin
   is never written down here: the API base comes from window.BONA_API, which Head.astro fills from
   site.json → concierge.apiBase, and everything else is relative.

   What it does, in order:
   - remembers where the visitor came from: first touch (never overwritten) and last touch (updated on every
     external arrival — a UTM, a click id, or an outside referrer), plus a 30-minute session that mints a short
     `ref` code (6 chars, no 0/O/1/I) so a WhatsApp message can be tied back to the visit;
   - sends journey events to the API as text/plain JSON (a CORS "simple request": no preflight, keepalive);
   - rewrites every WhatsApp link at click time so its prefilled message ends with `Ref <listing> · <ref>`;
   - mirrors the important events into the vendor tags (GA4, Meta, Snap, TikTok), but only when tags.js has
     loaded them after consent, and always under the same event_id the server-side fan-out re-sends them with,
     so a person seen by both the pixel and the Conversions API is counted once.

   Storage follows consent: with analytics or ads accepted the state lives in localStorage (90 days) and a
   `bona_id` cookie; otherwise it lives in sessionStorage and dies with the tab. Ref codes work either way.

   Plain ES2017, no imports, and it never throws: every entry point is wrapped, so a storage that is blocked or
   an API that is down can never break the page. Binds once (window.__bonaAttr); per-page work re-runs on
   `astro:page-load` (view transitions swap the body, so listing ids are read fresh each time). */
(function () {
  if (window.__bonaAttr) return;
  window.__bonaAttr = true;

  var API = (typeof window.BONA_API === 'string' ? window.BONA_API : '').replace(/\/+$/, '');
  var KEY = 'bona_attr', CONSENT_KEY = 'bona_consent', COOKIE = 'bona_id';
  var DAYS = 90, SESSION_MS = 30 * 60 * 1000, MAX_STR = 300;
  var UTMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];
  var CIDS = ['fbclid', 'gclid', 'gbraid', 'wbraid', 'gad_source', 'gad_campaignid', 'ttclid', 'ScCid', 'msclkid', 'li_fat_id', 'twclid', 'dclid'];
  var SOCIAL = /instagram|facebook|google|tiktok|snapchat|x\.com|twitter|linkedin|youtube|whatsapp/;
  var ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var EVENTS = ['page_view', 'listing_view', 'gallery_open', 'tour_open', 'video_play', 'brochure_download', 'whatsapp_click', 'call_click', 'form_submit', 'consent_update', 'concierge_open', 'map_click'];
  var LISTING_RE = /^BONA-W?\d{3}$/;

  /* ------------------------------------------------------------------ helpers */
  function bytes(n) {
    var a = new Uint8Array(n);
    try { if (window.crypto && crypto.getRandomValues) { crypto.getRandomValues(a); return a; } } catch (e) { /* fall through */ }
    for (var i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
    return a;
  }
  function hex(n) { var a = bytes(n), s = ''; for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16); return s; }
  function code(n) { var a = bytes(n), s = ''; for (var i = 0; i < a.length; i++) s += ALPHA[a[i] % 32]; return s; }
  function clip(v) { if (v == null) return null; v = String(v); return v.length > MAX_STR ? v.slice(0, MAX_STR) : v; }
  function cookie(name) {
    try { var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; }
  }
  function getItem(store, k) { try { return window[store].getItem(k); } catch (e) { return null; } }
  function setItem(store, k, v) { try { window[store].setItem(k, v); return true; } catch (e) { return false; } }
  function removeItem(store, k) { try { window[store].removeItem(k); } catch (e) { /* ignore */ } }
  function parse(raw) { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
  function locale() {
    var l = (document.documentElement.getAttribute('lang') || '').toLowerCase();
    if (l.indexOf('ar') === 0) return 'ar';
    if (l.indexOf('en') === 0) return 'en';
    return /^\/ar(\/|$)/.test(location.pathname) ? 'ar' : 'en';
  }
  function listingOnPage() {
    var id = document.body && document.body.getAttribute('data-listing');
    return id && LISTING_RE.test(id) ? id : null;
  }
  function refHost(ref) { try { return ref ? new URL(ref).hostname.replace(/^www\./, '') : null; } catch (e) { return null; } }

  /* ------------------------------------------------------------------ consent */
  function consent() {
    var c = parse(getItem('localStorage', CONSENT_KEY));
    if (!c || typeof c !== 'object') return null;
    return { analytics: c.analytics === true, ads: c.ads === true };
  }
  function consentFlags() { var c = consent(); return { analytics: !!(c && c.analytics), ads: !!(c && c.ads) }; }
  function granted() { var c = consent(); return !!(c && (c.analytics || c.ads)); }

  /* ------------------------------------------------------------------ state */
  var state = null;
  var navigated = false; // becomes true after the first view transition (astro:after-swap)

  function fresh(now) {
    return { v: 1, anon_id: hex(16), created: now, first: null, last: null, session: null, fbp: null, fbc: null, ga: { client_id: null, session_id: null }, scid: null, ttp: null };
  }
  function valid(s, now) { return !!(s && typeof s === 'object' && s.v === 1 && typeof s.anon_id === 'string' && /^[0-9a-f]{32}$/.test(s.anon_id) && typeof s.created === 'number' && now - s.created <= DAYS * 86400000 && now >= s.created); }
  function load(now) {
    var local = parse(getItem('localStorage', KEY));
    if (valid(local, now)) return local;          // an earlier accept: keep using it, consent was given
    if (local) removeItem('localStorage', KEY);   // expired or foreign shape
    var session = parse(getItem('sessionStorage', KEY));
    if (valid(session, now)) return session;
    if (session) removeItem('sessionStorage', KEY);
    return null;
  }
  function save(s) {
    if (!s) return;
    var raw;
    try { raw = JSON.stringify(s); } catch (e) { return; }
    var persist = granted() || !!parse(getItem('localStorage', KEY));
    if (persist) {
      if (setItem('localStorage', KEY, raw)) removeItem('sessionStorage', KEY);
      else setItem('sessionStorage', KEY, raw);
      try { document.cookie = COOKIE + '=' + s.anon_id + '; Max-Age=' + (DAYS * 86400) + '; Path=/; Secure; SameSite=Lax'; } catch (e) { /* ignore */ }
    } else {
      setItem('sessionStorage', KEY, raw);
    }
  }

  /* A "touch": where this page load came from. `arrival` is the initial load of the document; on in-site
     navigations the referrer is our own previous page, so only a URL that carries UTMs/click ids counts. */
  function touch(now, arrival) {
    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { q = { get: function () { return null; } }; }
    var t = { ts: now, landing: clip(location.pathname + location.search), referrer: arrival ? clip(document.referrer || null) : null, click_ids: {} };
    var i, tagged = false;
    for (i = 0; i < UTMS.length; i++) { var u = q.get(UTMS[i]); t[UTMS[i]] = u ? clip(u) : null; if (u) tagged = true; }
    for (i = 0; i < CIDS.length; i++) { var c = q.get(CIDS[i]); if (c) { t.click_ids[CIDS[i]] = clip(c); tagged = true; } }
    var host = refHost(t.referrer);
    var external = !!(host && host !== location.hostname.replace(/^www\./, ''));
    if (!t.utm_source) {
      var ids = t.click_ids;
      if (ids.fbclid) { t.utm_source = 'meta'; t.utm_medium = t.utm_medium || 'paid'; }
      else if (ids.gclid || ids.gbraid || ids.wbraid) { t.utm_source = 'google'; t.utm_medium = t.utm_medium || 'cpc'; }
      else if (ids.ScCid) { t.utm_source = 'snapchat'; t.utm_medium = t.utm_medium || 'paid'; }
      else if (ids.ttclid) { t.utm_source = 'tiktok'; t.utm_medium = t.utm_medium || 'paid'; }
      else if (external) { t.utm_source = host; t.utm_medium = t.utm_medium || (SOCIAL.test(host) ? 'social_or_organic' : 'referral'); }
      else { t.utm_source = '(direct)'; t.utm_medium = t.utm_medium || '(none)'; }
    }
    t.external = tagged || external;
    return t;
  }

  /** Runs on every page view: touches, session, vendor ids. */
  function arrive(arrival) {
    var now = Date.now();
    var s = state || load(now) || fresh(now);
    var t = touch(now, arrival);
    var ext = t.external; delete t.external;
    if (!s.first) s.first = t;
    if (ext || !s.last) s.last = t;
    if (!s.session || typeof s.session.last_seen !== 'number' || now - s.session.last_seen > SESSION_MS) {
      s.session = { id: now.toString(36) + '-' + hex(2), ref: code(6), start: now, last_seen: now, pages: 0 };
    }
    s.session.last_seen = now;
    s.session.pages = (s.session.pages || 0) + 1;

    var fbclid = t.click_ids.fbclid;
    var fbcCookie = cookie('_fbc');
    if (fbcCookie) s.fbc = clip(fbcCookie);
    else if (fbclid) s.fbc = 'fb.1.' + now + '.' + fbclid;
    s.fbp = clip(cookie('_fbp')) || s.fbp || ('fb.1.' + now + '.' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0'));
    var ga = cookie('_ga');
    s.ga = s.ga || { client_id: null, session_id: null };
    if (ga) s.ga.client_id = clip(ga.replace(/^GA1\.\d\./, ''));
    try { var gm = document.cookie.match(/(?:^|; )_ga_[A-Z0-9]+=GS\d\.\d\.s?(\d+)/); if (gm) s.ga.session_id = gm[1]; } catch (e) { /* ignore */ }
    s.scid = clip(cookie('_scid')) || s.scid || null;
    s.ttp = clip(cookie('_ttp')) || s.ttp || null;

    state = s;
    save(s);
    window.BONA_ATTR = s;
    return s;
  }

  /* ------------------------------------------------------------------ events */
  function eventId() { return Date.now().toString(36) + '-' + hex(4); }

  /**
   * @param {string} event    one of EVENTS
   * @param {object} [props]
   * @param {string} [listing]
   * @param {{ eventId?: string }} [opts]  reuse an id minted elsewhere. The enquiry form does this: the id it
   *        posts to /v1/enquiry has to be the id the pixels fire Lead with, or Meta counts the same lead twice.
   */
  function send(event, props, listing, opts) {
    if (EVENTS.indexOf(event) < 0) return null;
    var s = state || arrive(!navigated);
    var id = (opts && typeof opts.eventId === 'string' && opts.eventId) ? opts.eventId : eventId();
    var lid = listing || listingOnPage();
    var p = {};
    if (props && typeof props === 'object') {
      for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k)) {
        var v = props[k];
        p[k] = typeof v === 'string' ? clip(v) : (typeof v === 'number' || typeof v === 'boolean' || v === null) ? v : clip(String(v));
      }
    }
    var body = {
      v: 1, event_id: id, ts: Date.now(), event: event,
      anon_id: s.anon_id, session_id: s.session.id, ref: s.session.ref,
      page: clip(location.pathname), locale: locale(), listing_id: lid && LISTING_RE.test(lid) ? lid : null,
      props: p,
      attr: { first: s.first, last: s.last, fbp: s.fbp, fbc: s.fbc, ga: s.ga, scid: s.scid, ttp: s.ttp },
      consent: consentFlags(),
    };
    if (API) {
      try {
        var raw = JSON.stringify(body);
        if (raw.length <= 8192) fetch(API + '/v1/events', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: raw, credentials: 'omit' }).catch(function () { /* the store is a nicety */ });
      } catch (e) { /* ignore */ }
    }
    mirror(event, body);
    return id;
  }

  /* What each vendor is told, per event. GA4 gets our own name (register it as a key event in the GA4 UI);
     the ad pixels get their own vocabulary, and `null` means that platform has no honest name for it — better
     no event than one that muddies a standard one the owner will optimise campaigns against. `metaCustom`
     sends the name through trackCustom instead of track. `page_view` is not here: tags.js owns it, so a view
     transition counts exactly once. `consent_update` is ours alone and is never mirrored. */
  var MIRROR = {
    listing_view:      { ga4: 'view_item',          meta: 'ViewContent',       snap: 'VIEW_CONTENT', tiktok: 'ViewContent' },
    whatsapp_click:    { ga4: 'whatsapp_click',     meta: 'Contact',           snap: 'CUSTOM_EVENT_1', tiktok: 'Contact' },
    call_click:        { ga4: 'call_click',         meta: 'Contact',           snap: null,           tiktok: 'Contact' },
    form_submit:       { ga4: 'generate_lead',      meta: 'Lead',              snap: 'SIGN_UP',      tiktok: 'SubmitForm' },
    brochure_download: { ga4: 'brochure_download',  meta: 'BrochureDownload',  snap: null,           tiktok: 'Download', metaCustom: true },
    concierge_open:    { ga4: 'concierge_open',     meta: null,                snap: null,           tiktok: null },
    map_click:         { ga4: 'map_click',          meta: 'FindLocation',      snap: null,           tiktok: null },
    tour_open:         { ga4: 'tour_open',          meta: null,                snap: null,           tiktok: null },
    gallery_open:      { ga4: 'gallery_open',       meta: null,                snap: null,           tiktok: null },
    video_play:        { ga4: 'video_play',         meta: null,                snap: null,           tiktok: null },
  };

  /** The vendor tags see the same events, with the same event_id (server-side fan-out dedupes on it). Every call
      is guarded: a tag that never loaded (no id, or no consent) simply is not a function, and a tag that throws
      must never take the page with it. */
  function mirror(event, body) {
    var m = MIRROR[event];
    if (!m) return;
    var listing = body.listing_id;
    var ids = listing ? [listing] : [];
    var cta = (body.props && body.props.cta) || undefined;
    try {
      if (m.ga4 && typeof gtag === 'function') {
        gtag('event', m.ga4, { listing_id: listing || undefined, cta: cta, ref: body.ref || undefined, event_id: body.event_id });
      }
    } catch (e) { /* ignore */ }
    try {
      if (m.meta && typeof fbq === 'function') {
        fbq(m.metaCustom ? 'trackCustom' : 'track', m.meta,
          listing ? { content_ids: ids, content_type: 'product' } : {},
          { eventID: body.event_id });
      }
    } catch (e) { /* ignore */ }
    try {
      if (m.snap && typeof snaptr === 'function') {
        snaptr('track', m.snap, { item_ids: ids, client_dedup_id: body.event_id });
      }
    } catch (e) { /* ignore */ }
    try {
      if (m.tiktok && window.ttq && typeof window.ttq.track === 'function') {
        window.ttq.track(m.tiktok,
          listing ? { contents: [{ content_id: listing, content_type: 'product' }] } : {},
          { event_id: body.event_id });
      }
    } catch (e) { /* a vendor tag must never break ours */ }
  }

  /* ------------------------------------------------------------------ WhatsApp Ref line */
  var MIDDOT = '·';
  function refLine(listing) { return 'Ref ' + (listing || 'BONA') + ' ' + MIDDOT + ' ' + state.session.ref; }
  /** Appends the Ref line as the last line of the prefilled message (unless one is already there). Keeps
      encodeURIComponent-style encoding (%20, never +): some WhatsApp clients show a literal "+" otherwise. */
  function withRef(href, listing) {
    var m = href.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
    if (!m) return href;
    var base = m[1], query = m[2] ? m[2].slice(1) : '', hash = m[3] || '';
    var parts = query ? query.split('&') : [], found = false, text = '';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf('text=') === 0) {
        found = true;
        try { text = decodeURIComponent(parts[i].slice(5).replace(/\+/g, '%20')); } catch (e) { text = ''; }
        if (!/(^|\n)Ref\b/.test(text)) text = (text ? text.replace(/\s+$/, '') + '\n' : '') + refLine(listing);
        parts[i] = 'text=' + encodeURIComponent(text);
      }
    }
    if (!found) parts.push('text=' + encodeURIComponent(refLine(listing)));
    return base + '?' + parts.join('&') + hash;
  }

  function onClick(ev) {
    var t = ev.target;
    if (t && t.nodeType === 3) t = t.parentElement;
    if (!t || !t.closest) return;
    var a = t.closest('a[href*="wa.me"], a[href*="api.whatsapp.com"]');
    if (a) {
      if (!state) arrive(!navigated);
      var listing = a.getAttribute('data-listing') || listingOnPage() || 'BONA';
      a.href = withRef(a.href, listing);
      send('whatsapp_click', { cta: a.getAttribute('data-cta') || null, href: a.href }, LISTING_RE.test(listing) ? listing : null);
      return;
    }
    var tel = t.closest('a[href^="tel:"]');
    if (tel) { send('call_click', { cta: tel.getAttribute('data-cta') || null, href: tel.getAttribute('href') }); return; }
    var tracked = t.closest('[data-track]');
    if (tracked) {
      var marked = tracked.getAttribute('data-listing');
      send(tracked.getAttribute('data-track'), { cta: tracked.getAttribute('data-cta') || null }, marked && LISTING_RE.test(marked) ? marked : null);
    }
  }

  /* ------------------------------------------------------------------ per page */
  function page(arrival) {
    arrive(arrival);
    send('page_view');
    if (listingOnPage()) send('listing_view');
  }

  /* ------------------------------------------------------------------ public API */
  window.bonaTrack = function (event, props, opts) { try { return send(event, props, null, opts); } catch (e) { return null; } };
  window.bonaEventId = function () { try { return eventId(); } catch (e) { return String(Date.now()); } };
  /** Re-applies the storage rule after a consent choice (moves the state into localStorage + cookie on accept). */
  window.bonaAttrPersist = function () { try { if (state) save(state); } catch (e) { /* ignore */ } };

  /* ------------------------------------------------------------------ boot */
  // This runs in <head>, before <body> exists: the first page view waits for the DOM (data-listing lives on body).
  var boot = function () { try { page(true); } catch (e) { /* never break the page */ } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  document.addEventListener('click', function (ev) { try { onClick(ev); } catch (e) { /* ignore */ } }, true);
  // `play` does not bubble, so it is caught in the capture phase; one event per <video> element (view transitions
  // render fresh elements, so a video on the next page counts again).
  document.addEventListener('play', function (ev) {
    try {
      var v = ev.target;
      if (!v || v.tagName !== 'VIDEO' || v.__bonaPlayed) return;
      v.__bonaPlayed = true;
      var src = v.currentSrc || (v.querySelector('source') ? v.querySelector('source').getAttribute('src') : null);
      send('video_play', { src: src || null });
    } catch (e) { /* ignore */ }
  }, true);
  document.addEventListener('astro:after-swap', function () { navigated = true; });
  // The ClientRouter also fires astro:page-load once for the initial document (on window load); that view is
  // already counted above, so only the loads that follow a swap are new pages.
  document.addEventListener('astro:page-load', function () { if (!navigated) return; try { page(false); } catch (e) { /* ignore */ } });
})();
