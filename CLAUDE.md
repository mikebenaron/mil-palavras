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
| `index.html` | The whole app: design system `<style>`, `window.__DATA__` (1,105 vocab cards), and one big IIFE |
| `readings.js` | `window.MIL_READINGS` — 101 graded passages (A1–B2) |
| `content.js` | `window.MIL_CONTENT` — per-word pronunciation, examples, notes |

`content.js` is keyed by the **exact Portuguese string**, but six words exist as
two cards each with different word classes — `a` (article + preposition), `se`
(pronoun + conjunction), and `melhor` / `pior` / `perto` / `longe` (adjective +
adverb). They share one content entry, so its note must cover both senses.
| `sync.js` / `sync-config.js` | Supabase auth + progress sync (publishable key only) |
| `sw.js` | Service worker: versioned app-shell cache + **durable** audio cache |
| `audio/` | ~185MB of pre-generated speech, committed deliberately |
| `tools/audio/` | Audio build scripts |
| `tools/conj-check.mjs` | Conjugation spot-checks against hand-written paradigms |
| `tools/voice-test/` | Blind voice A/B harness (how Duarte was chosen) |
| `supabase/functions/` | Edge Functions (account deletion) |

The app is one IIFE, so nothing is on `window` except deliberate hooks
(`MilSync`, `MilLegal`, and — under `?dev=1` on localhost only — `__CARDS__`
and `__MP__`). Screens are `render*()` functions writing `innerHTML` via `h()`,
wired with `on(sel, ev, fn)`.

`__MP__` exposes the scheduler, state and plan for testing. It exists because
the strict-mode closure made the app unreachable from outside, so nothing could
be exercised — which is precisely how a dead `grade()` path and an untickable
daily plan shipped unnoticed. Both gates are localhost-only and cannot run on
the real domain.

## The deck is append-only

`window.__DATA__.cards` ids **are array indices**, and `S.prog` is keyed by
them. Inserting, removing or reordering a card silently remaps every card in
every user's scheduler — a word's history would land on a different word. Add
new vocabulary at the **end** only. To retire a word, flag it and filter it out
of `newPool()`; never splice it out.

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
| `audio/w/<cardId>.mp3` | vocabulary cards | `words` (ids) |
| `audio/r/<readingId>__<line>.mp3` | 517 passage lines | `readings` |
| `audio/d/<i>.mp3` | conjugation + grammar drills | `drills` (texts, positional) |
| `audio/p/<i>.mp3` | passage words, lower-cased | `passage` (texts, positional) |

**`drills` and `passage` are positional, and the shipped manifest owns those
positions.** Both lists are sorted, so growing them would renumber everything
after the first insertion — and since the builder skips clips it already has,
every existing file would keep its audio while the manifest re-labelled it as a
different phrase. Nothing errors; the app just says the wrong word. `pinned()`
in `tools/audio/build.mjs` therefore reads the previous manifest first: a text
keeps the slot it owns, new texts are appended, and a slot whose text is no
longer generated is left alone rather than reused. Adding the nine extra tenses
needed 8,195 new clips and re-recorded none of the 2,855 already correct.
**Never regenerate the drill manifest from a bare sort.**

```bash
node tools/audio/build.mjs               # everything missing (resumable)
node tools/audio/build.mjs --drills      # one set only
node tools/audio/build.mjs --limit 30    # pilot
```

Needs `.env` with `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` (currently
`uksouth`). Free F0 tier: 500k chars/month; the whole library is ~62k, and
existing files are never re-requested.

`audio/manifest.json` is precached **with a `?v=` like every other shell file**
— `cache.addAll()` fetches through the browser's HTTP cache, and an unversioned
manifest was once precached stale, making the app believe audio it had didn't
exist. Conjugation audio can be limited to a ladder rung:
`node tools/audio/build.mjs --drills --rung 2`. The manifest reserves silent
slots for unrecorded rungs, so recording them later shifts nothing.

`noteCards()` is the ONLY renderer of the example/note block — renderFlip once
carried its own copy, and a change landed everywhere except review and
flashcards. Don't duplicate it again.

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

## Pronunciation respellings

CAPITALS = stressed syllable; single-syllable words stay lowercase.
Acute accent = OPEN vowel (ó→AW, é→EH); circumflex = closed (ô→OH, ê→AY).
Nasals: before **p/b** write **m** (*tempo* = TEHM-poo); before other
consonants write **n** (*conta* = KOHN-tah); before **nh** the "ny" already
carries it (*banho* = BAH-nyoo). Only a **word-final** nasal is written
"(nasal)", and never a trailing g/ng — hiding an audible m or n behind
"(nasal)" loses a sound the learner actually makes.

## Scheduler — FSRS

FSRS-4.5 replaced SM-2. Two state variables per card: **stability** (how long
the memory lasts) and **difficulty** (how hard this word is for you), scheduled
for 90% target recall. `FSRS_W` are the published default weights fitted on
millions of reviews — **do not hand-tune them**.

Cards keep their SM-2 fields (`iv`, `d`, `r`, `l`) so everything built on them
still works — "known" at `iv >= 21`, the review forecast, trouble words. `s`,
`df` and `lr` are added alongside. Legacy cards migrate lazily on their next
review: the interval that was working becomes the stability estimate, ease plus
lapses become the difficulty, and **the due date is never disturbed**.

`firstEver` must be decided *before* `fsrsMigrate` runs — migration invents a
stability, which otherwise disguises a brand-new card as one with history and
collapses every first-review interval to 1 day.

`previewIv()` runs the real scheduler on a copy of the card, so the number on
the grade button can never drift from what pressing it does.

First-review intervals: Outra vez → today, Difícil → 1d, Bom → 4d, Fácil → 14d.
(Under SM-2, Fácil gave 3 days, which is what prompted the change.)

## Conjugation — all twelve tenses

`conjugateAll()` builds the full paradigm. Portuguese derives almost everything
from three principal parts, and the code is written that way rather than as
twelve tables:

- **the infinitive** → futuro, condicional, infinitivo pessoal
- **the `eu` form** → conjuntivo presente, and the imperative from that
- **the `eles` past** → conjuntivo imperfeito, conjuntivo futuro, mais-que-perfeito

So the exception tables carry only what genuinely cannot be derived: three
irregular future stems (`dir- / far- / trar-`), four irregular imperfects
(`era / tinha / vinha / punha`), seven present subjunctives the `eu` form does
not predict (`seja esteja vá dê saiba queira haja`), and a participle list.
Adding these tenses needed no second irregular-verb dataset.

**Deriving from a principal part fails when the verb hasn't got one**, and the
three verbs that proved it are worth keeping in mind:

- **`haver` is impersonal** — "houve um problema", never "houveram" — so it has
  no `eles` past, and the three tenses grown from that stem came out empty.
  But *se houvesse* and *quando houver* are among the commonest things anyone
  says. `PRET_DEF` supplies the stem and the persons it has; the rest stay null.
- **`acontecer` has no `eu` form**, so the present subjunctive had nothing to
  come from — yet *espero que não aconteça nada* is ordinary Portuguese. It is
  now built from the `eu` form the verb *would* have had, `subpStemEI()` making
  the -cer → -ç shift the missing form would have shown. A verb defective in
  the present stays defective in the subjunctive, person for person, and one
  with no first person gets no imperative at all.
- **A boot verb accents its stem only where the stem is stressed.** `reúno` but
  `reunimos`, and the subjunctive inherits both: `reúna` but **`reunamos`**.
  `presNosStem()` reads the unaccented stem out of the `nós` present and uses it
  for that one cell. The guard is a de-accented comparison, so `tenho`/`temos`
  and `durmo`/`dormimos` — different stems, not accent variants — don't trigger it.

All three are locked into `tools/conj-check.mjs`, which also has an `ABSENT`
table for tenses that must **not** be generated.

```bash
node tools/conj-check.mjs      # 127 forms against hand-written paradigms
```

Run that after any change here. It runs the app's own generator against a DOM
stub rather than reimplementing rules, the same way `tools/audio/drills.mjs`
does. These are the things it exists to catch:

- **`deem`, not `dêem`.** AO90 dropped that circumflex, same as `creem / leem /
  veem`; the present table already spells `veem` that way.
- **The `nós` accent** on `-ssemos` / `-ramos` depends on the stem vowel, and a
  regular `-er` verb keeps its closed theme vowel (`comêssemos`) while a strong
  preterite stem takes an acute (`fizéssemos`).
- **Futuro do conjuntivo is not derived from the past when the past stem is the
  infinitive in disguise.** `saíram` would give `saír`; the tense is `sair`.
  The test is a de-accented comparison against the infinitive, *not* `pretReg` —
  `sair` is flagged irregular yet has a regularly shaped past.
- **`-air` / `-uir` verbs** open the stem vowel before `-es` and `-em` in the
  personal infinitive: `sair, saíres, sair, sairmos, saírem`.
- **Reflexive pronoun placement is tense-dependent**: enclitic in the plain
  indicative (`deitamo-nos`, with `nós` dropping its `-s`), proclitic in the
  subjunctives (`que eu me deite`), and **mesoclitic** in the futuro and
  condicional (`deitar-me-ei`) — which Brazil never writes, so it stays.

Card ids are `c|<word>|<tenseId>|<person>`. **`p` (presente) and `t` (pretérito
perfeito) must keep those ids** — they are the two tenses that existed before
the expansion, and 2,693 cards are already scheduled under them.

## When is a verb "known"?

Deliberately two separate verdicts, and they never share a total:

- The **vocabulary card** answers *what does falar mean*. This is the only thing
  the deck counter on the home screen counts, and it always will be.
- **`verbMastery(v)`** answers *can you conjugate it*, as a ladder. A verb is
  conjugated to rung N when the lemma is known **and at least 95% of the cells
  of every tense up to N are known** — same 21-day bar as everywhere else. Still
  no skipping a rung. The bar used to be *every* cell, which meant one lapsed
  `falas` demoted a verb that was otherwise complete through B2 — a noisy
  signal for something the learner has demonstrably got.

Rungs are A1 presente · A2 passado/imperfeito/imperativo/particípio · B1
futuro/condicional/conjuntivo presente · B2 the rest.

**`S.set.tlv` switches each rung on or off independently, and it is global**: a
rung that is off contributes no new cards *and* is filtered out of `dueList()`.
That second half is the point. The old `S.set.tlvl` was a single "up to rung N"
ladder gating `newPool()` only — so turning it down stopped new B2 cards
arriving and did nothing about the hundreds already in rotation, which kept
coming back for ever. `tenseOn(lvl)` and `tenseBlocked(card)` are the gate;
`tlvl` survives only as the value the one-time migration reads.

Nothing is deleted. A rung switched off keeps its stability and its due dates,
so switching it back on returns those cards exactly where they were — overdue,
most likely, which is honest, because you did stop reviewing them. Every tense
stays drillable by hand from Conjugações, where an off rung is labelled
*desligado nas Definições* rather than hidden, and the UI refuses to switch the
last rung off. Default is A1 + A2 on: all twelve at once is 14,819 conjugation
cards, which buries the vocabulary the ladder exists to support.

## Scheduler semantics

Asked about repeatedly; get these right:

- `S.set.perDay` gates **intake only** (`newAllowance() = perDay − newToday`).
  It caps new cards entering `startReview()`, never the number of reviews.
- **Flashcards ask two questions, not four.** Rever shows the scheduler's own
  Outra/Difícil/Bom/Fácil with real intervals; Cartões shows *Ainda aprendo* →
  grade 1 and *Já sei* → grade 3, because flipping through a deck is a coarser
  act than a considered self-grade. Both buttons were once the same button:
  they shared a `data-adv` handler that advanced the card and recorded nothing
  — no grade, no lapse, no tally, no plan tick — which is why the audit that
  found `grade()`'s single call site missed this mode entirely. It looks for
  `data-grade`; flashcards never had one.
  *Ainda aprendo* maps to **wrong, not near**: mapped to near it became grade 2,
  and FSRS grows stability on a hard-but-early review, so pressing "still
  learning" on a 30-day card pushed it out to 32 days.
- **Every study mode feeds the scheduler**, not just Rever. Choice, type,
  dictation, gender and speak call `practiceGrade(card, verdict)`, which maps
  wrong/near/right to FSRS grades 1/2/3. Two deliberate limits: practice never
  awards **Fácil** (grade 4) — recognising an option in a list is weaker
  evidence than a considered self-grade — and it **never touches a card that
  is not already in rotation**, so practising outside Rever cannot consume the
  day's new-word allowance or introduce words out of order.
  This paragraph previously claimed practice modes called `grade()`. They did
  not: `grade()` had exactly one call site, in `renderFlip`. Every retrieval
  outcome from the other five modes was discarded, and the doc hid it.
- **Plan activity counters live in `studyBeat()`**, called once per answered
  card by every mode — never inside `grade()`. When they lived in `grade()`,
  `a.listen` and `a.drill` could never increment, so the Ditado and Escolha
  plan steps were untickable and "Já chega por hoje" was unreachable.
- **"Words started" must come from `deckProgress().started`** (vocabulary only).
  `Object.keys(S.prog).length` includes drill cards and produces a second,
  larger number under the same label — that was a real bug.
- Trouble words: `p.l` counts "Outra vez" grades and only ever increments, so
  trouble is `l >= TROUBLE_AT (4) && iv < 21`. The `iv` clause is what lets a
  mastered word age out.

## The redesign (Aug 2026 handoff)

Two navigation levels and only two. A **place** keeps the tab bar — Hoje · Ler ·
**Estudar** · Memória · Eu; a **session** owns the viewport, with `sair` and a
counter at the top and no tab bar. `PLACE_OF` maps every screen key to one of
the five, so the right tab is lit wherever you are; anything unmapped is a
session. Deck pickers are places belonging to Estudar, so you can leave
sideways rather than only backwards.

**Hoje answers one question.** The session is planned before it starts
(`sessionPlan()`), and the 88px numeral, the "10 dos 29 · cerca de 5 min" line,
the palavras/verbos/outras split and the CTA all describe the same queue.
`sesLen` (5/10/20/tudo) is persisted and **`startReview` must honour it** — if
it doesn't, the panel is lying about what pressing Começar does.

**Estudar is mode → bucket**, not a wall of tiles. The two "rever" rows skip
the bucket step because the scheduler already owns that queue.

**The card back is context-before-meaning**, and the order is the point: full
Portuguese sentence with no English, then `significa` and the English, then
`família`, then the note. The front carries the same sentence with the word
blanked. `noteCards(c, notesOnly)` exists so the back doesn't print the
sentence twice — it is still the only renderer of that block.

`families.js` holds **authored** word families: collocations and situational
neighbours, never morphological derivations. *o comboio* travels with *a
estação, o bilhete, a linha, atrasado* — not with "comboiar". A card with no
family omits the section.

Three themes: light, dark, night. The old dark put paper at 19% L and card at
23%, four points apart, which is why nothing separated; it is 16 → 22 → 26 now.
Night is warm-hued and never chosen by `auto`. New tokens (`--panel`,
`--onpanel*`, `--btn`/`--onbtn`) sit alongside the originals so old rules keep
working.

## Navigation and sessions

`NAV` is a stack of screen keys, mirrored into `history.pushState` so the iOS
edge-swipe and the Android back button drive it too, and persisted in `S.ui.nav`.
Before it, every screen rendered a back link hard-wired to `home`, so however
deep you went back was a trapdoor to the top — and iOS discarding a suspended
PWA meant the restart landed on home as well.

**`renderPage` must pass `backNav` through untouched.** It used to do
`backLink(backNav || "home", …)`, and that `|| "home"` silently defeated the
whole stack: every screen that doesn't name a destination wants the stack's
answer, not a hard-coded trip home.

Sessions survive leaving. `sesSnapshot()` stores mode, card ids, index and
tallies in `S.ui.ses`; `go()` walks back into an unfinished queue in the same
mode instead of asking which deck you wanted. Only **today's** session is
restored — a half-finished queue from last week is stale, because the scheduler
has moved on. "Recomeçar" inside the session is the deliberate way to throw a
queue away.

## The two "everything" decks

`__random` and `__all` in the deck picker used to start from an identical
`CARDS.slice()` and differ only in how they were sliced afterwards. The result
was that each behaved like the other's label: `__all` took `pool.slice(0, 60)`,
and since `CARDS = WORDS.concat(DRILLS)` that is the sixty commonest *words* —
a beginner vocabulary set called "Tudo". Meanwhile `__random` drew uniformly
over 16,263 cards of which 14,819 are conjugation cells, so "random mix" was
91% verb tables.

They are now two different queries. **Mistura equilibrada** (`mixedPool()`) is
stratified 3 words : 1 conjugation : 1 grammar — the same ratio `newPool()`
uses for the daily intake, so the mix you can ask for is the mix the app
already gives you unasked. **Tudo, sem filtro** is a genuine uniform draw and
the row says what that means in practice.

Both, along with `__started`, `__weak` and the class decks, exclude
`tenseBlocked()` cards: a rung switched off in Definições is off here too.
`renderDrillPicker` deliberately does **not** — Conjugações is the by-hand
route, and drilling a tense on purpose is a different act from having it
arrive unasked.

## Order of presentation

Pools are **selected by frequency and presented shuffled**. The deck is ordered
by usefulness, so the top of a set is the right part to study — but inside a
class, deck order is also semantic order, and the números set arrived *dois,
três, quatro…* with the months in calendar order, which makes the answer
guessable from position alone. The same applies to the day's new intake:
`newPool()` picks, `shuffle()` presents.

## What is not speech

`speakable(t)` rejects contraction formulas (`a + os`) and bare endings (`-am`).
These are notation, and `tools/audio/drills.mjs` has always excluded them from
the recordings — but the app didn't know the rule, so asking for one found no
clip and fell through to the device voice reading "a plus os" aloud. The guard
sits on `sayBtn`, `sayLine`, `autoSay` **and inside `synth()`** as a last line
of defence. The device voice remains a fine safety net for a real word with no
recording; it is never right for notation.

## Sync

Push is automatic (debounced 1.2s on every `save()`). Pull happens at sign-in,
on `visibilitychange`/focus/reconnect (throttled 20s, skipped while
`bridge.busy()` i.e. mid-session), and via the manual button. `bridge.refresh()`
redraws the current screen via `LAST_RENDER` instead of navigating home.

### Signing out must not be able to lose anything

Sign-out wipes the device's only copy of the progress, and sign-in overwrites
whatever is left with the server row. Both are destructive, both were
unconditional, and together they lost a user's deck. Four rules now hold the
line, all of them exercised by `node tools/sync-check.mjs`:

- **`doPush` refuses to write before this session has read the row** (`synced`).
  A sign-in whose pull failed — an ordinary phone on an ordinary connection —
  used to leave an empty state on screen, and the next answered card uploaded
  that emptiness with a fresh timestamp. Last-write-wins then made it
  permanent. This is the rule that turns a scare into a non-event; without it
  the harness watches a 40-card account become a 3-card one for good.
- **The debounce is flushed on `visibilitychange`→hidden and `pagehide`.** 1.2s
  is longer than it takes to close a PWA, so the last card of every session was
  routinely never pushed, and the server sat quietly behind the phone.
- **Nothing is replaced without a copy** (`milpalavras.backup`, one slot, the
  most recent non-empty state and the uid it belonged to). Sign-out writes it;
  so does any pull that would replace local progress with *less*. On the next
  sign-in a backup for the same account that is newer than the server row wins
  and is pushed. It also survives a `SIGNED_OUT` the user never asked for —
  supabase-js emits one when a refresh token finally expires.
- **A queued push cannot land in the next account's row** — `doPush` compares
  `state._uid` with the current session, and sign-out drops the pending state.

Signing in with an empty deck and no server answer shows "não foi possível ler
o teu progresso" with a retry, rather than an empty app that looks like loss.
Definições offers the backup back by hand whenever it differs from what's
loaded; restoring stamps it `now` so it wins the next sync instead of being
pulled back over.

```bash
node tools/sync-check.mjs            # 13 checks against a fake Supabase
node tools/sync-check.mjs old.js     # run a suspect build through the same cases
```

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

## Conversa (#20) — the partner that can only use your words

`supabase/functions/conversa` is a conversation partner **held to the learner's
own vocabulary**. That constraint is the feature: every AI tutor will talk to
you, none of them know which words you have actually earned. The scheduler
does, so the browser sends `conversaVocab()` plus the day's due words, and the
server enforces it.

`conversaVocab()` returns **two tiers**: `earned` (past the 21-day bar, what
the deck counter calls *sabes*) and `met` (in rotation, not there yet), sorted
strongest first. The gate was originally 15 *earned* words and that was the
wrong bar — 21 days is what it takes to claim you know a word, not what it
takes for that word to be usable in a sentence spoken to you, and it locked the
feature away from anyone whose deck was younger than three weeks. Both tiers go
to the partner; `CONV_MIN` (15, total) is only the floor below which no
conversation is possible at all.

Enforced, not merely requested: `validate()` re-checks the reply against the
allowed set, exempting short tokens and a deliberately short `FREE` list of
function words and ser/estar/ter/ir/haver/poder/querer. More than two stray
words and the turn is rejected and regenerated. Brazilian markers are rejected
the same way the daily text rejects them.

Six scenarios live **server-side** in `SCENES`, so a crafted request can't turn
this into a general assistant. Roles on incoming turns are normalised, so the
client cannot inject a system turn.

**`convCredit()` closes the loop**: a due word used correctly in a real
sentence is retrieval, and the strongest kind the app can observe, so it feeds
FSRS like every other mode. Deliberately conservative — only words already due,
only when the partner found nothing to correct, never better than "Bom", and
matched on a whole-word boundary (substring matching would credit *entre* for
*entretanto*, and an unearned credit pushes a real due date out).

The conversation is never stored. **The privacy notice covers this, and the
home-screen footer no longer claims "nothing leaves this device"** — three
features now talk to a server, and the footer names all three.

## Daily text (#18)

`supabase/functions/daily-text` writes one EU-PT passage around the words the
scheduler says are due, via Claude. The key stays server-side; the browser
sends **only the word list and a CEFR level** — no email, no progress, nothing
identifying. Generated once per day and cached in `S.daily`, so re-opening is
free and it works offline afterwards.

The function **validates before returning**: Brazilian markers, missing
fields, gaps that aren't verbatim in the text, answer indices out of range. A
passage that fails is rejected rather than shown — better no text than
Brazilian text. Always returned with `ai:true`, so the ✳ mark shows.

Rendered by pushing the passage into `READINGS` and calling `renderReading`,
so it inherits tap-a-word, cloze, translate and comprehension for free.

The privacy notice discloses this data flow. **If what gets sent ever changes,
the notice changes with it.**

## Outstanding (needs the user, not code)

- `ola@milpalavras.app` is published in the privacy/terms pages but **does not
  exist yet** — needs a GoDaddy forwarder. Confirmed still missing: the domain
  has no MX records at all.

All three Edge Functions are deployed (probed 2026-08-12; each returns 401 to an
unauthenticated POST, which only a deployed function does):

| Function | Slug it actually answers on |
|---|---|
| `delete-account` | `delete-account` |
| `speech-token` | `speech-token` |
| `daily-text` | **`quick-endpoint`** — the dashboard assigned its own slug; the display name is only a label, which is why `DAILY_SLUGS` tries both |

Deployment does **not** prove the secrets are set — a missing secret fails at
call time, not at deploy time. The only way to know is to use the feature:
Falar scores a recording (`AZURE_SPEECH_KEY`), and the daily text generates
(`ANTHROPIC_API_KEY`, confirmed working).
