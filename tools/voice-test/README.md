# European Portuguese voice test

Picks the voice for Mil Palavras' pre-generated audio. Runs the same 20 phrases
through every provider you have a key for, then lets you compare them blind.

The phrases aren't random — each one targets a specific place where a Brazilian
voice gives itself away (final `s` as /ʃ/, unstressed vowel reduction, open `ó`,
`estar a + infinitive`, enclitic pronouns). See `phrases.json`.

## 1. Get keys

All three have free tiers that comfortably cover this test.

| Provider | Sign up | Free tier | Notes |
|---|---|---|---|
| **Azure Speech** | portal.azure.com → create a *Speech* resource | 500k chars/month for 12 months | Only provider with contractually locale-tagged `pt-PT` voices (Raquel, Duarte) |
| **Google Cloud TTS** | console.cloud.google.com → enable Text-to-Speech → API key | 1M chars/month standard, 100k WaveNet | Explicit `pt-PT` WaveNet voices |
| **ElevenLabs** | elevenlabs.io | 10k chars/month | Best-sounding, but language-tagged not locale-tagged — its Portuguese can drift Brazilian. That's what we're testing. |

## 2. Set them in your shell

Never put these in a file inside the repo. Export them for the session:

```bash
export AZURE_SPEECH_KEY=...
export AZURE_SPEECH_REGION=westeurope
export GOOGLE_TTS_API_KEY=...
export ELEVENLABS_API_KEY=...
```

Any provider you skip is simply skipped — one key is enough to start.

## 3. Generate

```bash
node tools/voice-test/generate.mjs
```

Already-generated clips are never re-requested, so re-running is free. To see
which ElevenLabs voices your account has before spending characters:

```bash
node tools/voice-test/generate.mjs --list-voices
```

Then pick specific ones:

```bash
ELEVEN_VOICE_IDS="id1,id2" node tools/voice-test/generate.mjs
```

## 4. Compare blind

```
http://localhost:8765/tools/voice-test/compare.html
```

Voices are labelled A, B, C… consistently across all phrases. Choose the best
for each, *then* hit **Reveal the providers**. Judge with your ears before you
know which brand you're hearing — the tally at the bottom keeps score.

## What happens next

The winner gets used to pre-generate audio for all 990 words and ~600 passage
lines as static `.mp3` files, precached by the service worker. That keeps the
app fully offline, costs nothing per play, and gives every device the same
verified European Portuguese — instead of whatever `speechSynthesis` happens to
have installed, which today can be Brazilian.

`out/` is gitignored — these clips are never published to the live site.
