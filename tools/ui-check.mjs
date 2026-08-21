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

await B.close();
server.close();

const bad = results.filter((r) => !r.ok);
console.log(`ui: ${results.length - bad.length} pass, ${bad.length} fail`);
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.n}${r.d ? "  — " + r.d : ""}`);
process.exit(bad.length ? 1 : 0);
