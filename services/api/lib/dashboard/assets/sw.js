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
  event.waitUntil(self.registration.showNotification('New Bona message', {
    body: 'A client wrote in the Bona inbox.',
    icon: '/dashboard/icon-192.png',
    badge: '/dashboard/icon-192.png',
    tag: 'bona-inbox',
    renotify: true,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = '/dashboard/push/open';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if (new URL(w.url).pathname.startsWith('/dashboard/') && 'focus' in w) {
        await w.focus();
        if ('navigate' in w) return w.navigate(target);
        return undefined;
      }
    }
    return self.clients.openWindow(target);
  })());
});
