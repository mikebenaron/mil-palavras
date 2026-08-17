/* Run the service worker's fetch handler against fake events.
 *
 *   node tools/sw-check.mjs
 *
 * The worker exists to serve the app offline, and it decides that by URL. Get
 * that wrong in the direction of "handle everything" and it starts standing
 * between the app and its own API — which is what happened: the handler
 * re-fetches by URL to key the audio cache without Safari's Range header, and
 * a request rebuilt from its URL has no headers, so every Supabase read went
 * out with no `apikey` and came back "No API key found in request". Signing in
 * still worked, because auth is a POST and POSTs return at the first line.
 *
 * Nothing here needs a browser: sw.js is loaded in a sandbox with a fake
 * `self`, and the handler is called by hand.
 */
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SRC = await fs.readFile(process.argv[2] || path.join(ROOT, "sw.js"), "utf8");
const ORIGIN = "https://milpalavras.app";

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || "" });

/* Load the worker and hand back its fetch handler. */
function load() {
  const handlers = {};
  const fetched = [];
  const self = {
    location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
    addEventListener: (ev, fn) => { handlers[ev] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() }
  };
  const sandbox = {
    self, console, URL, Request, Response, Promise, JSON, Math, Object, String, Number, RegExp, Error,
    caches: {
      open: () => Promise.resolve({
        match: () => Promise.resolve(null),
        put: () => Promise.resolve(),
        addAll: () => Promise.resolve()
      }),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
      match: () => Promise.resolve(null)
    },
    fetch: (r) => {
      fetched.push(typeof r === "string" ? r : r.url);
      return Promise.resolve({ ok: true, status: 200, type: "basic", clone: () => ({}) });
    }
  };
  sandbox.addEventListener = self.addEventListener;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "sw.js" });
  return { handlers, fetched };
}

/* Did the worker take responsibility for this request? */
function handles(url, method = "GET", headers = {}) {
  const { handlers } = load();
  let claimed = false;
  handlers.fetch({
    request: {
      url, method, mode: "cors",
      headers: { get: (k) => headers[k.toLowerCase()] || null }
    },
    respondWith: () => { claimed = true; }
  });
  return claimed;
}

/* The app's own files are the whole reason the worker exists. */
check("serves the app shell", handles(ORIGIN + "/sync.js?v=78"));
check("serves audio clips", handles(ORIGIN + "/audio/w/12.mp3"));
check("serves the document", handles(ORIGIN + "/", "GET", { accept: "text/html" }));

/* Anything that isn't ours must go straight to the network, headers intact. */
check("keeps out of Supabase REST reads",
  !handles("https://vawoprxbznheyatbignh.supabase.co/rest/v1/progress?select=*&user_id=eq.1"));
check("keeps out of Supabase auth",
  !handles("https://vawoprxbznheyatbignh.supabase.co/auth/v1/user"));
check("keeps out of Edge Functions",
  !handles("https://vawoprxbznheyatbignh.supabase.co/functions/v1/quick-endpoint"));
check("keeps out of Azure speech",
  !handles("https://uksouth.api.cognitive.microsoft.com/sts/v1.0/issuetoken"));

/* A write was never the broken half, but it must stay untouched too. */
check("never intercepts a write", !handles(ORIGIN + "/anything", "POST"));
/* Caching the worker made the update check read a stale version of itself. */
check("never intercepts itself", !handles(ORIGIN + "/sw.js"));

const bad = results.filter((r) => !r.ok);
console.log(`sw: ${results.length - bad.length} pass, ${bad.length} fail`);
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? "  — " + r.detail : ""}`);
process.exit(bad.length ? 1 : 0);
