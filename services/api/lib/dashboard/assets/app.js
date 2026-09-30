/*
 * The Bona dashboard's one script (design §5, Phase 3). Everything works without it; it adds:
 *
 *   1. Phone alerts. Registers the service worker (/dashboard/sw.js, scope /dashboard/) when
 *      the page carries the server's push key. The Inbox page's "Phone alerts" panel turns
 *      alerts on (pushManager.subscribe, called straight from the click: iOS needs the tap)
 *      or off for THIS device. A device that already has alerts posts its subscription again
 *      on every page, which binds it to the current login (a new login after the old one
 *      expired brings its alerts back). On an iPhone outside the Home-Screen app it explains
 *      how to add it first (iOS 16.4 or later).
 *   2. Live refresh. The Inbox list and a thread carry a pulse URL and the token they were
 *      drawn from; every 15 s while visible (and at once on coming back) the token is asked
 *      again. A changed page is fetched again — by its own link, never by re-posting a form
 *      — only when no text box or field on it holds words or focus (a half-typed reply, a
 *      number being typed into "Add chat"); otherwise a note says there is something new,
 *      and the draft is never touched. A page the person is already leaving is left alone.
 *
 * No inline code anywhere (the CSP allows only this file), no HTML built from strings,
 * nothing stored in the browser. Every write carries X-Bona-Dash: 1, like every dashboard write.
 */
(function () {
  'use strict';

  var PULSE_MS = 15000;
  var headers = { 'Content-Type': 'application/json', 'X-Bona-Dash': '1' };
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: headers, body: JSON.stringify(body), credentials: 'same-origin' });
  }

  /* ---------------- live refresh ---------------- */

  // A navigation the person started (a tap on Send, a link) must never be raced by a reload.
  var leaving = false;
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeunload', function () { leaving = true; });
  }

  /** Any field with words in it, or the one being typed in: the page holds a draft. */
  function drafting() {
    var fields = document.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=tel], input[type=search]');
    return Array.prototype.some.call(fields, function (f) { return f.value.trim() !== '' || document.activeElement === f; });
  }

  var pulse = document.querySelector('[data-pulse]');
  if (pulse && pulse.dataset && pulse.dataset.pulse) {
    var asking = false;
    var check = async function () {
      if (asking || document.visibilityState !== 'visible') return;
      asking = true;
      try {
        var res = await fetch(pulse.dataset.pulse, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        var body = await res.json();
        if (!body || typeof body.token !== 'string' || body.token === pulse.dataset.pulseToken) return;
        var note = document.querySelector('[data-pulse-note]');
        if (drafting()) {
          if (note) note.hidden = false;
          return;
        }
        if (leaving) return;
        // The note's own link is the page's GET address: a thread drawn by a refused reply
        // (a POST) is fetched again, not re-posted with a "confirm resubmission" prompt.
        var link = note && note.querySelector ? note.querySelector('a') : null;
        if (link) location.replace(link.href);
        else location.reload();
      } catch (e) {
        /* offline for a moment: the next pulse asks again */
      } finally {
        asking = false;
      }
    };
    setInterval(check, PULSE_MS);
    document.addEventListener('visibilitychange', check);
  }

  /* ---------------- phone alerts ---------------- */

  var keyMeta = document.querySelector('meta[name="bona-push-key"]');
  var pushKey = keyMeta ? keyMeta.content : '';
  var panel = document.querySelector('[data-alerts]');
  var text = document.querySelector('[data-alerts-text]');
  var onBtn = document.querySelector('[data-alerts-on]');
  var offBtn = document.querySelector('[data-alerts-off]');
  var supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
  var ios = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent || '')
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  var standalone = typeof window !== 'undefined' && ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || navigator.standalone === true);
  var registration = null;

  var WORDS = {
    on: 'Alerts are on for this device.',
    off: 'Get a notification on this device when a client writes in the Bona inbox.',
    denied: 'Notifications are blocked for this site. Allow them in the browser settings, then reload this page.',
    ios: 'On iPhone: tap Share, then "Add to Home Screen". Open Bona from the Home Screen, sign in there, and turn alerts on (iOS 16.4 or later).',
    iosOld: 'Alerts need iOS 16.4 or later.',
    unsupported: 'This browser cannot show alerts.',
    error: 'Alerts could not be turned on. Try again, or reload the page.',
  };
  function show(state) {
    if (!panel) return;
    panel.hidden = false;
    if (text) text.textContent = WORDS[state] || '';
    if (onBtn) onBtn.hidden = !(state === 'off' || state === 'error');
    if (offBtn) offBtn.hidden = state !== 'on';
  }

  function keyBytes(b64u) {
    var pad = '='.repeat((4 - (b64u.length % 4)) % 4);
    var raw = atob((b64u + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }
  function plain(sub) {
    var j = sub.toJSON();
    return { endpoint: j.endpoint, keys: { p256dh: j.keys && j.keys.p256dh, auth: j.keys && j.keys.auth } };
  }

  async function turnOn() {
    if (!registration) return show('error');
    try {
      // Called first thing in the click: Safari asks for permission only inside the tap.
      var sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushKey) });
      var res = await post('/v1/admin/push/subscribe', plain(sub));
      if (res.ok) return show('on');
      // The server will never push to what it refused (an endpoint or keys it does not
      // take): drop it, so the next tap subscribes afresh instead of re-posting the same.
      if (res.status === 400) { try { await sub.unsubscribe(); } catch (e) { /* nothing worth keeping */ } }
      show('error');
    } catch (e) {
      show(Notification.permission === 'denied' ? 'denied' : 'error');
    }
  }
  async function turnOff() {
    var sub = null;
    try { sub = registration && await registration.pushManager.getSubscription(); } catch (e) { sub = null; }
    if (sub) {
      // Both, whatever the other answers: the browser must stop receiving even if the server
      // could not be told (it forgets the row at logout, or when the push service says gone),
      // and the server must forget even if the browser would not let go.
      try { await post('/v1/admin/push/unsubscribe', { endpoint: sub.endpoint }); } catch (e) { /* told next time */ }
      try { await sub.unsubscribe(); } catch (e) { /* the row is gone; a push to it is a 410 */ }
    }
    show('off');
  }
  if (onBtn) onBtn.addEventListener('click', turnOn);
  if (offBtn) offBtn.addEventListener('click', turnOff);

  /** The worker is registered: say what this device has, and bind an existing subscription to this login (P3-5). */
  async function sync(reg) {
    registration = reg;
    if (Notification.permission === 'denied') return show('denied');
    var sub = null;
    try { sub = await reg.pushManager.getSubscription(); } catch (e) { sub = null; }
    if (!sub || Notification.permission !== 'granted') return show('off');
    try {
      var res = await post('/v1/admin/push/subscribe', plain(sub));
      return show(res.ok ? 'on' : 'off');
    } catch (e) {
      // The browser holds a granted subscription; the server hears of it on the next load.
      return show('on');
    }
  }

  if (pushKey) {
    if (!supported) {
      show(ios ? (standalone ? 'iosOld' : 'ios') : 'unsupported');
    } else {
      // Only the registration itself failing means this browser cannot do alerts; what
      // follows it (`sync`) answers for its own errors, and anything it did not foresee
      // leaves the panel offering to turn alerts on rather than blank.
      navigator.serviceWorker.register('/dashboard/sw.js', { scope: '/dashboard/' })
        .then(sync, function () { show('unsupported'); })
        .catch(function () { show('off'); });
    }
  }
}());
