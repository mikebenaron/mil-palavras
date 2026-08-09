/* Mil Palavras — European Portuguese voice comparison.
 *
 * Generates the same test phrases through every provider you have a key for,
 * so they can be compared blind before committing to one. Keys are read from
 * the environment and never written to disk or into the repo.
 *
 *   ELEVENLABS_API_KEY   + optional ELEVEN_VOICE_IDS="id1,id2"
 *   AZURE_SPEECH_KEY     + AZURE_SPEECH_REGION (e.g. westeurope)
 *   GOOGLE_TTS_API_KEY
 *
 * Usage:
 *   node tools/voice-test/generate.mjs                 # every configured provider
 *   node tools/voice-test/generate.mjs --list-voices   # show voices, generate nothing
 *
 * Output: tools/voice-test/out/<provider>__<voice>/<phrase-id>.mp3  (gitignored)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const PHRASES = JSON.parse(await fs.readFile(path.join(HERE, "phrases.json"), "utf8"));
const LIST_ONLY = process.argv.includes("--list-voices");

const KEYS = {
  eleven: process.env.ELEVENLABS_API_KEY,
  azure: process.env.AZURE_SPEECH_KEY,
  azureRegion: process.env.AZURE_SPEECH_REGION,
  google: process.env.GOOGLE_TTS_API_KEY,
};

/* ------------------------------------------------------------------ *
 * Azure — the only provider with contractually locale-tagged pt-PT.
 * ------------------------------------------------------------------ */
const AZURE_VOICES = ["pt-PT-RaquelNeural", "pt-PT-DuarteNeural"];

async function azureSpeak(voice, text) {
  const url = `https://${KEYS.azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml =
    `<speak version='1.0' xml:lang='pt-PT'><voice xml:lang='pt-PT' name='${voice}'>` +
    escapeXml(text) +
    `</voice></speak>`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": KEYS.azure,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "mil-palavras-voice-test",
    },
    body: ssml,
  });
  if (!res.ok) throw new Error(`Azure ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ------------------------------------------------------------------ *
 * Google — explicit pt-PT voices too.
 * ------------------------------------------------------------------ */
const GOOGLE_VOICES = ["pt-PT-Wavenet-A", "pt-PT-Wavenet-B"];

async function googleSpeak(voice, text) {
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${KEYS.google}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: "pt-PT", name: voice },
        audioConfig: { audioEncoding: "MP3", speakingRate: 1.0 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return Buffer.from(json.audioContent, "base64");
}

/* ------------------------------------------------------------------ *
 * ElevenLabs — best-sounding, but language-tagged not locale-tagged,
 * so its Portuguese can drift Brazilian. That is what we are testing.
 * ------------------------------------------------------------------ */
async function elevenVoices() {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": KEYS.eleven },
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).voices || [];
}

async function elevenSpeak(voiceId, text) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": KEYS.eleven, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ------------------------------------------------------------------ */

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );
}

async function run(label, speak) {
  const dir = path.join(OUT, label);
  await fs.mkdir(dir, { recursive: true });
  let ok = 0;
  for (const p of PHRASES) {
    const file = path.join(dir, `${p.id}.mp3`);
    try {
      await fs.access(file);
      ok++;
      continue; // already generated — never pay twice
    } catch {}
    try {
      const buf = await speak(p.text);
      await fs.writeFile(file, buf);
      ok++;
      process.stdout.write(".");
    } catch (e) {
      process.stdout.write("x");
      console.error(`\n  ${label} / ${p.id}: ${e.message}`);
    }
  }
  console.log(`\n  ${label}: ${ok}/${PHRASES.length}`);
  return { label, ok };
}

const done = [];
console.log(`${PHRASES.length} phrases\n`);

if (KEYS.azure && KEYS.azureRegion) {
  console.log("Azure (pt-PT neural)");
  for (const v of AZURE_VOICES) done.push(await run(`azure__${v}`, (t) => azureSpeak(v, t)));
} else {
  console.log("Azure: skipped (set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION)");
}

if (KEYS.google) {
  console.log("Google (pt-PT wavenet)");
  for (const v of GOOGLE_VOICES) done.push(await run(`google__${v}`, (t) => googleSpeak(v, t)));
} else {
  console.log("Google: skipped (set GOOGLE_TTS_API_KEY)");
}

if (KEYS.eleven) {
  const voices = await elevenVoices();
  if (LIST_ONLY) {
    console.log("\nElevenLabs voices available to this account:");
    for (const v of voices) {
      const lbl = Object.values(v.labels || {}).join(", ");
      console.log(`  ${v.voice_id}  ${v.name}${lbl ? "  [" + lbl + "]" : ""}`);
    }
    console.log("\nRe-run with ELEVEN_VOICE_IDS=\"id1,id2\" to test specific ones.");
  } else {
    const chosen = (process.env.ELEVEN_VOICE_IDS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const ids = chosen.length ? chosen : voices.slice(0, 2).map((v) => v.voice_id);
    if (!ids.length) console.log("ElevenLabs: no voices on this account");
    console.log("ElevenLabs (multilingual v2)");
    for (const id of ids) {
      const name = (voices.find((v) => v.voice_id === id) || {}).name || id;
      done.push(await run(`eleven__${name.replace(/\W+/g, "-")}`, (t) => elevenSpeak(id, t)));
    }
  }
} else {
  console.log("ElevenLabs: skipped (set ELEVENLABS_API_KEY)");
}

if (!LIST_ONLY) {
  if (!done.length) {
    console.log("\nNothing generated — no provider keys were set. See the README in this folder.");
    process.exit(0);
  }
  // The comparison page is static and can't list directories — hand it a manifest.
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(
    path.join(OUT, "manifest.json"),
    JSON.stringify({ voices: done.map((d) => d.label), phrases: PHRASES }, null, 2)
  );
  console.log(`\n${done.length} voice(s) generated into tools/voice-test/out/`);
  console.log("Now open:  http://localhost:8765/tools/voice-test/compare.html");
}
