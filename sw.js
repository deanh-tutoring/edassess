/* EdAssess service worker: shows desktop notifications for class posts, even when the site is closed */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => e.waitUntil((async () => {
  let items = [];
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (sub) {
      const r = await fetch('/.netlify/functions/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pushPending', endpoint: sub.endpoint }) });
      items = ((await r.json()) || {}).items || [];
    }
  } catch (err) { /* fall through to the generic message */ }
  if (!items.length) items = [{ title: 'EdAssess', body: 'Your teacher posted something new.', url: '/', tag: 'ea-generic' }];
  await Promise.all(items.map((i) => self.registration.showNotification(i.title, {
    body: i.body, tag: i.tag || i.id, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: i.url || '/' },
  })));
})()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if (c.url.startsWith(self.location.origin)) { await c.focus(); try { await c.navigate(url); } catch (x) {} return; } }
    await self.clients.openWindow(url);
  })());
});
