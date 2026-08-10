# Handover — all twelve tenses, and verb mastery

Session date 2026-08-10. Branch **`claude/verb-conjugations-1000-words-arnrfb`**,
one commit **`92a39e4`** on top of `main` at `18133c6`.

Nothing is live. Pages deploys from `main`, so milpalavras.app is unchanged
until this branch merges.

---

## The question this answers

> For the 1000 words to be truly known, many are verbs. To truly know a verb,
> do I have to know and have done exercises for all the conjugations? Or just
> one? Or only the infinitive?

The app's answer is now explicit: **those are two separate questions and they
never share a total.**

- The **vocabulary card** answers *what does falar mean*. That is the only thing
  the 990 counter on the home screen counts, and it stays that way.
- **`verbMastery()`** answers *can you conjugate it*, as a ladder — a verb is
  conjugated to rung N when the lemma is known **and every cell of every tense
  up to N is known**.

Not a percentage, and no skipping a rung. One missing cell in the present drops
the verb back to rung 0 even if all of B2 is complete.

---

## What changed

| File | Change |
|---|---|
| `index.html` | Conjugation engine, drill generation, verb mastery model, two new screens, tense-ladder setting, CSS |
| `tools/conj-check.mjs` | **New.** 127 conjugated forms checked against hand-written paradigms |
| `tools/audio/build.mjs` | `pinned()` — stops a growing drill list silently re-labelling existing mp3s |
| `CLAUDE.md` | Two new sections + the audio pinning rule |
| `sw.js` | `node tools/bump.mjs`, v40 → v41 |

### Card counts

| | Before | After |
|---|---|---|
| Vocabulary | 990 | 990 |
| Conjugation | 2,693 | **14,819** |
| Grammar | 339 | 339 |
| **Total** | 4,022 | **16,148** |

Ten tenses added: imperfeito, mais-que-perfeito, futuro, condicional,
conjuntivo presente / imperfeito / futuro, infinitivo pessoal, imperativo,
particípio.

---

## Where things are in `index.html`

| Line | What |
|---|---|
| ~759 | `tenseLevel()` — reads `S.set.tlvl`, gates daily intake |
| ~1795 | `infpForms()` — personal infinitive, incl. the `-air`/`-uir` accents |
| ~1834 | `TENSES` — the twelve-row table: id, labels, rung, cue, clitic rule |
| ~1861 | `conjugateAll()` — the whole paradigm |
| ~2019 | `fullConjTable()` — any set of tenses as one table |
| ~2311 | `placeClitic()` — reflexive pronoun placement per tense |
| ~2329 | `buildConjugation()` — card generation |
| ~2727 | `verbIndex()` / `verbMastery()` / `masteryVerdict()` |
| ~2804 | `renderVerbs()` — the Verbos list screen |
| ~2848 | `renderVerb(v)` — one verb's ladder, paradigm and drill buttons |

---

## Design decisions worth knowing before you change anything

### The engine derives, it does not tabulate

Portuguese builds almost everything from three principal parts, and
`conjugateAll()` is written that way:

- **infinitive** → futuro, condicional, infinitivo pessoal
- **`eu` form** → conjuntivo presente, and the imperative from that
- **`eles` past** → conjuntivo imperfeito, conjuntivo futuro, mais-que-perfeito

So the exception tables carry only what genuinely cannot be derived: three
irregular future stems (`dir- / far- / trar-`), four irregular imperfects
(`era / tinha / vinha / punha`), seven present subjunctives the `eu` form does
not predict (`seja esteja vá dê saiba queira haja`), and a participle list.
**Adding ten tenses needed no second irregular-verb dataset.** If you find
yourself about to add one, the derivation is probably wrong instead.

### Card ids are load-bearing

Ids are `c|<word>|<tenseId>|<person>`. **`p` (presente) and `t` (pretérito
perfeito) must keep those ids.** They are the two tenses that existed before,
and 2,693 cards are already scheduled under them. Verified this session: all
2,693 carry over byte-identical, both id and answer.

### The ladder gates intake only

`S.set.tlvl` (1–4, default **2**) decides which tenses enter the *daily queue*
via `newPool()`. Every tense is always drillable by hand from Conjugações — the
setting is not a content restriction.

Rungs: A1 presente · A2 passado/imperfeito/imperativo/particípio · B1
futuro/condicional/conjuntivo presente · B2 the rest.

Cumulative conjugation cards per rung: **1,347 / 5,389 / 9,434 / 14,819.**

The default is 2 because `newPool()` interleaves 3 words : 1 conjugation : 1
grammar, so conjugation enters at 20% of intake. All twelve tenses at once
would bury the vocabulary the ladder exists to support.

### Reflexive placement is tense-dependent, and stays European

Only 7 reflexive verbs in the deck, but the rules differ per tense:

- enclitic in the plain indicative — `deitamo-nos` (note `nós` drops its `-s`)
- proclitic in the subjunctives — `que eu me deite`
- **mesoclitic** in futuro and condicional — `deitar-me-ei`

Mesoclisis is kept deliberately: Brazil never writes it, so it is exactly the
kind of marker this app exists for. The card's tip explains it and notes that
speech usually prefers `vou deitar-me`.

### The subjunctive prompts carry their trigger

Subjunctive cards prompt `que eu` / `se eu` / `quando eu` rather than a bare
person. A learner who has drilled `quando eu falar` has learned the thing that
actually matters; `falar` on its own teaches half the lesson.

---

## Three real bugs the checker caught

Written down because they will come back if the engine is refactored.

1. **`deem`, not `dêem`.** AO90 dropped that circumflex, the same way it did for
   `creem / leem / veem`. The present table already spelled `veem` that way, so
   the app was internally inconsistent for a moment.
2. **Futuro do conjuntivo is not derived from the past when the past stem is the
   infinitive in disguise.** `saíram` gives `saír`; the tense is `sair`. The
   test is a de-accented comparison against the infinitive, **not** `pretReg` —
   `sair` is flagged irregular yet has a regularly shaped past.
3. **`-air` / `-uir` verbs open the stem vowel before `-es` and `-em`** in the
   personal infinitive: `sair, saíres, sair, sairmos, saírem`. Note `sairmos`
   stays bare — the closed syllable takes no accent.

Also worth remembering: the `nós` accent on `-ssemos` / `-ramos` depends on the
stem vowel, and a regular `-er` verb keeps its closed theme vowel
(`comêssemos`) while a strong preterite stem takes an acute (`fizéssemos`).

---

## The audio hazard, and the fix

This one was latent and would have been silent.

`audio/d/<i>.mp3` and `audio/p/<i>.mp3` are indexed by **position in a sorted
list**, and the builder **skips clips it already has**. So growing the drill set
would have kept every existing mp3 on disk while the manifest re-labelled it as
a different phrase. No error, no warning — the app would simply say the wrong
word. It would have hit **2,850 of your 2,855 files**.

`pinned()` in `tools/audio/build.mjs` now treats the shipped manifest as owning
the slots it has already handed out: a text keeps its index, new texts are
appended, and a slot whose text is no longer generated is left alone rather
than reused. Verified this session: **zero existing slots change meaning.**

`audio/manifest.json` was deliberately **not** touched, so existing audio keeps
working as-is and the new forms fall through to the device voice until built.

---

## What you need to do

### 1. Merge it (required)

Nothing reaches milpalavras.app until this is on `main`. No PR has been opened.

```bash
git fetch origin
git checkout claude/verb-conjugations-1000-words-arnrfb
```

Then merge to `main` however you prefer, and confirm the release landed:

```bash
curl -s https://milpalavras.app/sw.js | grep CACHE_VERSION   # expect v41
```

### 2. Record the new audio (optional, any time)

```bash
node tools/audio/build.mjs --drills
```

Needs the gitignored `.env` with `AZURE_SPEECH_KEY` and
`AZURE_SPEECH_REGION=uksouth`.

- **8,195 new clips**, roughly 62k characters — inside the free F0 monthly tier
- Resumable: stop and restart it freely, existing files are never re-requested
- Re-records **none** of the 2,855 clips you already have

Until you run it the new tenses use the device voice, exactly like any card
without a recording. Nothing breaks.

### 3. Nothing else

No config, no migration, no data reset. Existing progress carries over on its
own, and the app opens on the A2 rung so the daily load stays close to what it
is today.

---

## How to check it yourself

```bash
node tools/conj-check.mjs      # 127 forms, expect "127 pass, 0 fail"
python3 -m http.server 8765    # then http://localhost:8765/?dev=1
```

In the app: **Conjugações → Verbo a verbo** is the new entry point. Pick any
verb to see its ladder, the full paradigm, and a drill button per tense. The
tense ladder itself is in **Definições → Tempos verbais**.

Verified in a browser this session: 269 verbs listed, 12 tense rows per verb,
4 ladder rungs, the drill prompt renders (`quando tu` → `falares`), the settings
segment switches rungs, and no console or page errors.

---

## Things I deliberately did not do

- **No compound tenses as cards.** `tenho falado` / `tinha falado` are `ter` +
  participle, and both halves are already drilled to every rung. Generating
  2,690 near-identical two-word cards would pad the deck without teaching
  anything new. If you want them, they belong in the grammar family as cloze
  cards, not as per-verb per-person cards.
- **No gerúndio.** EU-PT uses `estar a` + infinitive for the progressive, and
  drilling a gerund as if it were the progressive would fight the app's whole
  premise. The other uses of the gerund are rare enough not to earn 269 cards.
- **No changes to the 990 counter.** It was already correct — sourced from
  `deckProgress().started`, vocabulary only.
- **No PR.** Waiting on you.

## Open question you may want to revisit

At rung B2 the deck is 16,148 cards, fed at 3 words : 1 conjugation : 1 grammar.
The vocabulary runs out long before the conjugation does, so the back half of
the queue becomes almost entirely verb forms. The ladder default (A2) keeps this
tolerable, but if you ever want the full set in rotation without that tail, the
interleave ratio in `newPool()` is the lever — not the card count.
