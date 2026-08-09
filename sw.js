/* Mil Palavras service worker — offline app shell.
   Bump CACHE_VERSION whenever the app files change to force an update. */
const CACHE_VERSION = 'mil-palavras-v31';
/* Audio lives in its own cache, deliberately NOT tied to CACHE_VERSION.
   The clips never change, they are ~82MB, and a user may have chosen to
   download all of them — wiping that on every app update (a CSS tweak!)
   would be indefensible. Only bump this if the recordings themselves change. */
const AUDIO_CACHE = 'mil-palavras-audio-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  // Versioned to match the query strings in index.html. index.html is served
  // network-first (always fresh) while these are cache-first, so without the
  // ?v= a new document could run against last release's scripts — which is
  // exactly how a signed-in user got told to sign in.
  './vendor/supabase.js?v=31',
  './sync-config.js?v=31',
  './sync.js?v=31',
  './content.js?v=31',
  './readings.js?v=31',
  './audio/manifest.json',
  './fonts.css?v=31'
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
        keys.filter((k) => k !== CACHE_VERSION && k !== AUDIO_CACHE)
            .map((k) => caches.delete(k))
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

  // Clips go to the durable audio cache, whether played one at a time or
  // pulled down in bulk by "download all audio".
  const isClip = /\/audio\/.+\.mp3$/.test(new URL(req.url).pathname);
  const store = isClip ? AUDIO_CACHE : CACHE_VERSION;

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (cacheable(res)) {
        const copy = res.clone();
        caches.open(store).then((cache) => cache.put(req, copy));
      }
      return res;
    }))
  );
});
