// Service worker: keeps a copy of the app on the device so it opens without Internet.
// Data (attendance) is handled separately by the app itself using IndexedDB.
const CACHE = 'chichi-app-v1';

async function cacheAppShell() {
  const cache = await caches.open(CACHE);
  const res = await fetch('/index.html', { cache: 'no-store' });
  const html = await res.clone().text();
  await cache.put('/index.html', res);
  // Also store the script and style files that index.html refers to
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  await cache.addAll([...new Set([...assets, '/manifest.webmanifest', '/icon.svg'])]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheAppShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Pages: try the network first (to get updates), fall back to the saved copy when offline
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put('/index.html', res.clone()));
        return res;
      }).catch(() => caches.match('/index.html')),
    );
    return;
  }
  // Files (scripts, styles, icons): use the saved copy, otherwise download and save it
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});
