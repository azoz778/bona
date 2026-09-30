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
 * worker focuses it and ASKS (a `bona:open` message with a reply port); app.js answers
 * `{ ok: true }` and goes there itself when nothing is being typed, `{ ok: false }` when
 * something is. No answer within half a second (a page without our script, a tab asleep),
 * or a refusal, opens a fresh window instead — the draft stays where it is.
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
 * Ask a dashboard window to go to `url` itself. Resolves with the page's answer, or null
 * when it does not answer in time, cannot be messaged, or has no script listening.
 */
const ask = (client, url) => new Promise((resolve) => {
  const ch = new MessageChannel();
  let timer = null;
  const done = (answer) => { if (timer !== null) clearTimeout(timer); ch.port1.close(); resolve(answer); };
  ch.port1.onmessage = (e) => done(e.data);
  timer = setTimeout(() => done(null), ASK_MS);
  try { client.postMessage({ type: 'bona:open', url }, [ch.port2]); } catch { done(null); }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = '/dashboard/push/open';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const ours = windows.find((w) => { const p = new URL(w.url).pathname; return p === '/dashboard' || p.startsWith('/dashboard/'); });
    if (ours) {
      try {
        await ours.focus();
        const answer = await ask(ours, target);
        if (answer && answer.ok === true) return; // the page goes there itself
      } catch { /* a gone window: open a fresh one */ }
    }
    await self.clients.openWindow(target);
  })());
});
