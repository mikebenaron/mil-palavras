# Overnight pass — acting on the three reviews

Build **v55**. Everything below is verified against the running app, not just
written. All 20 screens render with no uncaught errors; `tools/conj-check.mjs`
is 127/127; scripts parse and every rendered CSS class now has a rule behind it.

**Nothing is committed.** Review the diff first:

```bash
git -C /Users/mike/portuguese-app diff
```

---

## The four critical bugs

**1. The scheduler was blind to five of six study modes.**
`grade()` had exactly one call site. Choice, type, dictation, gender and speak
threw their results away — fail to *type* a word and it kept its three-month due
date. Now every mode calls `practiceGrade()`. Verified live: failing to type a
word pulled a 90-day due date to today; getting *o diploma*'s gender wrong
pulled 60 days to today and recorded a lapse.

Two limits keep it honest: practice never awards **Fácil** (a "right" gives 37d
where a real Fácil gives 82d), and it **never touches a card not already in
rotation**, so practising can't eat the day's new-word allowance.

**2. The daily plan could never complete.**
`bumpAct("listen")`/`("drill")` lived inside `grade()`, so those counters never
moved: Ditado and Escolha were untickable and **"Já chega por hoje" was
unreachable**. Moved into `studyBeat()`, called by every mode. Confirmed on
screen for the first time.

**3. Every conjugation and grammar multiple-choice answer was scored wrong.**
*Not in the reviews — found while fixing #1.* Drill ids are strings
(`"c|ser|p|0"`) but the handler did `+attribute`, giving `NaN`. The right answer
never matched, and your chosen option was never highlighted. Now compares as
strings throughout.

**4. The "queue finished" screen shipped unstyled.**
`renderEmpty` used `.mark`, `.ghost` and a `backBar` whose classes existed in no
stylesheet, in English only. Rebuilt from the app's own primitives, bilingual,
with the forecast bars answering "when's the next batch".

---

## Vocabulary: 990 → 1,105

The deck had **no food words at all**, no months, no weekdays, almost no
numbers — while carrying *assembleia*, *administração*, *desenvolvimento*. A
written-corpus fingerprint. 127 everyday probes came back missing.

Added **115 words**, each with respelling, example, note and EU-PT teaching
point, in a new `número` class: numbers 2–100 and mil, all 7 weekdays, all 12
months, food and table, meals, travel, survival vocabulary, directions.

Several carry EU-PT markers the app enforces but didn't teach:
*comboio*, *autocarro*, *pequeno-almoço*, *chávena*, *paragem*, *morada*,
*ementa*, and the **dezasseis / dezassete / dezanove** and **catorze** spellings
Brazil writes differently.

> **The deck is append-only, and this is now a hard rule in CLAUDE.md.** Card ids
> *are* array indices and `S.prog` is keyed by them — inserting or reordering
> would silently remap every card in your scheduler onto a different word. I
> verified every pre-existing card is byte-identical, so your progress is
> untouched.

### Audio — done

Built on your go-ahead. **223 new clips** (110 words + 113 example sentences),
0 failed, ~8,450 characters against the 500,000/month free tier. Same voice and
format as everything else: pt-PT-DuarteNeural, 48 kHz / 192 kbps mono.

Verified in the running app — every probe resolves to a recorded clip, not the
device voice:

```
41ms  gravado[CACHE 0.85x] o pão
13ms  gravado[REDE  0.85x] Apanhei o comboio das oito.
46ms  gravado[REDE  0.85x] Ela faz dezasseis anos em maio.
```

`gravado` = recorded, and 13–46ms rather than the 8 seconds we chased before.
No `synth` anywhere in the log.

**Positional manifests survived intact** — 0 slots changed text across drills,
examples, passage and readings. That was the one catastrophic failure mode here
(a clip keeping its audio while the manifest relabels it), and `pinned()` held.

Two side effects worth knowing:

- I ran without `--rung 2`, so the drills manifest expanded to all twelve
  tenses: 13,201 → 30,401 slots. The extra slots are null placeholders, which
  is the documented intent — but it **also indexed 460 drill clips that were
  already on disk and invisible**, left over from the run before your stop
  order. Those now play.
- `manifest.json` grew 153 KB → 248 KB as a result. It is precached, so that is
  a real if modest cost. Say the word and I will trim it back to rung 2.

Build is now **v55**.

---

## Pedagogy

- **Type-it now works in context.** Instead of glossing in English it blanks the
  word out of its own example sentence: *"Vou à padaria comprar ____."* The only
  production exercise in the app used to be one isolated word at a time.
- **"Quase" is its own bucket.** Accent-wrong and article-missing answers both
  counted as fully correct, so a plateau looked like mastery. They now score
  separately and the scheduler hears "Difícil".
- **Character-level diff** on wrong answers — `conheco` vs `conheço` marks the ç
  instead of leaving you to hunt for it.
- **Review defaults to Misto**, not PT→EN. Recognition-only meant the whole deck
  could reach "known" without producing a single Portuguese word under test.
  *This changed your existing setting once* — one tap in Definições reverts it.
- **Quiz answers shuffle.** The stored key sat at position 0 in 48% of 248
  questions and was rendered in stored order. Now uniform (18/22/20 over 60
  renders), with a "tentar outra vez" that reshuffles.
- **Conjugation dosing.** Only *eu / ele / nós* of a tense enter the daily
  queue; *tu* and *eles* unlock once those are known — 35% less conjugation
  intake, nothing hidden. Mastery rungs are now 95% rather than all-or-nothing,
  so one lapsed *falas* no longer demotes a verb that's complete through B2.

## Content corrections

14 respellings fixed: `SOWN (nasal)` → `SOW (nasal)` (the trailing N is the
audible consonant the house style forbids), `(nasal)` un-glued from mid-word in
*construção / demonstrar / transformar*, `você` → `voo-SAY`, `o membro` →
`MEHM-broo`. And **`vermelho`'s example modelled the exact error its own note
corrects** ("vinho vermelho" — Portuguese say *tinto*); it's now a red dress.

## New: Memória

The scheduler knew each word's memory half-life and showed you a streak. There's
now a screen that says it out loud: how many words are holding today, what's
slipping, how many you rescued, *"tested right now you'd get about 206 of 220"*,
your deepest memories with how long each lasts, and your projected finish date.

## Interface

- **Dark mode** — warm near-black paper, same hues inverted, accents keeping
  their meaning. Follows the OS or set it explicitly in Definições; `theme-color`
  moves with it. Six hardcoded light colours re-tokenised so nothing stays cream
  at night.
- **Verbo a verbo** got a home tile and a rail entry (it was buried two levels
  deep and lit no rail item). **Memória** and **the daily text** got the same.
- **Tile numbers are authored, not positional** — the conditional "Difíceis"
  tile used to renumber everything below it.
- **Reading has memory**: read marks, a "continuar" row, and a half-finished
  cloze or quiz now survives a stray tab tap.
- **Listen / reveal moved above the passage** — they were below the fold on
  every text.
- **Zoom unlocked** (`maximum-scale=1` removed), lang-marking extended from 8 to
  22 selectors, nothing under 10px, no tap target under 32px.
- Update bar can be dismissed; English-only toasts translated; drill rows are
  PT-first; destructive actions folded into a "Zona perigosa" with danger
  styling instead of sitting one row from "copy progress".
- **~250 lines of dead code deleted** — an entire tips subsystem superseded by
  `noteCards` and never removed, plus `backBar`, `row`, ten unused glyphs and
  five orphaned data tables.

## Testing

The app is one strict-mode closure, so nothing inside could be reached from
outside — which is *precisely* how a dead `grade()` path and an untickable plan
shipped unnoticed. Added `window.__MP__` under the existing localhost + `?dev=1`
gate, and a checker (`scratchpad/check.mjs`) that parses every script and fails
on any rendered class with no CSS behind it.

---

## Not done, deliberately

- **Audio for the new words** — your Azure instruction (command above).
- **Settings split into three screens** — did the safety half (danger zone);
  the full Estudo / Áudio / Conta split and moving the tense ladder into
  Conjugações are still open.
- **Retiring press vocabulary.** I added rather than removed. If you want the
  active deck nearer 1,000, the safe route is a `rt:1` flag filtered out of
  `newPool()` — never splicing cards out.
- **Longer B1/B2 texts** (passages average 5.1 lines), a second voice, and the
  conversation partner (#20) — the 6→9 move, and too big for one night.
