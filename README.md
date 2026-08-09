# Mil Palavras — European Portuguese

Learn the ~1,000 most useful words of **European Portuguese** — never
Brazilian — through spaced repetition, graded reading, and real recorded audio.

**Live: [milpalavras.app](https://milpalavras.app)**

A Progressive Web App with no build step and no framework. Add it to your home
screen and it works fully offline.

## What's in it

- **Spaced repetition** over 990 vocabulary cards, plus ~3,000 generated
  conjugation and grammar drills.
- **Leitura** — 101 graded passages (A1–B2), each labelled with its level,
  theme and source. Four exercise modes: read with tap-to-reveal translation,
  cloze fill-the-gaps, translate, and comprehension questions.
- **Tap any word** in a passage for its meaning — the infinitive behind a
  conjugated form, the parts behind a contraction (`ao` → `a + o`) — and hear
  it spoken.
- **Read-along** — a passage narrated line by line with the current sentence
  highlighted.
- **Real European Portuguese audio.** ~5,400 clips recorded with Azure's
  `pt-PT-DuarteNeural`, so pronunciation is identical on every device instead
  of depending on whatever voice the phone happens to have installed (often a
  Brazilian one). Adjustable speed with pitch preserved.
- **Accounts and sync** — progress follows you across devices, with offline-first
  last-write-wins reconciliation.
- **Offline** — download the whole audio library and use the app with no signal.

## Running it locally

Static files, so any web server works:

```bash
python3 -m http.server 8765
```

Open `http://localhost:8765/?dev=1` — the `dev=1` flag skips the sign-in gate
and only works on localhost.

## Repository

| Path | What |
|---|---|
| `index.html` | The app — design system, vocabulary data, and all logic |
| `readings.js` | The 101 reading passages |
| `content.js` | Per-word pronunciation, examples and usage notes |
| `sync.js` | Accounts and progress sync (Supabase) |
| `audio/` | Pre-generated speech, served same-origin and cached on play |
| `tools/audio/` | Scripts that build the audio library |
| `tools/voice-test/` | The blind A/B harness used to choose the voice |
| `CLAUDE.md` | Architecture notes, invariants and gotchas |

## Content sources

Reading passages come from public-domain or openly-licensed material (folk
tales, Aesop, traditional proverbs, Wikipedia adapted to European Portuguese)
with attribution, or are original summaries with a dated link — never
copyrighted text reproduced verbatim. Passages written or adapted by AI carry a
**✳** mark in the app.
