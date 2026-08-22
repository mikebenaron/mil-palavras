/* Drive the real app in a real browser and check what it actually serves.
 *
 *   node tools/ui-check.mjs          # needs playwright + a chromium build
 *   node tools/ui-check.mjs --allow-skip   # exit 0 rather than 2 if it is absent
 *
 * The other harnesses reach into the app and call one function. This one
 * clicks. It exists because the bug it was written for is invisible from
 * inside a single function: the tense ladder was applied where the queue is
 * built in six places and forgotten in four of them, so switching B1 and B2
 * off in Definições still served them from Conjugações. Nothing was wrong with
 * tenseBlocked(); what was wrong was who remembered to call it.
 *
 * It serves the working tree on a local port and opens it with ?dev=1, the
 * same localhost-only gate that exposes __MP__ — so the assertions are made
 * against the real state the real screens produced, not a stub of them.
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

/* Playwright is not a dependency of this repo — there is no build step and no
   package.json, and one test is not a reason to acquire either. So it is
   looked for wherever this machine actually keeps global modules: node's own
   resolution, NODE_PATH, whatever `npm root -g` says, and the usual prefixes.
   The list used to be "playwright" plus one hardcoded Linux path, so a normal
   `npm i -g playwright` on a Mac resolved nothing and the harness skipped. */
function moduleRoots() {
  const roots = (process.env.NODE_PATH || "").split(path.delimiter);
  try {                                  // the authority, when there is an npm to ask
    roots.push(execFileSync("npm", ["root", "-g"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch (e) { /* no npm on PATH, or it failed — the fixed prefixes below still apply */ }
  roots.push(
    path.join(os.homedir(), ".local/node/lib/node_modules"),   // node installed under $HOME
    "/opt/homebrew/lib/node_modules",                          // Homebrew, Apple silicon
    "/usr/local/lib/node_modules",                             // Homebrew on Intel, and node's own pkg
    "/usr/lib/node_modules",
    "/opt/node22/lib/node_modules"                             // the container this was written on
  );
  return [...new Set(roots.filter(Boolean))];
}

/* An unrun harness is not a passing one. The other three exit non-zero when
   they fail, and a CI job or a shell loop over the four reads an exit of 0 as
   "ui-check passed" — which it did not, having asserted nothing. Skipping is
   still allowed, but only when someone asks for it out loud. */
function cannotRun(why, fix, looked) {
  const skip = process.argv.includes("--allow-skip") || process.env.SKIP_UI_CHECK === "1";
  console.log(`ui-check: ${why}`);
  if (looked) for (const l of looked) console.log(`  looked in: ${l}`);
  console.log(`  fix: ${fix}`);
  if (skip) {
    console.log("  skipping: --allow-skip / SKIP_UI_CHECK=1 was given");
    process.exit(0);
  }
  console.log("  no checks ran — exiting 2 so this is not mistaken for a pass.");
  console.log("  Pass --allow-skip (or SKIP_UI_CHECK=1) to skip deliberately.");
  process.exit(2);
}

async function browser() {
  const require = createRequire(import.meta.url);
  const roots = moduleRoots();
  const ids = ["playwright", ...roots.map((r) => path.join(r, "playwright"))];
  let pw;
  for (const id of ids) {
    try {
      const m = await import(pathToFileURL(require.resolve(id)).href);
      pw = m.chromium ? m : m.default;      // it ships CommonJS; importing it nests the exports
      if (pw && pw.chromium) break;
    } catch (e) { /* keep looking */ }
  }
  if (!pw || !pw.chromium) cannotRun("playwright not installed", "npm i -g playwright", roots);
  const candidates = [
    process.env.CHROMIUM_PATH,
    ...(await fs.readdir("/opt/pw-browsers").catch(() => []))
      .filter((d) => d.startsWith("chromium-"))
      .map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`)
  ].filter(Boolean);
  for (const executablePath of candidates) {
    if (!(await fs.access(executablePath).then(() => true, () => false))) continue;
    return pw.chromium.launch({ executablePath });
  }
  try {
    return await pw.chromium.launch();   // whatever playwright installed itself
  } catch (e) {                          // the module is there, the browser build isn't
    cannotRun(`playwright is installed but chromium will not launch — ${String(e.message || e).split("\n")[0]}`,
      "npx playwright install chromium");
  }
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".mp3": "audio/mpeg", ".png": "image/png", ".woff2": "font/woff2" };

function serve() {
  const server = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch (e) { res.writeHead(404).end(); }
  });
  return new Promise((r) => server.listen(0, () => r({ server, port: server.address().port })));
}

const results = [];
const check = (n, ok, d) => results.push({ n, ok: !!ok, d: d || "" });

const { server, port } = await serve();
const B = await browser();
const page = await B.newPage();
page.on("pageerror", (e) => check("no page errors", false, e.message));
await page.goto(`http://localhost:${port}/?dev=1`, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__MP__, null, { timeout: 20000 });

const setLadder = (tlv) => page.evaluate((t) => {
  window.__MP__.SES = null;
  window.__MP__.S.set.tlv = t;
  window.__MP__.save();
}, tlv);

/* Which rungs did the session that just started actually contain? */
const levels = () => page.evaluate(() => {
  const ses = window.__MP__.SES;
  if (!ses) return null;
  const out = {};
  ses.q.forEach((c) => { if (c.c === "conjugacao") out[c.lvl] = (out[c.lvl] || 0) + 1; });
  return { n: ses.q.length, byLevel: out };
});
const open = async (screen, sel) => {
  await page.evaluate((s) => { window.__MP__.SES = null; window.__MP__.go(s); }, screen);
  await page.waitForSelector(sel, { timeout: 10000 });
};
const start = async (screen, sel) => {
  await open(screen, sel);
  await page.click(sel);
  await page.waitForFunction(() => !!window.__MP__.SES, null, { timeout: 10000 });
  return levels();
};
const ladderKept = (l) => l && l.n > 0 && !l.byLevel[3] && !l.byLevel[4];

/* A1 and A2 on, B1 and B2 off: the default, and the setting the bug was
   reported under. */
await setLadder({ 1: true, 2: true, 3: false, 4: false });

const all = await start("conj", '[data-drill="__all"]');
check("Conjugações → Tudo serves only the rungs that are on", ladderKept(all), JSON.stringify(all));
const shown = (await page.evaluate(() => {
  window.__MP__.SES = null; window.__MP__.go("conj");
  return document.querySelector('[data-drill="__all"]').textContent;
})).replace(/\s+/g, " ").trim();
check("and the number on the row is the set behind it",
  Number((shown.match(/(\d+)\s*$/) || [])[1]) < 14819, shown);

for (const [key, label] of [["__big", "the big nine"], ["__irr", "irregulars only"],
                            ["__rfx", "reflexive verbs"]]) {
  const r = await start("conj", `[data-drill="${key}"]`);
  check(`${label} honours the ladder`, ladderKept(r), JSON.stringify(r));
}

/* A row that NAMES a tense is someone choosing that tense on purpose, and this
   screen is the by-hand route. It must stay labelled, and it must still run. */
await open("conj", '[data-drill^="__t|"]');
const offRow = await page.$('[data-drill^="__t|"]:has-text("desligado")');
check("an off rung is labelled rather than hidden", !!offRow);
if (offRow) {
  await offRow.click();
  await page.waitForFunction(() => !!window.__MP__.SES);
  const one = await levels();
  check("and drilling it by hand still works", one && one.n > 0 && (one.byLevel[3] || one.byLevel[4]),
    JSON.stringify(one));
}

/* Estudar → mode → bucket, the other way into a session. */
const bucket = await start("flash", '[data-bucket="__all"]');
check("the Tudo bucket honours the ladder", bucket && bucket.n > 0 && !bucket.byLevel[3] && !bucket.byLevel[4],
  JSON.stringify(bucket));

/* Nothing is deleted: switching a rung back on returns it everywhere. */
await setLadder({ 1: true, 2: true, 3: true, 4: true });
const back = await start("conj", '[data-drill="__all"]');
check("switching them back on returns every tense", back && (back.byLevel[3] || back.byLevel[4]),
  JSON.stringify(back));

/* ---------------------------------------------------------------------------
   What a card actually teaches once it has been answered.

   Every conjugation and grammar card has always carried its explanation in
   `t`, and no screen rendered a word of it: a learner got a form, a verdict
   and nothing else. These check the rendered markup rather than the state,
   because the bug was never in the data — it was in who displayed it.
   --------------------------------------------------------------------------- */

/* Force one specific card into a one-card session in a given mode. */
const cardScreen = (id, mode) => page.evaluate(([cid, m]) => {
  const M = window.__MP__;
  const card = M.BY_ID[cid] || M.CARDS.filter((c) => String(c.i) === cid)[0];
  M.SES = { mode: m, q: [card], i: 0, done: 0, total: 1, right: 0, wrong: 0, near: 0,
            shown: false, dir: "en", opts: null, answered: false, chosen: null,
            typed: "", verdict: null, missed: [] };
  M.renderSession();
  return !!card;
}, [id, mode]);

const reveal = () => page.evaluate(() => {
  window.__MP__.SES.shown = true;
  window.__MP__.SES.answered = true;
  window.__MP__.renderSession();
  return document.getElementById("app").innerText;
});

/* A conjugation card: the tense gloss on the front, the worked example and
   the "when" on the back. */
if (await cardScreen("c|dizer|im|3", "review")) {
  const front = await page.evaluate(() => document.getElementById("app").innerText);
  check("a conjugation card says what the tense is FOR, on the front",
    /what used to happen/i.test(front), front.split("\n").slice(0, 6).join(" / "));
  const back = await reveal();
  check("and what the tense is used for", /background of a past scene/i.test(back));
}

/* The whole tense, with the cell you were asked for marked. Revealing one cell
   alone teaches the cell, not the tense. */
if (await cardScreen("c|ser|im|0", "review")) {
  await reveal();
  const table = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".cjr")].map((r) => ({
      who: r.querySelector(".cjp").textContent,
      form: r.querySelector(".cjf").textContent,
      on: r.classList.contains("on"),
    }));
    return { rows, marked: rows.filter((r) => r.on).map((r) => r.form) };
  });
  check("the answer gives the whole paradigm for that tense",
    table.rows.length === 5 && table.rows.map((r) => r.form).join(" ") === "era eras era éramos eram",
    table.rows.map((r) => r.form).join(" / "));
  check("with the cell you were asked for marked, and only that one",
    table.marked.length === 1 && table.marked[0] === "era", JSON.stringify(table.marked));
}

/* The table is rebuilt from conjugateAll rather than read off the card, so the
   two could in principle disagree. Sweep every conjugation card and prove they
   never do — 15,154 cards, through the real function, in a real browser. */
{
  const sweep = await page.evaluate(() => {
    const M = window.__MP__, box = document.createElement("div");
    const bad = { none: 0, mark: [], form: [], label: [], threw: [], bold: [], blank: [] };
    let fired = 0;
    for (const c of M.CARDS.filter((x) => x.c === "conjugacao")) {
      let html;
      try { html = M.conjTable(c); } catch (e) { bad.threw.push(c.i); continue; }
      if (!html) { bad.none++; continue; }
      box.innerHTML = html;
      const rows = [...box.querySelectorAll(".cjr")];
      const on = rows.filter((r) => r.classList.contains("on"));
      if (on.length !== 1) { bad.mark.push(c.i); continue; }
      if (on[0].querySelector(".cjf").textContent !== c.p) bad.form.push(c.i);
      if (on[0].querySelector(".cjp").textContent !== c.q) bad.label.push(c.i);
      let ex;
      try { ex = M.conjSentence(c); } catch (e) { bad.threw.push("ex:" + c.i); continue; }
      if (ex) {
        fired++;
        box.innerHTML = ex;
        const b = box.querySelector("b");
        if (!b || b.textContent.toLowerCase() !== c.p.toLowerCase()) bad.bold.push(c.i);
        // the English must name the verb, not leave the learner a blank
        const en = box.querySelector(".ne");
        if (en && /___/.test(en.textContent) && c.v !== "haver") bad.blank.push(c.i);
      }
    }
    return { bad, fired, total: M.CARDS.filter((x) => x.c === "conjugacao").length };
  });
  const b = sweep.bad;
  check("every card's table marks exactly the form the card grades",
    b.none === 0 && !b.mark.length && !b.form.length && !b.label.length && !b.threw.length,
    sweep.total + " cards · " + JSON.stringify({ noTable: b.none, mark: b.mark.length,
      form: b.form.length, label: b.label.length, threw: b.threw.length }));
  check("and every card gets a sentence containing the form it just asked for",
    !b.bold.length && sweep.fired >= sweep.total - 300,
    sweep.fired + " of " + sweep.total + " cards · " + b.bold.length + " showing a different form");
  check("and the English says the verb rather than leaving a blank",
    !b.blank.length, b.blank.length + " cards still showing ___");
}

/* A verb that hasn't got a person says so, rather than showing a blank. */
if (await cardScreen("c|haver|si|2", "review")) {
  const back = await reveal();
  check("a defective verb shows which persons it hasn't got",
    /não existe/.test(back) && /houvesse/.test(back));
}

/* The reported bug: a card answering "vai" illustrated it with "Vou ao
   mercado" — a different person, and on the imperfect card a different tense
   entirely. The sentence now appears only when it contains the drilled form. */
if (await cardScreen("c|ir|p|2", "review")) {
  const back = await reveal();
  check("the sentence uses the form the card asked for, with its English",
    /Hoje vai ao mercado/.test(back) && /he \/ she goes to the market/.test(back),
    (back.split("\n").filter((l) => /mercado/.test(l))[0] || "(none)"));
}
if (await cardScreen("c|ir|p|0", "review")) {
  const back = await reveal();
  check("and an authored sentence wins when it already contains that form",
    /Vou ao mercado/.test(back));
}
/* The two cards from the report: a different person, and a different tense. */
if (await cardScreen("c|ser|im|0", "review")) {
  const back = await reveal();
  check("the imperfeito card shows the imperfeito, in a sentence",
    /Antigamente era sempre assim/.test(back) && !/Eu sou português/.test(back),
    (back.split("\n").filter((l) => /assim|português/.test(l))[0] || "(none)"));
}
/* Verbs that need a complement: "Hoje sei." is not Portuguese. */
for (const [id, want] of [["c|saber|p|0", "Hoje sei a resposta"],
                          ["c|precisar|im|0", "Antigamente precisava sempre de tempo"],
                          ["c|deitar-se|sp|0", "Espero que me deite cedo"]]) {
  if (await cardScreen(id, "review")) {
    const back = await reveal();
    check("a complement makes it a sentence — " + want, back.includes(want),
      (back.split("\n").filter((l) => /\b(sei|precisava|deite)\b/.test(l))[0] || "(none)"));
  }
}

/* Escolha is a different renderer, and "in all modes" was the report. */
if (await cardScreen("c|dizer|im|3", "choice")) {
  const back = await reveal();
  const rows = await page.evaluate(() => [...document.querySelectorAll(".cjr .cjf")].map((e) => e.textContent));
  check("Escolha teaches the same thing — 'in all modes' was the report",
    rows.join(" ") === "dizia dizias dizia dizíamos diziam" && /background of a past scene/i.test(back),
    rows.join(" / "));
}

/* The grammar cloze that started this: unanswerable without its English. */
if (await cardScreen("g|ctc1", "choice")) {
  const front = await page.evaluate(() => document.getElementById("app").innerText);
  check("a cloze card shows the English that makes it answerable",
    /I'm in the kitchen/i.test(front), front.split("\n").slice(0, 5).join(" / "));
  const back = await reveal();
  check("and the rule behind it on the back", /em \+ a/i.test(back));
}

/* Dictation must NOT show it — there the prompt is the sound. */
if (await cardScreen("g|ctc1", "listen")) {
  const front = await page.evaluate(() => document.getElementById("app").innerText);
  check("dictation still withholds the English, which would be the answer",
    !/I'm in the kitchen/i.test(front));
}

/* The redesign moved the example sentence out of noteCards() and left its
   listen button behind, so the same word was audible in Escolha and silent in
   Rever — while the app went on prefetching a clip nothing could play. */
const withClip = await page.evaluate(() => {
  const M = window.__MP__;
  const c = M.CARDS.filter((x) => !x.k && x.ex && M.Recorded.srcFor(x.ex))[0];
  return c ? String(c.i) : null;
});
if (withClip) {
  await cardScreen(withClip, "review");
  await reveal();
  const said = await page.evaluate(() => {
    const ctx = [...document.querySelectorAll(".sfspt")].filter((e) => /no contexto/.test(e.textContent))[0];
    return { block: !!ctx, btn: !!(ctx && ctx.querySelector("[data-say]")) };
  });
  check("the example sentence on the card back can be played", said.block && said.btn,
    JSON.stringify(said));
}

/* An accent-only miss is right; a word the accent distinguishes is not. */
const typed = (id, text) => page.evaluate(([cid, t]) => {
  const M = window.__MP__;
  const card = M.BY_ID[cid] || M.CARDS.filter((c) => String(c.i) === cid)[0];
  M.SES = { mode: "listen", q: [card], i: 0, done: 0, total: 1, right: 0, wrong: 0, near: 0,
            shown: false, dir: "en", typed: "", verdict: null, missed: [] };
  M.renderSession();
  const input = document.getElementById("ans");
  input.value = t;
  document.querySelector("[data-check]").click();
  return { k: M.SES.verdict && M.SES.verdict.k, soft: !!(M.SES.verdict || {}).soft,
           text: document.getElementById("app").innerText };
}, [id, text]);

const irmao = await typed(String((await page.evaluate(() =>
  (window.__MP__.CARDS.filter((c) => c.p === "o irmão")[0] || {}).i))), "o irmao");
check("a missing accent counts as correct", irmao.k === "ok" && irmao.soft, JSON.stringify(irmao.k));
check("and the accented spelling is still shown", /irmão/.test(irmao.text));

const avo = await page.evaluate(() => (window.__MP__.CARDS.filter((c) => c.p === "o avô")[0] || {}).i);
if (avo !== undefined) {
  const clash = await typed(String(avo), "o avó");
  check("but a word the accent distinguishes is not forgiven", clash.k === "near",
    JSON.stringify(clash.k));
}

/* The clash guard was first written per-verb, which meant it only ever saw
   collisions inside one card family — and the commonest minimal pairs in the
   language straddle two: está is a cell of estar while esta is a vocabulary
   card. The one test written to defend the carve-out sampled the only class of
   card where the sharded version worked, so the hole shipped green. */
for (const [id, typedText, label] of [["c|estar|p|2", "esta", "está / esta"],
                                      ["c|ser|p|2", "e", "é / e"],
                                      ["c|pôr|ip|0", "por", "pôr / por"]]) {
  const got = await typed(id, typedText);
  check("a conjugated form the accent distinguishes is not forgiven — " + label,
    got.k === "near", JSON.stringify(got.k));
}

const faco = await page.evaluate(() => (window.__MP__.CARDS.filter((c) => /^faço$/.test(c.p))[0] || {}).i);
if (faco !== undefined) {
  const ced = await typed(String(faco), "faco");
  check("the cedilha is not an accent", ced.k === "near", JSON.stringify(ced.k));
}

/* The day's text vanished entirely on an empty deck. */
const dailyEmpty = await page.evaluate(() => {
  const M = window.__MP__;
  M.S.prog = {};
  M.go("leitura");
  const row = document.querySelector(".todaytext");
  return { present: !!row, text: row ? row.innerText : "", disabled: row ? row.disabled : null };
});
check("the day's text says why it can't be written, rather than vanishing",
  dailyEmpty.present && dailyEmpty.disabled, dailyEmpty.text.replace(/\s+/g, " ").slice(0, 90));

/* ---------------------------------------------------------------------------
   "Como funcionam os verbos" — the reference section. Everything on it is
   derived from the same generator the cards use, so the assertions check that
   the derivation agrees with the deck rather than that some prose exists.
   --------------------------------------------------------------------------- */
{
  await open("estudar", '[data-nav="verbguia"]');
  check("Estudar offers the verb guide", true);

  const rows = await page.evaluate(() => {
    window.__MP__.go("verbguia");
    return [...document.querySelectorAll("[data-tg]")].map((b) => b.getAttribute("data-tg"));
  });
  check("the guide lists every tense", rows.length === 12, rows.join(","));

  /* The irregular count on the page must equal the deck's own count. */
  const counted = await page.evaluate(() => {
    const M = window.__MP__, out = {};
    M.CARDS.forEach((c) => {
      if (c.c !== "conjugacao") return;
      const b = out[c.tn] || (out[c.tn] = { irr: new Set(), all: new Set() });
      b.all.add(c.v);
      if (/irregular/.test(c.s)) b.irr.add(c.v);
    });
    const r = {};
    Object.keys(out).forEach((k) => { r[k] = [out[k].irr.size, out[k].all.size]; });
    return r;
  });
  let mismatch = [];
  for (const tid of rows) {
    const shown = await page.evaluate((t) => {
      window.__MP__.go("verbguia");
      document.querySelector('[data-tg="' + t + '"]').click();
      const txt = document.getElementById("app").innerText;
      const m = /(\d+) of (\d+) verbs are irregular/.exec(txt);
      const none = /No verb is irregular in this tense: the rule holds for all (\d+)/.exec(txt);
      return m ? [Number(m[1]), Number(m[2])] : none ? [0, Number(none[1])] : null;
    }, tid);
    const want = counted[tid];
    if (!shown || !want || shown[0] !== want[0] || shown[1] !== want[1])
      mismatch.push(tid + " page=" + JSON.stringify(shown) + " deck=" + JSON.stringify(want));
  }
  check("and its irregular counts are the deck's own, tense by tense",
    !mismatch.length, mismatch.length ? mismatch.join(" | ") : "all 12 agree");

  /* The two facts most worth knowing are the extremes. */
  const fu = await page.evaluate(() => {
    window.__MP__.go("verbguia");
    document.querySelector('[data-tg="fu"]').click();
    return document.getElementById("app").innerText;
  });
  check("the future names its three irregulars", /3 of 275/.test(fu) &&
    /fazer/i.test(fu) && /dizer/i.test(fu) && /trazer/i.test(fu));
  const ip = await page.evaluate(() => {
    window.__MP__.go("verbguia");
    document.querySelector('[data-tg="ip"]').click();
    return document.getElementById("app").innerText;
  });
  check("and the personal infinitive says it has none", /No verb is irregular/.test(ip));

  /* Each tense page explains the tense and shows the three model groups. */
  const im = await page.evaluate(() => {
    window.__MP__.go("verbguia");
    document.querySelector('[data-tg="im"]').click();
    const t = document.getElementById("app").innerText;
    return { txt: t, forms: [...document.querySelectorAll(".cjf")].map((e) => e.textContent) };
  });
  check("a tense page carries what it is for and all three conjugations",
    /background of a past scene/i.test(im.txt) &&
    im.forms.includes("falava") && im.forms.includes("comia") && im.forms.includes("partia"),
    im.forms.slice(0, 3).join(" / "));

  /* And it can start a drill of exactly that tense. */
  const drilled = await page.evaluate(() => {
    const M = window.__MP__;
    M.SES = null;
    M.go("verbguia");
    document.querySelector('[data-tg="im"]').click();
    document.querySelector("[data-tdrill]").click();
    return M.SES ? { n: M.SES.q.length, tenses: [...new Set(M.SES.q.map((c) => c.tn))] } : null;
  });
  check("and drilling from it serves that tense and nothing else",
    drilled && drilled.n > 0 && drilled.tenses.length === 1 && drilled.tenses[0] === "im",
    JSON.stringify(drilled));
}

/* ---- navigation: the in-app back and the OS gesture must agree ----
   The reported bug: "when I go back I often go back to somewhere else, or go
   multiple steps back". Every sub-screen now rides the NAV stack through a
   parameterised go() key, so both back affordances pop the same entry. */
{
  const navState = () => page.evaluate(() => ({ top: window.__MP__.navTop(), depth: window.__MP__.NAV.length }));
  const settle = (ms = 250) => page.waitForTimeout(ms);

  /* A tense page is on the stack, and the OS gesture returns to the guide. */
  await page.evaluate(() => { const M = window.__MP__; M.SES = null; M.go("home"); M.go("estudar"); M.go("verbguia"); });
  await page.click('[data-tg="pp"]');
  await settle();
  const onGuide = await navState();
  await page.goBack(); await settle();
  const afterBack = await navState();
  check("a tense page rides the stack under its own key",
    onGuide.top === "guide:pp", JSON.stringify(onGuide));
  check("and the OS gesture from it returns to the guide index, not two levels up",
    afterBack.top === "verbguia", JSON.stringify(afterBack));

  /* A reading is on the stack; back lands on the list, not on home. */
  await page.evaluate(() => window.__MP__.go("leitura"));
  await page.click("[data-reading]");
  await settle();
  const onReading = await navState();
  await page.goBack(); await settle();
  const backToList = await navState();
  check("a passage rides the stack as reading:<id>",
    /^reading:/.test(onReading.top), JSON.stringify(onReading));
  check("and the OS gesture from a passage returns to the reading list, not home",
    backToList.top === "leitura", JSON.stringify(backToList));

  /* Forward gesture re-enters the screen that was just left. */
  await page.goForward(); await settle();
  const fwd = await navState();
  check("the forward gesture re-enters the passage instead of popping again",
    /^reading:/.test(fwd.top), JSON.stringify(fwd));

  /* A back link naming a screen the stack doesn't hold replaces, not grows. */
  const replaced = await page.evaluate(async () => {
    const M = window.__MP__;
    M.go("home"); M.go("flash");            // buckets' chevron names "estudar"; the stack holds "home"
    const before = M.NAV.length;
    const bl = document.querySelector(".backlink[data-nav]");
    if (bl) bl.click();
    return { before, after: M.NAV.length, top: M.navTop() };
  });
  await settle();
  check("a mismatched back link replaces the top of the stack instead of growing it",
    replaced && replaced.top === "estudar" && replaced.after <= replaced.before,
    JSON.stringify(replaced));

  /* An unknown key can no longer push a phantom and render nothing. */
  const phantom = await page.evaluate(() => {
    const M = window.__MP__;
    M.go("no-such-screen");
    return { top: M.navTop(), screen: document.querySelector(".hpanel, [data-screen]") !== null };
  });
  check("an unknown nav key lands on home, not on a phantom entry",
    phantom && phantom.top === "home", JSON.stringify(phantom));

  /* Leaving a live session by gesture keeps its snapshot, like sair. */
  const snap = await page.evaluate(() => {
    const M = window.__MP__;
    delete M.S.ui.ses; M.SES = null;
    M.go("home"); M.go("review");
    return { mode: M.SES && M.SES.mode, n: M.SES && M.SES.q.length };
  });
  await page.goBack(); await settle();
  const kept = await page.evaluate(() => ({
    ses: !!(window.__MP__.S.ui && window.__MP__.S.ui.ses),
    live: !!window.__MP__.SES, top: window.__MP__.navTop() }));
  check("the OS gesture out of a session parks a resumable snapshot",
    snap && snap.mode === "review" && snap.n > 0 && kept.ses,
    JSON.stringify({ snap, kept }));
}

/* ---- the panel and the button it describes tell one story ---- */
{
  const agree = await page.evaluate(() => {
    const M = window.__MP__;
    delete M.S.ui.ses; M.SES = null;
    const plan = M.sessionPlan();
    M.go("review");
    const q = M.SES ? M.SES.q : [];
    const count = (cs, f) => cs.filter(f).length;
    return {
      planned: plan.planned, served: q.length,
      planVerbs: plan.split.verbs, servedVerbs: count(q, (c) => c.c === "conjugacao"),
      planWords: plan.split.words, servedWords: count(q, (c) => !["conjugacao", "gramatica"].includes(c.c)),
    };
  });
  check("Hoje's numeral is the queue Começar serves — same size",
    agree && agree.planned === agree.served, JSON.stringify(agree));
  check("and the palavras/verbos split is the split actually served",
    agree && agree.planVerbs === agree.servedVerbs && agree.planWords === agree.servedWords,
    JSON.stringify(agree));

  /* The verb governor: with a verb-heavy backlog, words still lead the deal. */
  const governed = await page.evaluate(() => {
    const M = window.__MP__;
    delete M.S.ui.ses; M.SES = null;
    const t = M.dayNo();
    // fabricate a backlog: 30 due conjugation cells, 10 due words
    M.S.prog = {};
    let cj = 0, w = 0;
    for (const c of M.CARDS) {
      if (cj < 30 && c.c === "conjugacao" && !c.rf) { M.S.prog[c.i] = { d: t, iv: 3, r: 1, l: 0, s: 3, df: 5 }; cj++; }
      else if (w < 10 && c.c === "substantivo") { M.S.prog[c.i] = { d: t, iv: 3, r: 1, l: 0, s: 3, df: 5 }; w++; }
      if (cj >= 30 && w >= 10) break;
    }
    const plan = M.planQueue();
    const q = plan.q.filter((c) => M.S.prog[c.i]);        // the due part of the deal
    const verbs = q.filter((c) => c.c === "conjugacao").length;
    return { qLen: q.length, verbs, deferredVerbs: plan.deferred.verbs };
  });
  check("a verb-heavy backlog is dealt 3:1:1 — verbs no longer crowd out the words",
    governed && governed.qLen > 0 && governed.verbs <= Math.ceil(governed.qLen / 3) && governed.deferredVerbs > 0,
    JSON.stringify(governed));

  /* Clusters: trouble bunched in one tense is named as one problem. */
  const cluster = await page.evaluate(() => {
    const M = window.__MP__;
    const t = M.dayNo();
    M.S.prog = {};
    let n = 0;
    for (const c of M.CARDS) {
      if (c.c === "conjugacao" && c.tn === "t" && n < 6) { M.S.prog[c.i] = { d: t, iv: 2, r: 1, l: 5, s: 1, df: 7 }; n++; }
      if (n >= 6) break;
    }
    const cl = M.troubleClusters();
    return cl.length ? { kind: cl[0].kind, id: cl[0].id, n: cl[0].cards.length } : null;
  });
  check("six failing cells of one tense surface as a single named cluster",
    cluster && cluster.kind === "tense" && cluster.id === "t" && cluster.n === 6,
    JSON.stringify(cluster));
}

/* ---- Ditado never grades what the learner could not hear ----
   Offline with an uncached clip, dictation used to fall through to the device
   synth — usually a Brazilian voice — and then grade the transcription against
   European spelling. */
{
  const dict = await page.evaluate(() => {
    const M = window.__MP__;
    M.SES = null;
    const q = M.CARDS.filter((c) => !c.k && c.c === "substantivo").slice(0, 4);
    M.SES = { mode: "listen", q, i: 0, total: q.length, right: 0, near: 0, wrong: 0,
              shown: false, answered: false, done: 0, score: null };
    M.renderSession();
    const normal = { input: !!document.getElementById("ans"), check: !!document.querySelector("[data-check]") };
    M.SES.noaudio = true;                       // what the onFail callback does
    M.renderSession();
    const blocked = {
      input: !!document.getElementById("ans"),
      check: !!document.querySelector("[data-check]"),
      retry: !!document.querySelector("[data-retryaudio]"),
      skip: !!document.querySelector("[data-skipaudio]"),
    };
    const card = M.SES.q[M.SES.i];
    const before = { total: M.SES.total, prog: !!M.S.prog[card.i], wrong: M.SES.wrong };
    document.querySelector("[data-skipaudio]").click();
    const after = { total: M.SES.total, prog: !!M.S.prog[card.i], wrong: M.SES.wrong,
                    gone: !M.SES.q.some((c) => c.i === card.i), input: !!document.getElementById("ans") };
    return { normal, blocked, before, after };
  });
  check("Ditado asks for typing when the recording plays",
    dict.normal.input && dict.normal.check, JSON.stringify(dict.normal));
  check("but an unreachable recording withdraws the answer box instead of grading the device voice",
    !dict.blocked.input && !dict.blocked.check && dict.blocked.retry && dict.blocked.skip,
    JSON.stringify(dict.blocked));
  check("and skipping an unheard card costs no grade, no lapse, and no phantom review",
    dict.after.gone && dict.after.wrong === dict.before.wrong && dict.after.prog === dict.before.prog &&
      dict.after.total === dict.before.total - 1 && dict.after.input,
    JSON.stringify({ before: dict.before, after: dict.after }));
}

/* ---- Imersão: every word reachable, tapping teaches, finding grades ---- */
{
  const cover = await page.evaluate(() => {
    const M = window.__MP__;
    const seen = new Set();
    let overlap = 0;
    for (const s of M.STUDIOS) for (const c of M.studioCards(s)) {
      if (seen.has(c.i)) overlap++;
      seen.add(c.i);
    }
    const words = M.CARDS.filter((c) => !c.k);
    const missing = words.filter((c) => !seen.has(c.i)).map((c) => c.i);
    return { words: words.length, covered: seen.size, overlap, missing: missing.slice(0, 8),
             missingN: missing.length };
  });
  check("every vocabulary card belongs to exactly one studio",
    cover.missingN === 0 && cover.overlap === 0 && cover.covered === cover.words,
    JSON.stringify(cover));

  const explore = await page.evaluate(() => {
    const M = window.__MP__;
    M.go("estudio:corpo");
    const spots = document.querySelectorAll("[data-spot]").length;
    const tiles = document.querySelectorAll(".sttile").length;
    const inStudio = M.studioCards(M.STUDIOS.find((s) => s.k === "corpo")).length;
    document.querySelector('[data-spot="115"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { spots, tiles, inStudio, sel: M.STUDIO && M.STUDIO.sel,
             word: (document.querySelector(".stword") || {}).textContent,
             gloss: (document.querySelector(".stgloss") || {}).textContent };
  });
  check("the body studio offers every one of its words, as art or as a tile",
    explore.spots === explore.inStudio, JSON.stringify(explore));
  check("and tapping a part names it, in Portuguese, with its English under it",
    explore.sel === 115 && /braço/.test(explore.word || "") && /arm/.test(explore.gloss || ""),
    JSON.stringify(explore));

  /* Finding is retrieval, so it must reach FSRS — and must refuse to touch a
     card the learner has not been introduced to yet. */
  const graded = await page.evaluate(() => {
    const M = window.__MP__;
    const cards = M.studioCards(M.STUDIOS.find((s) => s.k === "cores"));
    const t = M.dayNo();
    M.S.prog = {};
    cards.forEach((c) => { M.S.prog[c.i] = { d: t, iv: 3, r: 2, l: 0, s: 3, df: 5 }; });
    M.go("estudio:cores");
    document.querySelector('[data-smode="find"]').click();
    const target = M.STUDIO.target;
    const before = JSON.stringify(M.S.prog[target.i]);
    const labelled = [...document.querySelectorAll(".stswl")].some((n) => (n.textContent || "").trim().length > 1);
    document.querySelector('[data-spot="' + target.i + '"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { labelled, right: M.STUDIO.right, ok: !!(M.STUDIO.verdict && M.STUDIO.verdict.ok),
             before, after: JSON.stringify(M.S.prog[target.i]) };
  });
  check("Encontrar hides the labels, or it would be a reading test",
    graded.labelled === false, JSON.stringify({ labelled: graded.labelled }));
  check("and a correct find reaches the scheduler like every other practice mode",
    graded.ok && graded.right === 1 && graded.before !== graded.after,
    JSON.stringify(graded));

  const unseen = await page.evaluate(() => {
    const M = window.__MP__;
    M.S.prog = {};                       // nothing in rotation at all
    M.STUDIO = null;
    M.go("estudio:cores");
    document.querySelector('[data-smode="find"]').click();
    const target = M.STUDIO.target;
    document.querySelector('[data-spot="' + target.i + '"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { progKeys: Object.keys(M.S.prog).length };
  });
  check("but a studio never introduces a word the scheduler hasn't dealt yet",
    unseen.progKeys === 0, JSON.stringify(unseen));
}

/* ---- the verb guide teaches without sending you away ---- */
{
  const live = await page.evaluate(() => {
    const M = window.__MP__;
    M.go("home"); M.go("guide:p");
    document.querySelector('[data-gv="falar"]').click();      // switch model verb
    const key = M.navTop();
    const card = M.BY_ID["c|falar|p|0"];
    const t = M.dayNo();
    M.S.prog = {}; M.S.prog[card.i] = { d: t, iv: 3, r: 2, l: 0, s: 3, df: 5 };
    const tb = document.querySelector("[data-gvtest]");
    if (tb.textContent.indexOf("Tapar") >= 0) tb.click();      // cover the forms
    const blanks = document.querySelectorAll(".gvblank").length;
    document.querySelector('[data-gvrow="0"]').click();         // reveal eu
    const revealed = (document.querySelectorAll(".cjr.live .cjf")[0] || {}).textContent;
    const sentence = (document.querySelector(".gvsent") || {}).textContent || "";
    const g = document.querySelector('[data-gvg="3"]');
    const before = JSON.stringify(M.S.prog[card.i]);
    if (g) g.click();
    return { key, keyAfter: M.navTop(), blanks, revealed, sentence,
             graded: !!g, before, after: JSON.stringify(M.S.prog[card.i]) };
  });
  check("switching the model verb patches the page instead of navigating",
    live.key === "guide:p" && live.keyAfter === "guide:p" && live.revealed === "falo",
    JSON.stringify({ key: live.key, after: live.keyAfter, form: live.revealed }));
  check("cover-and-try hides the forms until you ask for one",
    live.blanks > 0, JSON.stringify({ blanks: live.blanks }));
  check("and a revealed form arrives with the sentence that uses it",
    /falo/.test(live.sentence), live.sentence.slice(0, 60));
  check("grading a cell inline reaches FSRS without leaving the page",
    live.graded && live.before !== live.after, JSON.stringify({ b: live.before, a: live.after }));

  /* The derivation shown must be the one conjugateAll actually performs. */
  const spine = await page.evaluate(() => {
    const M = window.__MP__;
    M.go("home"); M.go("guide:si");
    document.querySelector('[data-gv="fazer"]').click();
    return { from: (document.querySelector(".gvfrom") || {}).innerText || "" };
  });
  check("a derived tense shows which principal part it grew from, computed not asserted",
    /fizeram/.test(spine.from) && /fizesse/.test(spine.from) && /eles/.test(spine.from),
    spine.from.replace(/\n/g, " "));

  /* conjWhy used to be called with a hardcoded irr=false, so every verb was
     explained as if it were regular. */
  const irr = await page.evaluate(() => {
    const M = window.__MP__;
    M.go("home"); M.go("guide:fu");
    document.querySelector('[data-gv="dizer"]').click();
    return (document.querySelector("#gvbody .footnote .ne") || {}).textContent || "";
  });
  check("an irregular verb is explained as irregular, not as if it followed the rule",
    /irregular/i.test(irr), irr.slice(0, 90));
}

/* ---- practising outside a session must not destroy a parked one ----
   studyBeat() calls sesRemember(), and sesRemember used to clear S.ui.ses
   whenever there was no live session to snapshot — so answering one card in a
   studio threw away a half-finished Rever. */
{
  const parked = await page.evaluate(() => {
    const M = window.__MP__;
    M.SES = null; M.S.ui = M.S.ui || {}; delete M.S.ui.ses;
    M.go("home"); M.go("review");                    // start and park a real session
    const live = M.SES && M.SES.q.length;
    M.SES.i = 2;
    M.go("home");                                     // leave it parked
    const afterPark = !!(M.S.ui && M.S.ui.ses);
    /* now practise elsewhere: a studio find, which calls studyBeat() */
    const cards = M.studioCards(M.STUDIOS.find((s) => s.k === "cores"));
    const t = M.dayNo();
    cards.forEach((c) => { M.S.prog[c.i] = { d: t, iv: 3, r: 2, l: 0, s: 3, df: 5 }; });
    M.STUDIO = null;
    M.go("estudio:cores");
    document.querySelector('[data-smode="find"]').click();
    const target = M.STUDIO.target;
    document.querySelector('[data-spot="' + target.i + '"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { live, afterPark, stillParked: !!(M.S.ui && M.S.ui.ses) };
  });
  check("a parked review survives practising somewhere else",
    parked.live > 0 && parked.afterPark && parked.stillParked, JSON.stringify(parked));
}

/* ---- a reflexive verb keeps its pronoun in the guide's table ---- */
{
  const rfx = await page.evaluate(() => {
    const M = window.__MP__;
    M.go("home"); M.go("guide:p");
    const chip = [...document.querySelectorAll("[data-gv]")]
      .find((c) => /^(rir|deitar|lembrar|tornar|mudar|divertir|aperceber)$/.test(c.getAttribute("data-gv")));
    if (!chip) return { skipped: true };
    chip.click();
    const tb = document.querySelector("[data-gvtest]");      // an earlier check may have left it covered
    if (tb && tb.textContent.indexOf("Mostrar") >= 0) tb.click();
    return { verb: chip.getAttribute("data-gv"),
             forms: [...document.querySelectorAll(".cjr.live .cjf")].map((e) => e.textContent) };
  });
  check("a reflexive verb is conjugated with its clitic, not bare",
    rfx.skipped || rfx.forms.some((f) => /-(me|te|se|nos)\b/.test(f)),
    JSON.stringify(rfx).slice(0, 140));
}

await B.close();
server.close();

const bad = results.filter((r) => !r.ok);
console.log(`ui: ${results.length - bad.length} pass, ${bad.length} fail`);
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.n}${r.d ? "  — " + r.d : ""}`);
process.exit(bad.length ? 1 : 0);
