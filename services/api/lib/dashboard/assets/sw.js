/*
 * The Bona dashboard's service worker (design §5, Phase 3). Scope /dashboard/.
 *
 * It exists only to show phone alerts. It keeps no copy of anything and never intercepts
 * a request: there is no fetch listener, so every page and every answer comes from the
 * server, `no-store`, as before. A push carries no data; every push shows the same notification
 * (iOS withdraws the subscription of a worker that receives a push without showing one),
 * and a tap opens /dashboard/push/open, which sends the signed-in member to their newest
 * unread chat.
 *
 * A tap never moves a dashboard tab on its own: the tab may hold a half-typed reply. The
 * worker focuses it and asks, in two steps over one message channel: `bona:open` (may
 * you go?) — the page answers `{ ok: true }` when nothing is being typed, or `{ ok: false }`
 * after showing its own "new activity" note with the link — then, on a yes, `bona:go`,
 * and only on that does the page navigate (it checks again first). No answer within half
 * a second (a page without our script, a tab asleep) closes the channel — a `go` is never
 * sent, so an answer that arrives late moves nothing — and opens a fresh window instead.
 * A page that said no is left exactly as it is: focused, with its note and its draft.
 */
'use strict';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  // No `badge`: Android draws it as a monochrome blob and iOS ignores it.
  event.waitUntil(self.registration.showNotification('New Bona message', {
    body: 'A client wrote in the Bona inbox.',
    icon: '/dashboard/icon-192.png',
    tag: 'bona-inbox',
    renotify: true,
  }));
});

/** How long a focused dashboard tab has to answer whether it may go to the chat. */
const ASK_MS = 500;

/**
 * Ask a dashboard window whether it may go to `url`, and tell it to when it says yes.
 * Resolves `true` (the page was told to go), `false` (it said no and has shown its note),
 * or `null` (no answer in time, or it could not be messaged). The channel is closed on
 * every exit, before anything else happens: once the wait has run out, an answer that
 * arrives late is never read and no `go` can ever follow it.
 */
const ask = (client, url) => new Promise((resolve) => {
  const ch = new MessageChannel();
  let timer = null;
  let settled = false;
  const done = (outcome) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    ch.port1.close();
    resolve(outcome);
  };
  ch.port1.onmessage = (e) => {
    if (settled) return;
    const answer = e.data;
    if (answer && answer.ok === true) {
      // The page goes only on this — and checks again first that nothing is being typed.
      try { ch.port1.postMessage({ type: 'bona:go', url }); } catch { /* the port closed: the page cannot go */ }
      done(true);
      return;
    }
    done(false);
  };
  timer = setTimeout(() => done(null), ASK_MS);
  try { client.postMessage({ type: 'bona:open', url }, [ch.port2]); } catch { done(null); }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = '/dashboard/push/open';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // A signed-in dashboard window. The login and logout pages carry no app.js: asking one
    // would wait the half second and then open a second login tab beside a signed-in one.
    const ours = windows.find((w) => {
      const p = new URL(w.url).pathname;
      return (p === '/dashboard' || p.startsWith('/dashboard/')) && p !== '/dashboard/login' && !p.startsWith('/dashboard/login/') && p !== '/dashboard/logout';
    });
    if (ours) {
      let outcome = null;
      try {
        await ours.focus();
        outcome = await ask(ours, target);
      } catch { outcome = null; /* a gone window: open a fresh one */ }
      // Told to go, or said no (its note carries the link): the window stays as it is.
      if (outcome !== null) return;
    }
    await self.clients.openWindow(target);
  })());
});
