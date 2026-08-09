/* Why does the story audio sound scratchy?
 *
 * Two suspects, and this separates them:
 *
 *  1. FORMAT. Everything so far is audio-24khz-48kbitrate-mono-mp3. A 24kHz
 *     sample rate cuts everything above ~12kHz, which is exactly where the
 *     /ʃ/ sibilants live — and European Portuguese is full of them
 *     ("os livros" = "ush LEE-vrush"). Band-limited + 48kbps is a bad match
 *     for this language specifically.
 *
 *  2. TIME-STRETCH. The Normal speed setting plays at 0.85x. Pitch-preserving
 *     time-stretch on already-compressed audio adds warble.
 *
 * Generates the same three passage lines in four formats, so the two can be
 * judged apart at 1.0x and at 0.85x.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(HERE, "quality");

try {
  const raw = await fs.readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const KEY = process.env.AZURE_SPEECH_KEY, REGION = process.env.AZURE_SPEECH_REGION;
if (!KEY || !REGION) { console.error("Missing Azure key/region in .env"); process.exit(1); }

const VOICE = "pt-PT-DuarteNeural";

const FORMATS = [
  { id: "a-24k-48",  fmt: "audio-24khz-48kbitrate-mono-mp3",  label: "24kHz 48kbps — what we generated" },
  { id: "b-24k-96",  fmt: "audio-24khz-96kbitrate-mono-mp3",  label: "24kHz 96kbps — same band, better bitrate" },
  { id: "c-48k-96",  fmt: "audio-48khz-96kbitrate-mono-mp3",  label: "48kHz 96kbps — full band for sibilants" },
  { id: "d-48k-192", fmt: "audio-48khz-192kbitrate-mono-mp3", label: "48kHz 192kbps — best Azure offers" },
];

// Sibilant-heavy lines, where band-limiting shows up worst.
const LINES = [
  { id: "l1", text: "Há um novo festival de música em Oeiras, perto de Lisboa." },
  { id: "l2", text: "Os moradores e os visitantes podem ouvir concertos ao vivo." },
  { id: "l3", text: "Quem não arrisca não petisca, diz o ditado português." },
];

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

await fs.mkdir(OUT, { recursive: true });
let n = 0, bytes = {};

for (const f of FORMATS) {
  bytes[f.id] = 0;
  for (const l of LINES) {
    const file = path.join(OUT, `${f.id}__${l.id}.mp3`);
    const ssml = `<speak version='1.0' xml:lang='pt-PT'><voice xml:lang='pt-PT' name='${VOICE}'>${escapeXml(l.text)}</voice></speak>`;
    const res = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": KEY,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": f.fmt,
        "User-Agent": "mil-palavras",
      },
      body: ssml,
    });
    if (!res.ok) { console.error(`${f.id}/${l.id}: ${res.status} ${(await res.text()).slice(0, 120)}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(file, buf);
    bytes[f.id] += buf.length;
    n++;
    process.stdout.write(".");
  }
}

await fs.writeFile(path.join(OUT, "manifest.json"),
  JSON.stringify({ formats: FORMATS, lines: LINES, bytes }, null, 2));

console.log(`\n${n} clips`);
for (const f of FORMATS) {
  const perClip = bytes[f.id] / LINES.length;
  // Extrapolate the whole library: 990 words (~1.5s) + 517 lines (~3.5s).
  const est = (perClip / 3.5) * (990 * 1.5 + 517 * 3.5) / 1024 / 1024;
  console.log(`  ${f.id.padEnd(10)} ${(perClip / 1024).toFixed(0).padStart(4)} KB/line   whole library ≈ ${est.toFixed(0)} MB   ${f.label}`);
}
console.log("\nOpen: http://localhost:8765/tools/audio/quality.html");
