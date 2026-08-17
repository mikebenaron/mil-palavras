/* Exercise the real sync layer against a fake Supabase and a fake app.
 *
 *   node tools/sync-check.mjs
 *   node tools/sync-check.mjs /tmp/old-sync.js     # run a suspect build through it
 *
 * Signing out replaced the device's only copy of the progress with an empty
 * state, and signing back in replaced that with whatever the server had. Both
 * halves were destructive, both were unconditional, and nothing in the repo
 * could run them — so "I signed out and lost seven days" had no test to fail.
 *
 * Two things are checked here. mergeState(), lifted straight out of
 * index.html, is unit-checked on its own: it is the reason a pull can no
 * longer subtract, so its rules are worth pinning down one at a time. Then
 * sync.js is loaded into a sandbox and driven by hand through the situations
 * that lose data — a bad connection, a sign-out, two devices at once — the
 * same trick tools/conj-check.mjs uses on the conjugator.
 *
 * Each scenario gets a fresh sandbox, because sync.js is an IIFE holding
 * module state (session, synced, the debounce timer) that must not leak.
 */
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
/* An explicit path is allowed so a suspect build can be run through the same
   cases — `node tools/sync-check.mjs /tmp/old-sync.js` is how these were
   confirmed to fail before the fix. */
const FILE = process.argv[2] || path.join(ROOT, "sync.js");
const SRC = await fs.readFile(FILE, "utf8");

/* The app owns the shape of the state, so it owns the merge. Take the real
   one rather than a copy here that could drift away from it. */
const html = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
const htmlLines = html.split("\n");
const mStart = htmlLines.findIndex(l => l.includes("===== mergeState"));
const mEnd = htmlLines.findIndex(l => l.includes("===== end mergeState"));
if (mStart < 0 || mEnd < 0) { console.error("Couldn't find mergeState in index.html"); process.exit(1); }
const mergeState = new Function(htmlLines.slice(mStart, mEnd + 1).join("\n") + "\nreturn mergeState;")();

const U1 = "user-one", U2 = "user-two";
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || "" });
const cards = s => Object.keys((s && s.prog) || {}).length;
/* The server keeps { data, updated_at }, like the real progress table. */
const row = state => ({ data: state, updated_at: new Date(state._updatedAt || 0).toISOString() });
const srv = (rows, uid) => rows[uid] && rows[uid].data;

/* A state holding the named cards, stamped at ts. */
function stateOf(ids, ts, uid, extra) {
  const prog = {};
  ids.forEach(id => { prog[id] = { r: 1, e: 2.5, iv: 3, d: 100, l: 0 }; });
  const s = Object.assign({
    v: 1, prog, reviews: ids.length, streak: ids.length ? 1 : 0,
    set: { perDay: 15 }, _updatedAt: ts
  }, extra || {});
  if (uid) s._uid = uid;
  return s;
}

/* ============================ mergeState alone ============================ */

{
  const a = stateOf(["a", "b", "c"], 1000);
  const b = stateOf(["c", "d", "e"], 2000);
  check("merge unions both decks", cards(mergeState(a, b)) === 5);
}
{
  // The same card, reviewed on each device. The more recent review describes
  // the memory as it is now; blending the two would describe neither.
  const a = stateOf(["x"], 1000); a.prog.x = { r: 9, e: 2.5, iv: 60, d: 200, l: 0, lr: 140 };
  const b = stateOf(["x"], 2000); b.prog.x = { r: 1, e: 2.5, iv: 1, d: 151, l: 3, lr: 150 };
  const m = mergeState(a, b);
  check("the more recently reviewed record wins", m.prog.x.lr === 150, "lr " + m.prog.x.lr);
  check("and it keeps the higher lapse count", m.prog.x.l === 3, "l " + m.prog.x.l);
}
{
  // No lr at all: cards untouched since before FSRS shipped. d - iv is when
  // they were last seen, and a lapse must not read as the staler record.
  const a = stateOf(["x"], 2000); a.prog.x = { r: 5, e: 2.5, iv: 30, d: 130, l: 0 }; // seen day 100
  const b = stateOf(["x"], 1000); b.prog.x = { r: 0, e: 2.5, iv: 0, d: 120, l: 1 };  // lapsed day 120
  const m = mergeState(a, b);
  check("a lapse doesn't look stale just because it's due sooner", m.prog.x.d === 120,
    "d " + m.prog.x.d);
}
{
  const a = stateOf(["a"], 1000, null, { reviews: 400, best: 12, seenDays: 30, studiedDay: 50, streak: 4 });
  const b = stateOf(["b"], 2000, null, { reviews: 380, best: 9, seenDays: 28, studiedDay: 49, streak: 9 });
  const m = mergeState(a, b);
  check("totals take the larger", m.reviews === 400 && m.seenDays === 30, m.reviews + "/" + m.seenDays);
  check("the streak comes from whichever studied last", m.streak === 4, "streak " + m.streak);
  check("best is never lowered", m.best === 12, "best " + m.best);
}
{
  const a = stateOf(["a"], 1000, null, { lastDay: 60, newToday: 12 });
  const b = stateOf(["b"], 2000, null, { lastDay: 60, newToday: 9 });
  check("merging one day's two copies doesn't hand out extra new words",
    mergeState(a, b).newToday === 12);
}
{
  const a = stateOf(["a", "b"], 3000, null, { set: { perDay: 40, dir: "pt" } });
  const b = stateOf(["c"], 1000, null, { set: { perDay: 5, dir: "mix" } });
  const m = mergeState(a, b);
  check("settings come whole from the newer copy, never half-and-half",
    m.set.perDay === 40 && m.set.dir === "pt", JSON.stringify(m.set));
}
{
  // "Apagar tudo" is the one act allowed to remove progress.
  const wiped = stateOf([], 5000, U1, { wipedAt: 5000 });
  const old = stateOf(["a", "b", "c"], 4000, U1);
  check("a deliberate wipe isn't undone by the next sync", cards(mergeState(wiped, old)) === 0);
  const after = stateOf(["a"], 6000, U1);      // studied again after the wipe
  check("but a wipe doesn't erase what came after it", cards(mergeState(wiped, after)) === 1);
}
{
  const a = stateOf(["a"], 1000, null, { rlog: [["x", 3, 10, 0, 1], ["y", 2, 11, 0, 1]] });
  const b = stateOf(["a"], 2000, null, { rlog: [["y", 2, 11, 0, 1], ["z", 1, 12, 0, 1]] });
  check("the review log merges without duplicating shared history",
    mergeState(a, b).rlog.length === 3);
}
{
  const a = stateOf(["a"], 1000, null, { read: { r1: 40, r2: 44 } });
  const b = stateOf(["a"], 2000, null, { read: { r1: 42, r3: 45 } });
  const m = mergeState(a, b);
  check("a passage keeps the day it was first read", m.read.r1 === 40 && m.read.r3 === 45,
    JSON.stringify(m.read));
}
{
  const big = stateOf(["a", "b"], 1000, U1);
  check("merging with nothing is not a way to lose everything",
    cards(mergeState(big, null)) === 2 && cards(mergeState(null, big)) === 2);
}

/* ============================== the sandbox =============================== */

function boot(opts) {
  opts = opts || {};
  const rows = opts.rows || {};                 // user_id -> state, i.e. the server
  const net = { read: true, write: true };      // flip to simulate a bad connection
  const listeners = { doc: {}, win: {} };
  let authCb = null, session = null;

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
    hidden: false, head: el(), body: el(),
    getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
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
            ? Promise.resolve({ error: null, data: rows[uid] ? {
                data: JSON.parse(JSON.stringify(rows[uid].data)),
                updated_at: rows[uid].updated_at } : null })
            : Promise.resolve({ data: null, error: new Error("offline") }))
        })
      }),
      /* Thenable and chainable, like the real builder — and the write runs
         once however it is awaited. */
      upsert: r => {
        let done = null;
        const run = () => (done = done || (opts.noStamp && "updated_at" in r
          ? { data: null, error: { message: "column \"updated_at\" of relation \"progress\" does not exist" } }
          : net.write
          ? (rows[r.user_id] = { data: JSON.parse(JSON.stringify(r.data)), updated_at: r.updated_at },
             { data: { updated_at: r.updated_at }, error: null })
          : { data: null, error: new Error("offline") }));
        return {
          select: () => ({ maybeSingle: () => Promise.resolve(run()) }),
          then: (f, g) => Promise.resolve(run()).then(f, g)
        };
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
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Date, Math, Object, String, Number, RegExp, Error, alert() {}
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: path.basename(FILE) });

  const app = { S: opts.local || null };
  const fresh = () => ({ v: 1, prog: {}, newToday: 0, streak: 0, reviews: 0, set: { perDay: 15 } });
  let rendered = 0;
  sandbox.window.MilSync.attach({
    get: () => app.S,
    set: ns => { app.S = ns; },
    persist: () => {},
    save: () => {},
    merge: mergeState,
    render: () => { rendered++; },
    refresh: () => { rendered++; },
    freshState: fresh,
    busy: () => false
  });

  return {
    rows, net, app, sandbox, listeners,
    renders: () => rendered,
    snaps: () => JSON.parse(sandbox.window.localStorage.getItem("milpalavras.snaps") || "[]"),
    // Launch: registers the auth listener, then shows the login screen.
    start: async () => { sandbox.window.MilSync.gate(); await settle(); rendered = 0; },
    signIn: async (uid) => {
      session = { user: { id: uid, email: uid + "@example.test" } };
      authCb && authCb("SIGNED_IN", session);
      await settle();
    },
    signOut: async () => { await client.auth.signOut(); await settle(); },
    /* What the app does on every answered card. Timestamps step by hand
       rather than off the clock, so two devices inside the same millisecond
       can't make a result depend on how fast the test ran. */
    study: async (ids) => {
      ids.forEach(id => { app.S.prog[id] = { r: 1, e: 2.5, iv: 1, d: 100, l: 0, lr: 99 }; });
      app.S.reviews = (app.S.reviews || 0) + ids.length;
      app.S._updatedAt = (app.S._updatedAt || 0) + 1000;
      sandbox.window.MilSync.push(app.S);
      await settle();
    },
    hide: async () => {
      document.hidden = true;
      (listeners.doc.visibilitychange || []).forEach(f => f());
      await settle();
      document.hidden = false;
    },
    online: async () => { (listeners.win.online || []).forEach(f => f()); await settle(); },
    pagehide: async () => { (listeners.win.pagehide || []).forEach(f => f()); await settle(); }
  };
}

/* ================================ scenarios =============================== */

/* 1. The reported bug. The phone is ahead of the server because the last few
      pushes never landed. Sign out, sign back in, and the days it had are
      still there — not because the server had them, but because the device
      keeps its own copy and the two get merged. */
{
  const t = boot({ rows: { [U1]: row(stateOf(["a", "b"], 1000, U1)) },
                   local: stateOf(["a", "b", "c", "d", "e"], 9000, U1) });
  await t.start();
  t.net.write = false;                 // pushes have been failing all along
  await t.signOut();
  check("sign-out keeps a local copy", t.snaps().length === 1, t.snaps().length + " snapshots");
  check("sign-out still clears the screen", cards(t.app.S) === 0, cards(t.app.S) + " cards");
  t.net.write = true;
  await t.signIn(U1);
  check("signing back in has everything again", cards(t.app.S) === 5, cards(t.app.S) + " cards");
  check("and the server is brought up to date", cards(srv(t.rows, U1)) === 5, cards(srv(t.rows, U1)) + " cards");
}

/* 2. Sign-in on a bad connection. The app knows nothing about this account,
      so it must not write anything to it. This is what turned a scare into
      permanent loss: an empty state pushed over a full one. */
{
  const t = boot({ rows: { [U1]: row(stateOf(["a", "b", "c"], 9000, U1)) },
                   local: { v: 1, prog: {}, newToday: 0, streak: 0, reviews: 0, set: { perDay: 15 } } });
  await t.start();
  t.net.read = false;
  await t.signIn(U1);
  check("a failed pull doesn't enter the app on an empty deck", t.renders() === 0);
  await t.study(["x"]);
  await t.hide();
  check("nothing is pushed before the server has been read", cards(srv(t.rows, U1)) === 3,
    cards(srv(t.rows, U1)) + " cards on the server");
  t.net.read = true;
  await t.signIn(U1);
  check("once online, the account and the offline work are both there",
    cards(t.app.S) === 4, cards(t.app.S) + " cards");
}

/* 3. Offline with progress already on the device is the ordinary case: enter
      the app and sync later. Only an empty deck is worth stopping for. */
{
  const t = boot({ rows: {}, local: stateOf(["a", "b"], 9000, U1) });
  await t.start();
  t.net.read = false;
  await t.signIn(U1);
  check("offline with local progress still enters the app", t.renders() === 1);
}

/* 4. The 1.2s debounce against a phone being closed. */
{
  const t = boot({ rows: { [U1]: row(stateOf(["a"], 1000, U1)) }, local: stateOf(["a"], 1000, U1) });
  await t.start();
  await t.signIn(U1);
  await t.study(["b", "c"]);
  check("a push is still pending", cards(srv(t.rows, U1)) === 1, cards(srv(t.rows, U1)) + " cards");
  await t.hide();
  check("going to the background flushes it", cards(srv(t.rows, U1)) === 3, cards(srv(t.rows, U1)) + " cards");
}

/* 5. A failed push is not a lost push: it is retried until the server says it
      has it, and reconnecting is one of the moments it tries again. */
{
  const t = boot({ rows: { [U1]: row(stateOf(["a"], 1000, U1)) }, local: stateOf(["a"], 1000, U1) });
  await t.start();
  await t.signIn(U1);
  t.net.write = false;
  await t.study(["b", "c"]);
  await t.hide();
  check("a push that failed leaves the server behind", cards(srv(t.rows, U1)) === 1);
  t.net.write = true;
  await t.online();
  check("reconnecting sends it without being asked", cards(srv(t.rows, U1)) === 3,
    cards(srv(t.rows, U1)) + " cards");
}

/* 6. Two devices, both used while offline, neither aware of the other. This
      is the case last-write-wins could never survive: whichever synced second
      erased the first one's work. */
{
  const rows = { [U1]: row(stateOf(["a"], 1000, U1)) };
  const phone = boot({ rows, local: stateOf(["a"], 1000, U1) });
  const laptop = boot({ rows, local: stateOf(["a"], 1000, U1) });
  await phone.start(); await laptop.start();
  await phone.signIn(U1); await laptop.signIn(U1);

  phone.net.write = false; laptop.net.write = false;
  await phone.study(["p1", "p2"]);
  await laptop.study(["l1", "l2", "l3"]);

  phone.net.write = true; await phone.hide();
  laptop.net.write = true; await laptop.hide();
  check("the second device to sync doesn't erase the first one's work",
    cards(srv(rows, U1)) === 6, cards(srv(rows, U1)) + " cards on the server");

  await phone.signIn(U1);          // the next foreground pull
  check("and the first device gets the other's work back",
    cards(phone.app.S) === 6, cards(phone.app.S) + " cards");
}

/* 7. A shared device. Someone else's deck must not be merged into yours. */
{
  const rows = { [U2]: row(stateOf(["x"], 5000, U2)) };
  const t = boot({ rows, local: stateOf(["a", "b", "c"], 4000, U1) });
  await t.start();
  await t.signIn(U2);
  check("another account's progress isn't merged into yours",
    cards(t.app.S) === 1, cards(t.app.S) + " cards");
  check("but it is kept, so the first user hasn't lost it",
    t.snaps().some(s => s.uid === U1 && cards(s.state) === 3));
}

/* 8. A table whose row has no updated_at column. The write-guard is built on
      that stamp, but the progress matters more than the guard: the push must
      still land, because one that silently never lands is how the server ends
      up days behind the phone. */
{
  const rows = { [U1]: row(stateOf(["a"], 1000, U1)) };
  const t = boot({ rows, local: stateOf(["a"], 1000, U1), noStamp: true });
  await t.start();
  await t.signIn(U1);
  await t.study(["b", "c"]);
  await t.hide();
  check("a write still lands on a table with no updated_at column",
    cards(srv(rows, U1)) === 3, cards(srv(rows, U1)) + " cards");
}

/* 9. A wipe on one device must reach the other, and stay wiped. */
{
  const rows = { [U1]: row(stateOf(["a", "b", "c"], 1000, U1)) };
  const t = boot({ rows, local: stateOf(["a", "b", "c"], 1000, U1) });
  await t.start();
  await t.signIn(U1);
  t.app.S = { v: 1, prog: {}, newToday: 0, streak: 0, reviews: 0, set: { perDay: 15 },
              _uid: U1, _updatedAt: 9000, wipedAt: 9000 };
  await t.study([]);                       // "Apagar tudo", then save()
  await t.hide();
  check("erasing everything on purpose does reach the server", cards(srv(rows, U1)) === 0,
    cards(srv(rows, U1)) + " cards");
  await t.signIn(U1);
  check("and the next sync doesn't hand it all back", cards(t.app.S) === 0,
    cards(t.app.S) + " cards");
}

/* ---------------------------------- report -------------------------------- */

const bad = results.filter(r => !r.ok);
console.log(`sync (${path.relative(ROOT, FILE) || FILE}): ${results.length - bad.length} pass, ${bad.length} fail`);
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? "  — " + r.detail : ""}`);
/* Exit rather than fall off the end: a scenario that leaves a push retrying
   has a backoff timer pending, and node would sit waiting on it. */
process.exit(bad.length ? 1 : 0);
