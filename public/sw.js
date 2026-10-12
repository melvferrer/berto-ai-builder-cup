/* Berto service worker: offline app shell + Web Push reminders. */
const CACHE = 'berto-v15';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/logo.svg', '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/fonts/nunito-sans-latin-wght-normal.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // Instant open: serve the cached app shell right away (stale-while-revalidate),
    // refresh it in the background so the next launch gets any update.
    const update = fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); }
      return res;
    });
    e.respondWith(caches.match('/').then((hit) => {
      if (hit) { e.waitUntil(update.catch(() => {})); return hit; }
      return update.catch(() => caches.match('/'));
    }));
    return;
  }
  // cache-first for hashed assets & icons
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Berto', body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.find((w) => w.visibilityState === 'visible');
    // Tell an open app (it shows an in-app card and speaks); still show the system notification
    // unless the app is visible on screen right now.
    wins.forEach((w) => w.postMessage({ type: 'push', data }));
    if (visible && data.kind === 'reminder') return;
    await self.registration.showNotification(data.title || 'Berto', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'berto',
      renotify: true,
      requireInteraction: data.kind === 'reminder',
      lang: 'fil-PH',
      data,
      actions: data.kind === 'reminder'
        ? [{ action: 'taken', title: 'Nainom na' }, { action: 'snooze', title: 'Mamaya (10 min)' }]
        : [],
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  const n = e.notification;
  const data = n.data || {};
  n.close();
  e.waitUntil((async () => {
    if (e.action === 'snooze' && data.kind === 'reminder') {
      await fetch('/api/snooze', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: data.deviceId, medId: data.medId, time: data.time, minutes: 10 }),
      }).catch(() => {});
      return;
    }
    const params = new URLSearchParams();
    if (data.kind === 'reminder') {
      params.set('r', data.medId); params.set('t', data.time); params.set('d', data.date || '');
      if (e.action === 'taken') params.set('a', 'taken');
    }
    const target = '/' + (params.toString() ? `?${params}` : '');
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) {
        w.postMessage({ type: 'notification-click', action: e.action || 'open', data });
        return w.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
