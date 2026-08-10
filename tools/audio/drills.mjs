/* Extract the conjugation and grammar drill texts from index.html.
 *
 * Those cards are GENERATED at runtime rather than stored in a data file, so
 * the only way to learn their text without duplicating the logic (and letting
 * the two drift) is to run the app's own generator. We slice the relevant
 * source out of index.html and evaluate it against a minimal DOM stub — the
 * code in that range is almost entirely function declarations, so nothing
 * really needs a browser.
 *
 * If this ever throws after an index.html refactor, the fix is to widen the
 * slice or add to the stub — never to reimplement the conjugation rules here.
 */

import fs from "node:fs/promises";
import path from "node:path";

export async function drillTexts(ROOT, maxRung) {
  const html = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
  const lines = html.split("\n");
  const start = lines.findIndex((l) => l.startsWith("function esc(s){"));
  const end = lines.findIndex((l) => l.trim() === "CARDS = WORDS.concat(DRILLS);");
  if (start < 0 || end < 0) throw new Error("could not locate the card-building range in index.html");
  const src = lines.slice(start, end + 1).join("\n");

  const m = /window\.__DATA__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(html);
  if (!m) throw new Error("could not find window.__DATA__");
  const DATA = JSON.parse(m[1]);

  const el = {
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    setAttribute(){}, removeAttribute(){}, getAttribute: () => null,
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener(){}, appendChild(){}, remove(){},
    style: {}, children: [], innerHTML: "", isConnected: false,
  };
  const stubs = {
    document: { getElementById: () => el, querySelectorAll: () => [], querySelector: () => null,
      addEventListener(){}, createElement: () => el, body: el, documentElement: el, hidden: false },
    window: { matchMedia: () => ({ matches: false }), addEventListener(){},
      speechSynthesis: null, localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
      scrollTo(){}, innerWidth: 400 },
    location: { hostname: "node", search: "", pathname: "/" },
    fetch: () => Promise.reject(new Error("no network during build")),
    caches: undefined,
  };
  // Node 21+ defines some of these as getter-only globals, and ESM is strict,
  // so a plain assignment throws. Install them as configurable properties and
  // put the originals back afterwards.
  const saved = new Map();
  for (const [k, v] of Object.entries(stubs)) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
  }

  let cards;
  try {
    cards = new Function("DATA", "var WORDS=DATA.cards; var CARDS=WORDS; var S=null;\n" + src + "\nreturn CARDS;")(DATA);
  } finally {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  }

  /* Optional ceiling on how far up the tense ladder to go. The app's own
     TENSES table carries each tense's rung, so read it rather than keeping a
     second copy here that could drift. */
  let rungOf = null;
  if (maxRung) {
    const m = /var TENSES = \[([\s\S]*?)\n\];/.exec(html);
    if (!m) throw new Error("could not read the TENSES table");
    rungOf = Object.fromEntries(
      [...m[1].matchAll(/id:"([a-z]+)",[\s\S]*?lvl:(\d)/g)].map((x) => [x[1], Number(x[2])]));
  }

  const seen = new Set(), out = [];
  for (const c of cards) {
    if (c.c !== "conjugacao" && c.c !== "gramatica") continue;
    if (!c.p) continue;
    if (rungOf && c.c === "conjugacao") {
      const tense = String(c.i).split("|")[2];
      if ((rungOf[tense] || 99) > maxRung) continue;
    }
    const t = String(c.p).replace(/\([^)]*\)/g, "").trim();   // drop "(usually)" notes
    // Bare endings ("-am") and contraction formulas ("de + a") aren't speech.
    if (!t || /^-/.test(t) || t.includes("+")) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.sort();
}
