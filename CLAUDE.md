# Mil Palavras — working notes

European Portuguese vocabulary app. Vanilla JS, no build step, no framework.
Live at **https://milpalavras.app** (GitHub Pages, apex domain + `www` CNAME).

## Hard rules

1. **European Portuguese only. Never Brazilian.** This is the entire point of
   the app. Check EU-PT markers: *comboio / autocarro / casa de banho /
   pequeno-almoço*, `estar a + infinitive` (never the gerund), enclitic
   pronouns (*chama-se*), spellings like *facto*, *receção*. `tools/audio` and
   the readings pipeline both enforce this; don't weaken those checks.
2. **Never put a secret key in the client.** Supabase uses the *publishable*
   key only — RLS is the protection. The Azure Speech key lives in a
   gitignored `.env` and is only ever read by build scripts, never shipped.
3. **AI-written or AI-adapted reading passages must carry `ai: true`**, which
   renders the "✳ texto gerado por IA" mark. The user asked for this
   explicitly. Never quote copyrighted news or stories verbatim — use
   public-domain/CC sources with attribution, or original summaries with a
   dated link.
4. **Release with `node tools/bump.mjs`** after editing any cached file. Four
   things must agree — `CACHE_VERSION`, `APP_BUILD`, the `?v=` on index.html's
   `<script>`/`<link>` tags, and the same `?v=` in `APP_SHELL`. Never bump them
   by hand. index.html is served **network-first** while its scripts are
   **cache-first**, so mismatched `?v=` lets a fresh document run against the
   previous release's scripts — that is how a signed-in user once got told to
   sign in (new page called `MilSync.signedIn()`, old sync.js lacked it).

## Layout

| File | What |
|---|---|
| `index.html` | The whole app: design system `<style>`, `window.__DATA__` (990 vocab cards), and one big IIFE |
| `readings.js` | `window.MIL_READINGS` — 101 graded passages (A1–B2) |
| `content.js` | `window.MIL_CONTENT` — per-word pronunciation, examples, notes |
| `sync.js` / `sync-config.js` | Supabase auth + progress sync (publishable key only) |
| `sw.js` | Service worker: versioned app-shell cache + **durable** audio cache |
| `audio/` | ~185MB of pre-generated speech, committed deliberately |
| `tools/audio/` | Audio build scripts |
| `tools/voice-test/` | Blind voice A/B harness (how Duarte was chosen) |
| `supabase/functions/` | Edge Functions (account deletion) |

The app is one IIFE, so nothing is on `window` except deliberate hooks
(`MilSync`, `MilLegal`, and `__CARDS__` under `?dev=1` on localhost). Screens
are `render*()` functions writing `innerHTML` via `h()`, wired with `on(sel, ev, fn)`.

## Running it

```bash
python3 -m http.server 8765
```

Then `http://localhost:8765/?dev=1` — the `dev=1` flag skips the auth gate and
is localhost-only, so it cannot work on the real domain.

## Audio

Azure Speech, voice **pt-PT-DuarteNeural**, native pace, format
**`audio-48khz-192kbitrate-mono-mp3`**.

**Never drop to 24kHz.** It band-limits at ~12kHz, exactly where the EU-PT /ʃ/
sibilants live (*os livros* = "ush LEE-vrush"), and sounds scratchy. That was
tested and rejected. The 0.85× playback speed was *not* the cause.

Four sets, all matched **by exact spoken text** (mirroring `sayable()`), so
adding audio never requires touching call sites:

| Dir | Contents | Manifest key |
|---|---|---|
| `audio/w/<cardId>.mp3` | 990 vocabulary cards | `words` (ids) |
| `audio/r/<readingId>__<line>.mp3` | 517 passage lines | `readings` |
| `audio/d/<i>.mp3` | 2855 conjugation + grammar drills | `drills` (texts, positional) |
| `audio/p/<i>.mp3` | 1018 passage words, lower-cased | `passage` (texts, positional) |

```bash
node tools/audio/build.mjs               # everything missing (resumable)
node tools/audio/build.mjs --drills      # one set only
node tools/audio/build.mjs --limit 30    # pilot
```

Needs `.env` with `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` (currently
`uksouth`). Free F0 tier: 500k chars/month; the whole library is ~62k, and
existing files are never re-requested.

Drill cards are **generated at runtime**, so their text exists nowhere on disk.
`tools/audio/drills.mjs` runs the app's own generator in Node against a DOM
stub rather than reimplementing conjugation rules — if it breaks after a
refactor, widen the slice or the stub, **never** reimplement the rules.

Playback: one file per phrase; Lento/Normal/Natural are `playbackRate`
0.7/0.85/1.0 with `preservesPitch`. Never generate per-speed sets.

## Service worker

Two caches, and the distinction matters:

- `CACHE_VERSION` — app shell, wiped on every version bump.
- `AUDIO_CACHE` (`mil-palavras-audio-v1`) — **never** wiped by a version bump.
  Users can download ~185MB; destroying that on a CSS tweak is unacceptable.
  Only bump it if the recordings themselves change.

Only cache responses that succeeded (`res.ok && status === 200`). Caching a 404
once served it forever and broke the app until a version bump — that bug is
fixed, don't reintroduce it.

## Scheduler semantics

Asked about repeatedly; get these right:

- `S.set.perDay` gates **intake only** (`newAllowance() = perDay − newToday`).
  It caps new cards entering `startReview()`, never the number of reviews.
- Practice modes also call `grade()`, so studying outside Rever silently
  consumes the daily new-word allowance.
- **"Words started" must come from `deckProgress().started`** (990 vocab only).
  `Object.keys(S.prog).length` includes drill cards and produces a second,
  larger number under the same label — that was a real bug.
- Trouble words: `p.l` counts "Outra vez" grades and only ever increments, so
  trouble is `l >= TROUBLE_AT (4) && iv < 21`. The `iv` clause is what lets a
  mastered word age out.

## Sync

Push is automatic (debounced 1.2s on every `save()`). Pull happens at sign-in,
on `visibilitychange`/focus/reconnect (throttled 20s, skipped while
`bridge.busy()` i.e. mid-session), and via the manual button. `bridge.refresh()`
redraws the current screen via `LAST_RENDER` instead of navigating home.

## Deploying

Commit and push to `main`; GitHub Pages rebuilds. Verify with:

```bash
curl -s https://milpalavras.app/sw.js | grep CACHE_VERSION
```

## Speaking (Falar) — pronunciation assessment

Azure Pronunciation Assessment, `pt-PT`. Accuracy / fluency / completeness are
scored per word and phoneme; **prosody is `en-US` only**, so don't promise it.

The key must never reach the browser: `supabase/functions/speech-token` mints a
10-minute authorization token per signed-in user, cached client-side for 9
minutes. The 454KB SDK in `vendor/speech-sdk.js` is **lazy-loaded on first use
and deliberately absent from the service-worker precache** — don't add it.

The privacy notice discloses that Falar sends audio to Microsoft, that only the
score returns, and that no recording is kept. **If that data flow ever changes,
the notice must change with it** — the same applies to the conversation
partner (#20), which would break the "nothing leaves your device" line.

## Outstanding (needs the user, not code)

- `ola@milpalavras.app` is published in the privacy/terms pages but **does not
  exist yet** — needs a GoDaddy forwarder.
- `supabase functions deploy delete-account` — until deployed, account deletion
  removes data and signs out but leaves the login record, and the app says so.
- `supabase secrets set AZURE_SPEECH_KEY=... AZURE_SPEECH_REGION=uksouth` then
  `supabase functions deploy speech-token` — until deployed, Falar shows
  "assessment isn't switched on yet" instead of scoring.
