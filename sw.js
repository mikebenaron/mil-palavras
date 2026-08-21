/* Mil Palavras service worker — offline app shell.
   Bump CACHE_VERSION whenever the app files change to force an update. */
const CACHE_VERSION = 'mil-palavras-v85';
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
  './vendor/supabase.js?v=85',
  './sync-config.js?v=85',
  './sync.js?v=85',
  './content.js?v=85',
  './families.js?v=85',
  './readings.js?v=85',
  // Versioned like the rest: cache.addAll() fetches through the browser's own
  // HTTP cache, so an unversioned manifest could be precached stale — and a
  // stale manifest means the app believes audio it has doesn't exist.
  './audio/manifest.json?v=85',
  './fonts.css?v=85'
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

  /* Never touch anything that isn't ours.

     This handler re-fetches by URL, deliberately, so that the cache is keyed
     without Safari's Range header. Rebuilding a request from its URL drops
     every header it had — which is harmless for our own static files and
     fatal for an API call: Supabase answers a GET carrying no `apikey` with
     "No API key found in request".

     So every pull the app has ever made failed, silently, and the app fell
     back to the local copy — which is fine right up until the moment signing
     out has just cleared it. Auth and the Edge Functions are POSTs and never
     reached this line, which is why signing in worked while reading your own
     progress did not. */
  if (new URL(req.url).origin !== self.location.origin) return;

  // Never intercept the worker script itself. Caching it meant the in-app
  // update check read a stale version and concluded the app was current —
  // the update mechanism defeating itself.
  if (/\/sw\.js(\?|$)/.test(new URL(req.url).pathname + new URL(req.url).search)) return;

  const isNavigation = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  // Only ever cache a response that actually succeeded. Caching a 404 or a 500
  // would serve that failure forever — a transient error while fetching
  // readings.js could otherwise brick the app until the next version bump.
  const cacheable = (res) => res && res.ok && res.status === 200 &&
    (res.type === 'basic' || res.type === 'cors');

  if (isNavigation) {
    // cache: 'reload' bypasses the browser's own HTTP cache. Without it this
    // "network-first" fetch could still be served a stale index.html by Safari
    // for as long as GitHub Pages' max-age, leaving the app several versions
    // behind with no way for the user to force it forward.
    const fresh = new Request(req.url, {
      cache: 'reload', credentials: 'same-origin', redirect: 'follow'
    });
    event.respondWith(
      fetch(fresh)
        .then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.open(CACHE_VERSION)
          .then((c) => c.match('./index.html').then((r) => r || c.match('./'))))
    );
    return;
  }

  // Clips go to the durable audio cache, whether played one at a time or
  // pulled down in bulk by "download all audio".
  const isClip = /\/audio\/.+\.mp3$/.test(new URL(req.url).pathname);
  const store = isClip ? AUDIO_CACHE : CACHE_VERSION;

  /* Safari asks for media with a Range header and expects 206 Partial
     Content. A cached Response replayed as a plain 200 makes it stall, retry,
     and eventually crawl — which is exactly why recorded clips were slow while
     the device voice, which never touches the network, was instant.
     Serve the requested byte range properly instead. */
  async function rangeFrom(cached, header) {
    const buf = await cached.arrayBuffer();
    const size = buf.byteLength;
    const m = /bytes=(\d*)-(\d*)/.exec(header || "");
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= size) end = size - 1;
    if (start > end) start = 0;
    const chunk = buf.slice(start, end + 1);
    return new Response(chunk, {
      status: 206,
      statusText: "Partial Content",
      headers: {
        "Content-Type": cached.headers.get("Content-Type") || "audio/mpeg",
        "Content-Length": String(chunk.byteLength),
        "Content-Range": "bytes " + start + "-" + end + "/" + size,
        "Accept-Ranges": "bytes",
      },
    });
  }

  /* Look in the ONE cache that could hold this, not across all of them.
     caches.match() is a global search: with thousands of clips in the audio
     cache it can stall for seconds on iOS, and every single playback paid
     that cost before the sound could start. */
  const range = req.headers.get("range");
  // Always key the cache on the plain URL. iOS asks for media with a Range
  // header on EVERY request, so keying on the request itself would mean media
  // is never cached and every playback hits the network.
  const key = new Request(req.url, { credentials: "same-origin" });

  event.respondWith(
    caches.open(store)
      .then((cache) => cache.match(key).then((cached) => {
        if (cached) return range ? rangeFrom(cached, range) : cached;
        // Miss: fetch the WHOLE file (never the range), cache it, then serve
        // the slice the browser asked for.
        return fetch(key).then((res) => {
          if (!cacheable(res)) return range ? fetch(req) : res;
          const copy = res.clone();
          return cache.put(key, copy)
            .then(() => (range ? cache.match(key).then((c) => rangeFrom(c, range)) : res))
            .catch(() => res);
        });
      }))
      .catch(() => fetch(req))
  );
});
