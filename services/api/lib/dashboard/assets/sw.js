/*
 * The Bona dashboard's service worker (design §5, Phase 3). Scope /dashboard/.
 *
 * It exists only to show phone alerts. It keeps no copy of anything and never intercepts
 * a request: there is no fetch listener, so every page and every answer comes from the
 * server, `no-store`, as before. A push carries no data; every push shows the same notification
 * (iOS withdraws the subscription of a worker that receives a push without showing one),
 * and a tap opens /dashboard/push/open, which sends the signed-in member to their newest
 * unread chat.
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

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = '/dashboard/push/open';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const ours = windows.find((w) => { const p = new URL(w.url).pathname; return p === '/dashboard' || p.startsWith('/dashboard/'); });
    if (ours) {
      try {
        const w = await ours.focus();
        if (w && 'navigate' in w) { await w.navigate(target); return; }
      } catch { /* an uncontrolled or gone window cannot be navigated: open a fresh one */ }
    }
    await self.clients.openWindow(target);
  })());
});
