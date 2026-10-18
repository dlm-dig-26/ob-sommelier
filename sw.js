// Bump VERSION on every release; old caches are deleted on activate.
const VERSION = 'ob-20261018g';
// Paths are relative to this file, so the app works at a domain root or a sub-path (GitHub Pages).
const CORE = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.json',
  'data/demo.json', 'icons/icon-192.png', 'vendor.html', 'vendor.js', 'contribute.html', 'contribute.js', 'privacy.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network-first for our own files (users always get the latest release),
// cache fallback when offline. Cross-origin requests (database, CDN, recipes) are not intercepted.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })
      .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
