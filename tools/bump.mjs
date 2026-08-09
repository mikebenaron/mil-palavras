/* Bump the release version everywhere it appears, in one step.
 *
 *   node tools/bump.mjs          # next version
 *   node tools/bump.mjs 31       # a specific one
 *
 * Four places have to agree, and getting them out of step causes real bugs:
 *
 *   sw.js       CACHE_VERSION      which cache the shell lives in
 *   index.html  APP_BUILD          what Definições reports
 *   index.html  ?v= on <script>    forces fresh scripts for a fresh document
 *   sw.js       APP_SHELL ?v=      so the precache stores those same URLs
 *
 * index.html is served network-first while its scripts are cache-first, so
 * without matching ?v= a new document can run against the previous release's
 * scripts. That once made a signed-in user see "you need to sign in", because
 * the new page called a function the old sync.js didn't have.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const swPath = path.join(ROOT, "sw.js");
const htmlPath = path.join(ROOT, "index.html");

let sw = await fs.readFile(swPath, "utf8");
let html = await fs.readFile(htmlPath, "utf8");

const current = Number(/mil-palavras-v(\d+)/.exec(sw)?.[1]);
if (!current) { console.error("Could not read CACHE_VERSION from sw.js"); process.exit(1); }

const next = Number(process.argv[2]) || current + 1;
if (!Number.isInteger(next) || next < 1) { console.error("Bad version"); process.exit(1); }

sw = sw.replaceAll(`mil-palavras-v${current}`, `mil-palavras-v${next}`);
sw = sw.replaceAll(`?v=${current}`, `?v=${next}`);
html = html.replace(/var APP_BUILD = "v\d+"/, `var APP_BUILD = "v${next}"`);
html = html.replaceAll(`?v=${current}`, `?v=${next}`);

await fs.writeFile(swPath, sw);
await fs.writeFile(htmlPath, html);

// Prove the four agree, rather than trusting the replace.
const swNow = await fs.readFile(swPath, "utf8");
const htmlNow = await fs.readFile(htmlPath, "utf8");
const checks = {
  CACHE_VERSION: new RegExp(`mil-palavras-v${next}'`).test(swNow),
  APP_BUILD: new RegExp(`APP_BUILD = "v${next}"`).test(htmlNow),
  "index.html ?v=": (htmlNow.match(new RegExp(`\\?v=${next}`, "g")) || []).length,
  "sw.js APP_SHELL ?v=": (swNow.match(new RegExp(`\\?v=${next}`, "g")) || []).length,
  stragglers: (htmlNow + swNow).match(new RegExp(`\\?v=(?!${next})\\d+`, "g")) || [],
};
console.log(`v${current} -> v${next}`);
console.log(checks);
if (checks.stragglers.length) { console.error("Some ?v= were left behind."); process.exit(1); }
if (checks["index.html ?v="] !== checks["sw.js APP_SHELL ?v="]) {
  console.error("index.html and APP_SHELL disagree on how many versioned assets there are.");
  process.exit(1);
}
