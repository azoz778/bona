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
 *   3. A tapped alert. The service worker asks this page before anything moves, in two
 *      steps: `bona:open` (may you go?) — with nothing being typed the page says yes; else
 *      it says no and shows its "new activity" note with the chat's link, and the worker
 *      leaves it be — then `bona:go`, and only on that does the page navigate (checking
 *      again first). A draft is never navigated over, and only our own /dashboard/push/open
 *      is ever followed.
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
  // iOS Safari never fires beforeunload, so pagehide, a submitted form and a tap on one of
  // our own links count too (capture: before any handler could stop them; a tap that opens
  // a new tab — a modifier key, a middle button, target=_blank — leaves this page where it
  // is). A page brought back from the back-forward cache is not leaving any more: pageshow
  // fires on every restore and clears the flag.
  var leaving = false;
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeunload', function () { leaving = true; });
    window.addEventListener('pagehide', function () { leaving = true; });
    window.addEventListener('pageshow', function () { leaving = false; });
    document.addEventListener('submit', function () { leaving = true; }, true);
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var link = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (link && link.origin === location.origin && link.target !== '_blank') leaving = true;
    }, true);
  }

  /**
   * Any field with words in it, or the one being typed in — or a select being picked from
   * (it holds no words, but a reload would drop the pick): the page holds a draft.
   */
  function drafting() {
    var active = document.activeElement;
    var fields = document.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=tel], input[type=search]');
    if (Array.prototype.some.call(fields, function (f) { return f.value.trim() !== '' || active === f; })) return true;
    return Boolean(active && typeof active.tagName === 'string' && active.tagName.toUpperCase() === 'SELECT');
  }

  /** The page must not be moved: it is already going somewhere, or something is being typed. */
  function busy() { return leaving || drafting(); }

  /** Point the "new activity" note at `href` and show it; a page without one shows nothing. */
  function noteWithLink(href) {
    var note = document.querySelector('[data-pulse-note]');
    if (!note) return;
    var link = note.querySelector ? note.querySelector('a') : null;
    if (link) link.href = href;
    note.hidden = false;
  }

  // A tapped alert (sw.js `notificationclick`): two steps over the worker's port. `bona:open`
  // asks; the page navigates only on the `bona:go` that follows a yes, and looks again then.
  // The one address ever followed is our own /dashboard/push/open on this origin: an exact
  // allowlist, so no message can send the page anywhere else.
  if (typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      var d = e.data;
      var port = e.ports && e.ports[0];
      if (!d || d.type !== 'bona:open' || typeof d.url !== 'string' || !port) return;
      var u;
      try { u = new URL(d.url, location.origin); } catch (err) { return; }
      if (u.origin !== location.origin || u.pathname !== '/dashboard/push/open') return;
      if (busy()) {
        noteWithLink(u.href);
        port.postMessage({ ok: false });
        return;
      }
      port.onmessage = function (ev) {
        if (!ev.data || ev.data.type !== 'bona:go') return;
        if (busy()) { noteWithLink(u.href); return; }
        leaving = true;
        location.assign(u.href);
      };
      port.postMessage({ ok: true });
    });
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
    offFailed: 'Alerts could not be turned off on this device — try again.',
  };
  function show(state) {
    if (!panel) return;
    panel.hidden = false;
    if (text) text.textContent = WORDS[state] || '';
    if (onBtn) onBtn.hidden = !(state === 'off' || state === 'error');
    if (offBtn) offBtn.hidden = !(state === 'on' || state === 'offFailed');
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
  /** The browser's subscription, or null when it truly has none; throws when it cannot say. */
  function subscription() {
    if (!registration) throw new Error('no registration');
    return registration.pushManager.getSubscription();
  }
  async function turnOff() {
    // Only a lookup that answers — null included — proves anything; one that fails proves
    // nothing, and "off" is not said on nothing.
    var sub;
    try { sub = await subscription(); } catch (e) { return show('offFailed'); }
    var gone = true; // nothing subscribed: nothing to turn off
    if (sub) {
      // The server first, whatever the browser then says: it must forget the row even if the
      // browser will not let go (it forgets anyway at logout, or when the push service says
      // the device is gone). Then the browser — and only its own word counts: the endpoint
      // stays live at the push service until it is unsubscribed, so "off" is not said until
      // it says so. `unsubscribe()` answers false for a subscription that was already
      // inactive; alerts are off then too, and a fresh lookup finding nothing proves it.
      try { await post('/v1/admin/push/unsubscribe', { endpoint: sub.endpoint }); } catch (e) { /* told next time */ }
      var r = false;
      try { r = await sub.unsubscribe(); } catch (e) { r = false; }
      gone = r === true;
      if (!gone) { try { gone = !(await subscription()); } catch (e) { gone = false; } }
    }
    show(gone ? 'off' : 'offFailed');
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
