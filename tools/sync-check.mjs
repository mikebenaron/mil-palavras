/* Exercise sync.js against a fake Supabase and a fake app.
 *
 *   node tools/sync-check.mjs
 *
 * Signing out replaces the device's only copy of the progress with an empty
 * state, and signing back in replaces that with whatever the server has. Both
 * halves are destructive, both used to be unconditional, and nothing in the
 * repo could run them — so "I signed out and lost everything" had no test to
 * fail. This loads the real sync.js into a sandbox and drives the auth events
 * by hand, the same trick tools/conj-check.mjs uses for the conjugator.
 *
 * Each scenario gets a fresh sandbox, because sync.js is an IIFE holding
 * module state (session, synced, the debounce timer) that must not leak
 * between cases.
 */
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
/* An explicit path is allowed so a suspect build can be run through the same
   cases — `node tools/sync-check.mjs /tmp/old-sync.js` was how these were
   confirmed to fail before the fix. */
const FILE = process.argv[2] || path.join(ROOT, "sync.js");
const SRC = await fs.readFile(FILE, "utf8");

const U1 = "user-one", U2 = "user-two";
const tick = () => new Promise(r => setImmediate(r));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };

/* A state with n scheduled cards, stamped at ts. */
function stateWith(n, ts, uid) {
  const prog = {};
  for (let i = 0; i < n; i++) prog[i] = { r: 1, e: 2.5, iv: 3, d: 0, l: 0 };
  const s = { v: 1, prog, reviews: n, streak: n ? 1 : 0, set: { perDay: 15 }, _updatedAt: ts };
  if (uid) s._uid = uid;
  return s;
}
const cards = s => Object.keys((s && s.prog) || {}).length;

/* ------------------------------ the sandbox ------------------------------ */

function boot(opts) {
  opts = opts || {};
  const rows = opts.rows || {};                 // user_id -> state, i.e. the server
  const net = { read: true, write: true };      // flip to simulate a bad connection
  const listeners = { doc: {}, win: {} };
  let authCb = null, session = opts.session || null;

  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear()
  };

  const el = () => ({
    innerHTML: "", textContent: "", className: "", value: "",
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    addEventListener() {}, appendChild() {}, select() {}, setSelectionRange() {},
    querySelector: () => el(), querySelectorAll: () => []
  });

  const document = {
    hidden: false,
    head: el(), body: el(),
    getElementById: () => el(),
    querySelector: () => el(),
    querySelectorAll: () => [],
    createElement: () => el(),
    addEventListener: (ev, fn) => { (listeners.doc[ev] = listeners.doc[ev] || []).push(fn); }
  };

  /* The bits of the Supabase client sync.js actually uses. */
  const client = {
    auth: {
      getSession: () => Promise.resolve({ data: { session } }),
      onAuthStateChange: cb => { authCb = cb; },
      signOut: () => { session = null; authCb && authCb("SIGNED_OUT", null); return Promise.resolve({}); },
      signInWithPassword: () => Promise.resolve({ data: {}, error: null }),
      updateUser: () => Promise.resolve({ error: null })
    },
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    from: () => ({
      select: () => ({
        eq: (col, uid) => ({
          // A real response is a copy, never a live handle on the server row.
          maybeSingle: () => (net.read
            ? Promise.resolve({ data: rows[uid] ? { data: JSON.parse(JSON.stringify(rows[uid])) } : null, error: null })
            : Promise.resolve({ data: null, error: new Error("offline") }))
        })
      }),
      upsert: row => {
        if (net.write) rows[row.user_id] = JSON.parse(JSON.stringify(row.data));
        return Promise.resolve({ error: net.write ? null : new Error("offline") });
      },
      delete: () => ({ eq: () => Promise.resolve({ error: null }) })
    })
  };

  const window = {
    supabase: { createClient: () => client },
    MIL_SYNC_CONFIG: { url: "https://example.test", anonKey: "publishable" },
    localStorage,
    addEventListener: (ev, fn) => { (listeners.win[ev] = listeners.win[ev] || []).push(fn); }
  };

  const sandbox = {
    window, document, localStorage, console,
    location: { origin: "https://milpalavras.app", pathname: "/", search: "", hostname: "milpalavras.app" },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Date, Math, Object, String, Number, RegExp, Error, alert() {}
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "sync.js" });

  /* The app side of the bridge: state, and a note of what got rendered. */
  const app = {
    S: opts.local || null,
    entered: 0, unreachable: () => document.hidden === "n/a"   // placeholder, unused
  };
  const fresh = () => ({ v: 1, prog: {}, newToday: 0, streak: 0, reviews: 0, set: { perDay: 15 } });
  let rendered = 0;
  sandbox.window.MilSync.attach({
    get: () => app.S,
    set: ns => { app.S = ns; },
    persist: () => {},
    save: () => {},
    render: () => { rendered++; },
    refresh: () => { rendered++; },
    freshState: fresh,
    busy: () => false
  });

  return {
    rows, net, app, sandbox, listeners,
    MilSync: sandbox.window.MilSync,
    renders: () => rendered,
    // Launch: registers the auth listener, then shows the login screen.
    start: async () => { sandbox.window.MilSync.gate(); await flush(); rendered = 0; },
    signIn: async (uid) => {
      session = { user: { id: uid, email: uid + "@example.test" } };
      authCb && authCb("SIGNED_IN", session);
      await flush();
    },
    signOut: async () => { await client.auth.signOut(); await flush(); },
    // What the app does on every answered card.
    study: async (n) => {
      for (let i = 0; i < n; i++) app.S.prog["s" + i] = { r: 1, e: 2.5, iv: 1, d: 0, l: 0 };
      app.S.reviews = (app.S.reviews || 0) + n;
      app.S._updatedAt = Date.now();
      sandbox.window.MilSync.push(app.S);
      await flush();
    },
    hide: async () => {
      document.hidden = true;
      (listeners.doc.visibilitychange || []).forEach(f => f());
      await flush();
    },
    pagehide: async () => { (listeners.win.pagehide || []).forEach(f => f()); await flush(); }
  };
}

/* -------------------------------- the cases ------------------------------- */

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || "" });

/* 1. The reported bug. The phone has 40 cards; the server is three days
      behind because the last pushes never landed. Sign out, sign back in —
      the 40 must come back, not the 12. */
{
  const t = boot({ rows: { [U1]: stateWith(12, 1000, U1) }, local: stateWith(40, 9000, U1) });
  await t.start();
  t.net.write = false;                 // pushes have been failing all along
  await t.signOut();
  check("sign-out keeps a local copy", !!t.sandbox.window.localStorage.getItem("milpalavras.backup"));
  check("sign-out leaves the app empty", cards(t.app.S) === 0, cards(t.app.S) + " cards");
  t.net.write = true;
  await t.signIn(U1);
  check("signing back in restores the 40 cards", cards(t.app.S) === 40, cards(t.app.S) + " cards");
  check("and puts them back on the server", cards(t.rows[U1]) === 40, cards(t.rows[U1]) + " cards");
}

/* 2. Sign-in on a bad connection. The pull fails, so the app knows nothing
      about this account — and must not write anything to it. This is the one
      that turned a scare into permanent loss. */
{
  const t = boot({ rows: { [U1]: stateWith(40, 9000, U1) }, local: stateWith(0, 0, null) });
  await t.start();
  t.net.read = false;
  await t.signIn(U1);
  check("a failed pull doesn't enter the app on an empty deck", t.renders() === 0);
  await t.study(3);
  await t.hide();
  check("nothing is pushed before the server has been read", cards(t.rows[U1]) === 40,
    cards(t.rows[U1]) + " cards on the server");
  t.net.read = true;
  await t.signIn(U1);
  check("retrying once online recovers the account", cards(t.app.S) === 40, cards(t.app.S) + " cards");
  check("the server row is untouched by the whole episode", cards(t.rows[U1]) === 40);
}

/* 3. Offline with progress already on the device is the ordinary case: enter
      the app, sync later. Only an empty deck is worth stopping for. */
{
  const t = boot({ rows: {}, local: stateWith(40, 9000, U1) });
  await t.start();
  t.net.read = false;
  await t.signIn(U1);
  check("offline with local progress still enters the app", t.renders() === 1);
}

/* 4. The 1.2s debounce vs. a phone being closed. */
{
  const t = boot({ rows: { [U1]: stateWith(5, 1000, U1) }, local: stateWith(5, 1000, U1) });
  await t.start();
  await t.signIn(U1);
  await t.study(7);
  check("a push is still pending", cards(t.rows[U1]) === 5, cards(t.rows[U1]) + " cards");
  await t.hide();
  check("going to the background flushes it", cards(t.rows[U1]) === 12, cards(t.rows[U1]) + " cards");
}

/* 5. A push queued just before a sign-out must not land in whoever signs in
      next — doPush stamps the row with the *current* session's user id. */
{
  const t = boot({ rows: { [U1]: stateWith(5, 1000, U1), [U2]: stateWith(30, 2000, U2) },
                   local: stateWith(5, 1000, U1) });
  await t.start();
  await t.signIn(U1);
  await t.study(7);            // pending push, holding user one's state
  await t.signOut();
  await t.signIn(U2);
  await t.pagehide();
  check("one account's queued push can't land in another's row",
    cards(t.rows[U2]) === 30, cards(t.rows[U2]) + " cards");
  check("and the second account loads its own progress", cards(t.app.S) === 30, cards(t.app.S) + " cards");
}

/* ---------------------------------- report -------------------------------- */

const bad = results.filter(r => !r.ok);
console.log(`sync (${path.relative(ROOT, FILE) || FILE}): ${results.length - bad.length} pass, ${bad.length} fail`);
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? "  — " + r.detail : ""}`);
process.exitCode = bad.length ? 1 : 0;
