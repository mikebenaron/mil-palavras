/* Mil Palavras service worker — offline app shell.
   Bump CACHE_VERSION whenever the app files change to force an update. */
const CACHE_VERSION = 'mil-palavras-v23';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './vendor/supabase.js',
  './sync-config.js',
  './sync.js',
  './content.js',
  './readings.js',
  './audio/manifest.json',
  './fonts.css'
];
// Audio clips are NOT precached — ~20MB is far too much to force on install.
// They are cached individually by the fetch handler as they're played, and a
// clip that isn't cached yet falls back to the device voice when offline.
// Font woff2 files are cached on demand by the fetch handler (cache-first).

// Pre-cache the app shell on install.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Clean up old caches on activate.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Navigation requests: network-first (so updates land when online), fall back to cache offline.
// Everything else (icons, manifest): cache-first.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const isNavigation = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  // Only ever cache a response that actually succeeded. Caching a 404 or a 500
  // would serve that failure forever — a transient error while fetching
  // readings.js could otherwise brick the app until the next version bump.
  const cacheable = (res) => res && res.ok && res.status === 200 &&
    (res.type === 'basic' || res.type === 'cors');

  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (cacheable(res)) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
      }
      return res;
    }))
  );
});
