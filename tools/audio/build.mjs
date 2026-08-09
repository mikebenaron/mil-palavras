/* Mil Palavras — build the pre-generated European Portuguese audio.
 *
 * Speaks every vocabulary card and every reading-passage line with Azure's
 * pt-PT Duarte at his natural pace. Slower speeds are done client-side with
 * playbackRate (pitch preserved), so there is exactly one file per phrase.
 *
 * Reads AZURE_SPEECH_KEY / AZURE_SPEECH_REGION from the gitignored .env.
 *
 *   node tools/audio/build.mjs            # everything still missing
 *   node tools/audio/build.mjs --words    # vocabulary only
 *   node tools/audio/build.mjs --readings # passages only
 *   node tools/audio/build.mjs --limit 30 # pilot run
 *
 * Safe to stop and re-run: existing files are never re-requested.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const AUDIO = path.join(ROOT, "audio");

try {
  const raw = await fs.readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const KEY = process.env.AZURE_SPEECH_KEY;
const REGION = process.env.AZURE_SPEECH_REGION;
if (!KEY || !REGION) {
  console.error("Missing AZURE_SPEECH_KEY / AZURE_SPEECH_REGION (see .env).");
  process.exit(1);
}

const VOICE = process.env.AZURE_VOICE || "pt-PT-DuarteNeural";
const RATE = Number(process.env.AZURE_RATE || 0);   // 0 = the voice's native pace
const RATE_MS = Number(process.env.TTS_RATE_MS || 250);
const argv = process.argv.slice(2);
const LIMIT = argv.includes("--limit") ? Number(argv[argv.indexOf("--limit") + 1]) : Infinity;
const ONLY_WORDS = argv.includes("--words");
const ONLY_READINGS = argv.includes("--readings");

/* ---- the same text the app would have spoken ---------------------- */
/* Mirrors Speech.sayable() in index.html: alternatives separated by a slash
   are read as a list, ellipses become pauses, bracketed notes are dropped. */
function sayable(t) {
  return String(t)
    .replace(/\s*\/\s*/g, ", ")
    .replace(/…/g, ", ")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---- corpus ------------------------------------------------------- */
const indexHtml = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
const dataMatch = /window\.__DATA__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(indexHtml);
if (!dataMatch) { console.error("Could not find window.__DATA__ in index.html"); process.exit(1); }
const WORDS = JSON.parse(dataMatch[1]).cards;

const readingsJs = await fs.readFile(path.join(ROOT, "readings.js"), "utf8");
const win = {};
new Function("window", readingsJs)(win);
const READINGS = win.MIL_READINGS || [];

const jobs = [];
if (!ONLY_READINGS) {
  for (const c of WORDS) {
    const text = sayable(c.p);
    if (text) jobs.push({ file: path.join(AUDIO, "w", `${c.i}.mp3`), text });
  }
}
if (!ONLY_WORDS) {
  for (const r of READINGS) {
    (r.lines || []).forEach((l, i) => {
      const text = sayable(l.pt);
      if (text) jobs.push({ file: path.join(AUDIO, "r", `${r.id}__${i}.mp3`), text });
    });
  }
}

const chars = jobs.reduce((n, j) => n + j.text.length, 0);
console.log(`${jobs.length} clips · ${chars.toLocaleString()} characters · voice ${VOICE}${RATE ? " @" + RATE + "%" : " (native pace)"}`);

/* ---- synthesis ---------------------------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

async function speak(text) {
  const body = RATE
    ? `<prosody rate='${RATE > 0 ? "+" : ""}${RATE}%'>${escapeXml(text)}</prosody>`
    : escapeXml(text);
  const ssml = `<speak version='1.0' xml:lang='pt-PT'><voice xml:lang='pt-PT' name='${VOICE}'>${body}</voice></speak>`;

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": KEY,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "mil-palavras",
      },
      body: ssml,
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 401 || res.status === 403) {
      throw new Error(`key rejected (${res.status}) — check AZURE_SPEECH_REGION matches the resource`);
    }
    if (attempt >= 6 || (res.status !== 429 && res.status < 500)) {
      throw new Error(`${res.status}: ${(await res.text()).slice(0, 160)}`);
    }
    const after = Number(res.headers.get("retry-after"));
    await sleep(after ? after * 1000 : Math.min(60000, 2000 * 2 ** (attempt - 1)));
    process.stdout.write("~");   // throttled by Azure, backing off
  }
}

await fs.mkdir(path.join(AUDIO, "w"), { recursive: true });
await fs.mkdir(path.join(AUDIO, "r"), { recursive: true });

let made = 0, skipped = 0, failed = 0, n = 0;
const started = Date.now();

for (const job of jobs) {
  if (n >= LIMIT) break;
  try { await fs.access(job.file); skipped++; continue; } catch {}
  n++;
  try {
    await fs.writeFile(job.file, await speak(job.text));
    made++;
    if (made % 25 === 0) {
      const rate = made / ((Date.now() - started) / 60000);
      const left = Math.max(0, Math.min(jobs.length, LIMIT) - skipped - made);
      process.stdout.write(`\n  ${made} made, ${left} to go (~${Math.round(left / Math.max(rate, 0.1))} min) `);
    } else {
      process.stdout.write(".");
    }
    if (RATE_MS) await sleep(RATE_MS);
  } catch (e) {
    failed++;
    console.error(`\n  ${path.basename(job.file)}: ${e.message}`);
    if (/key rejected/.test(e.message)) break;
    if (failed > 25) { console.error("\nToo many failures — stopping."); break; }
  }
}

/* ---- manifest ----------------------------------------------------- */
async function listDir(sub) {
  try { return (await fs.readdir(path.join(AUDIO, sub))).filter((f) => f.endsWith(".mp3")); }
  catch { return []; }
}
const haveW = await listDir("w");
const haveR = await listDir("r");

// The app checks this before requesting a clip, so a missing file never costs
// a failed round-trip — it falls back to speechSynthesis immediately.
await fs.writeFile(path.join(AUDIO, "manifest.json"), JSON.stringify({
  voice: VOICE,
  rate: RATE,
  built: new Date().toISOString().slice(0, 10),
  words: haveW.map((f) => Number(f.replace(".mp3", ""))).sort((a, b) => a - b),
  readings: haveR.map((f) => f.replace(".mp3", "")).sort(),
}));

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\n\nmade ${made} · skipped ${skipped} · failed ${failed} · ${mins} min`);
console.log(`audio/ now holds ${haveW.length} words and ${haveR.length} passage lines`);
