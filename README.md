# Mil Palavras — European Portuguese

A single-page web app for learning the ~1,000 most useful words and phrases of
**European Portuguese** through spaced repetition, flashcards, and quizzes.

It is a fully self-contained Progressive Web App: no build step, no server, no
external dependencies. All vocabulary is embedded in the page, and your progress
is saved locally in the browser.

## Features

- **Spaced repetition review** — the main study loop, scheduling words as they come due.
- **Flashcards** — flip through a set at your own pace.
- **Multiple choice** quizzes.
- **Offline support** — a service worker caches the app so it works with no connection.
- **Installable** — add it to your iPhone/Android home screen and it runs full-screen like a native app.

## Running locally

It's just static files. From this folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. (A plain server is needed rather than opening
the file directly, so the service worker can register.)

## Installing on your phone

1. Open the live site in Safari (iOS) or Chrome (Android).
2. iOS: tap **Share → Add to Home Screen**. Android: tap the **Install** prompt / menu.
3. Launch it from the new icon — it opens full-screen and works offline.

## Project structure

| File | Purpose |
| --- | --- |
| `index.html` | The entire app — UI, logic, and embedded vocabulary data. |
| `manifest.webmanifest` | PWA metadata (name, icons, colors, standalone display). |
| `sw.js` | Service worker for offline caching. |
| `icon-*.png`, `apple-touch-icon.png` | App icons. |

## Updating the app

After editing `index.html` (or any cached file), bump `CACHE_VERSION` in
`sw.js` so installed users pick up the new version.
