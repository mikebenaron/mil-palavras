/* Drive the real app in a real browser and check what it actually serves.
 *
 *   node tools/ui-check.mjs          # needs playwright + a chromium build
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
import { createRequire } from "node:module";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

/* Playwright is not a dependency of this repo — there is no build step and no
   package.json, and one test is not a reason to acquire either. Find it if the
   machine has it, and say so plainly if it hasn't. */
async function browser() {
  const require = createRequire(import.meta.url);
  let pw;
  for (const id of ["playwright", "/opt/node22/lib/node_modules/playwright"]) {
    try {
      const m = await import(require.resolve(id));
      pw = m.chromium ? m : m.default;      // it ships CommonJS; importing it nests the exports
      if (pw && pw.chromium) break;
    } catch (e) { /* keep looking */ }
  }
  if (!pw || !pw.chromium) {
    console.log("ui-check: playwright not installed — skipping (npm i -g playwright)");
    process.exit(0);
  }
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
  return pw.chromium.launch();          // whatever playwright installed itself
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
  check("and shows the verb in a real, authored sentence",
    /O que é que queres dizer|dizer numa frase/i.test(back) || /numa frase/i.test(back),
    (back.split("\n").filter((l) => /numa frase/i.test(l))[0] || "(no sentence line)"));
  check("and what the tense is used for",
    /background of a past scene/i.test(back));
}

/* Escolha is a different renderer, and "in all modes" was the report. */
if (await cardScreen("c|dizer|im|3", "choice")) {
  const back = await reveal();
  check("Escolha teaches the same thing",
    /numa frase/i.test(back) && /background of a past scene/i.test(back),
    (back.split("\n").filter((l) => /numa frase/i.test(l))[0] || "(no sentence line)"));
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

await B.close();
server.close();

const bad = results.filter((r) => !r.ok);
console.log(`ui: ${results.length - bad.length} pass, ${bad.length} fail`);
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.n}${r.d ? "  — " + r.d : ""}`);
process.exit(bad.length ? 1 : 0);
