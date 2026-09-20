# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal daily task list with per-task timers and time statistics, called **Habits Rabbits** in the UI (the repo and folder are still `daily-task-list`). It replaces an Apple Notes checklist. It has a single user (Google sign-in) and is a plain HTML/CSS/JS web app with no build step. Data lives in Firebase (Auth + Firestore) and hosting is on **Netlify**.

## Commands

```bash
npx serve public -l 5173            # local dev server (also in .claude/launch.json as "app")
firebase deploy --only firestore:rules   # rules are the only thing deployed via Firebase
```

- **Deploying = pushing `main` to GitHub** (`tom-bonte/daily-task-list`). The Netlify site `habits-rabbits` auto-deploys `public/` per `netlify.toml`, with no build step. When the user says "push to github", commit the pending work and push `main`.
- Any new hosting domain must be listed under Firebase Console → Authentication → Settings → Authorized domains, or Google sign-in fails with `auth/unauthorized-domain`.
- `http://localhost:5173` without `?demo` talks to the **real Firestore data** (localhost is an authorized auth domain), so local edits change the user's live tasks.
- Open `http://localhost:5173/?demo` for **demo mode**: it uses a localStorage store and needs no sign-in or network. Use it to test UI changes; Google sign-in can't be automated.
- There are no tests, linter, or bundler. `public/js/model.js` is pure, so it can be exercised directly with `node` via a small `.mjs` script that imports it.
- Python's `http.server` can't read `~/Documents` in this environment; use `npx serve`.

## Architecture

All app code is in `public/`, as ES modules loaded straight from the browser. The Firebase SDK comes from the gstatic CDN, pinned to **12.19.0**; keep every Firebase import on that same version.

- `js/model.js`: pure logic with no DOM or Firebase. It holds the category presets, keyword auto-categorization (`PRESET_KEYWORDS` + `guessCategory`, mixed EN/NL/ES), settings migrations (`SETTINGS_VERSION`, `migrateCategories`), `parseTarget` (reads a planned duration from text like "2hr…" or "5:45-6:45…"), `normText` (strips times so the same task groups across days), time math, carry-over, and date/period helpers.
- `js/app.js`: state object `S`, full re-render via `innerHTML` templates, event delegation on `data-action` / `data-change` / `data-form` attributes, timer logic, and the edit-task `<dialog>`. A 1s `tick()` updates only the live numbers and does not re-render.
- **Layout is desktop-first.** A fixed left sidebar (`#tabs`) holds the running timer card (`#runbar`). The day view is the task columns plus a right rail (`#rail`: category split and timeline; the user doesn't want the backlog there) that the tick refreshes every 15s. Below 1180px the rail drops under the tasks. Below 760px the sidebar becomes a bottom tab bar.
- Keyboard shortcuts (in the `keydown` handler): `1`–`5` switch views, `N` focuses the add field, `/` opens Search, `←`/`→` change day, `T` jumps to today, `J`/`K` select a task, `Space` starts/stops its timer, `E` edits it, `X` completes it.
- Tasks are reordered by HTML5 drag and drop (`dragstart`/`dragover`/`drop` on `#view`); dropping into another category card also changes the task's category. Category order is changed with the ↑/↓ buttons in Settings.
- Icons come from `brand/logo.jpeg` (kept out of `public/`, so the source is not deployed). Rebuild them with `npm run icons` (`scripts/build-icons.mjs`, uses sharp): it squares the logo on white, knocks the white out to alpha for `favicon.webp`, `favicon-32.png`, `icon-192.png` and `icon-512.png`, and keeps a white background for `apple-touch-icon.png`, because iOS composites transparency onto black.
- `sw.js` + `manifest.json` + the icons: offline app shell and installability. Code (HTML/CSS/JS/JSON) is **network-first** so a deploy can never leave a client running a mix of old and new files (that produced an empty zoom view once); icons and the Firebase SDK stay cache-first, and the cache is the offline fallback. Bump `CACHE` in `sw.js` when the precache list changes. The service worker is **not** registered on localhost, and unregisters itself there, so local edits are never served stale.
- Times are 24-hour everywhere. Native `input[type=time]` follows the browser locale (AM/PM), so time entry uses plain text inputs (`.time-input`) normalised by `normHHMM` ("930" → "09:30"); `blockFromTimes` accepts either.
- Clicking the day timeline opens `renderDayZoom` in the `#sheet` dialog (`zoom-dialog` class): an hour grid where stretches with no activity collapse into a "Nh quiet" row, only genuinely overlapping sessions share the width (clustered, then lane-packed), a "now" line marks the current time on today, and a block click opens that task.
- `js/ui.js`: `esc`, `catColor` (solid hue) / `catFill` (mark background, striped for slots 9–16) / `catVars` (sets both as `--cc` / `--cf` inline), `renderTimeline` (the day's timer sessions as a strip plus a list).
- `js/stats.js`: `computeStats` (pure aggregation into categories, tasks, and day/month buckets) and `renderStats` (bars, stacked-column chart, table view).
- `js/firebase.js` (Firestore store + Google auth) and `js/local-store.js` (demo store) implement the **same store interface**: `watchSettings`, `saveSettings`, `watchDay`, `getDay`, `saveDay`, `getDaysRange`, `getLastDayBefore`. `app.js` only talks to that interface.

### Data model (Firestore)

- `users/{uid}/meta/settings`: `{ v, categories, backlog, memory, running }`
  - `v`: settings schema version. `withDefaults` migrates older settings via `migrateCategories`, and `app.js` saves them back once. Bump `SETTINGS_VERSION` when adding a migration.
  - `categories`: `[{ id, name, emoji, slot, keywords }]`. `slot` 0 is gray, 1–8 are the palette hues, and 9–16 are the same hues striped. Every category gets a unique slot; picking a taken slot in Settings swaps it. `keywords` are user-editable (a trailing `*` is a prefix wildcard), and a category's name words also count. `general` is the fallback category and can't be deleted. Custom categories have random ids; `presetKeywordsFor` matches presets by id or by name (e.g. Family/Familie, Work/Werk).
  - `backlog`: the "Wachtruimte" (someday list).
  - `memory`: `{ normText → categoryId }`. Learned whenever the user overrides a category, and checked before keywords. Among keywords, the one appearing **earliest** in the text wins, then the longest ("Ma bellen" → Family, not the "bellen" errand).
  - `running`: `[{ date, id, text, cat, base, s }]`, one entry per running timer. Each carries enough data to render the running bar without loading that day.
- `users/{uid}/days/{YYYY-MM-DD}`: `{ date, tasks: [{ id, text, cat, done, repeat, target, sessions: [{s, e}], adjust }] }`
  - Time spent = sum of sessions (a running session has `e: null`) + `adjust` (manual ± minutes).
  - Unknown `cat` values (from deleted categories) are shown under `general`.

### Access control

The database is locked to one account. `firestore.rules` reads `/config/owner`; the first signed-in user claims that document via `claimOwnership` in `js/firebase.js`, and everyone else gets a "Locked" screen. To hand the app to another account, delete `/config/owner` in the Firebase console. App Check is wired but off: set `window.APP_CHECK_KEY` in `index.html` to a reCAPTCHA v3 site key (Firebase console → App Check → register the web app) to turn it on.

### Invariants worth knowing

- A task with an open session **is** running; `settings.running` only mirrors that so the run bar can show timers from other days. `reconcileRunning` repairs the mirror whenever a day loads (devices overwriting the settings document used to strand a timer with no way to stop it).
- The edit sheet lists every block with editable From/To times: clearing an end leaves it running, filling one in stops the timer, and × deletes the block.
- **Several timers can run at once** (settings `running` is a list since `SETTINGS_VERSION` 3). Overlapping time is counted in full for each task, and `overlapMs` reports how much is double counted; the day tile, the rail and the stats tile warn when that is a minute or more. `stopRunning(id)` stops one timer, `stopRunning()` stops all; completing, deleting or moving a task stops its own timer.
- Session hygiene (`tidySessions`): runs under `MIN_SESSION_MS` (1 min) are dropped, and blocks of the same task less than `MERGE_GAP_MS` (2 min) apart are merged. It runs on stop, on sheet save, and on log-time. `startTimer` reopens the previous block instead of creating a new one if it ended within 2 min and no other task ran in between. The day-view timeline rows have a × (`session-del`) to delete a block.
- Learning: a manual category change saves exact-text `memory` and then offers, via the `ask()` prompt, to move the deciding keyword (`explainGuess`), or the first meaningful word (`learnableWord`), into the chosen category's keywords. Nothing is learned without the user confirming.
- Days are keyed by **local** date. "Plan tomorrow" and "Start from <last day>" use `carryOver`, which copies **only** tasks marked "repeat daily" (user preference), with fresh ids and zero time.
- A snapshot can replace `S.day` at any time, so re-find tasks by id before mutating after any async gap (see the edit sheet's submit handler).
- A running session (`e: null`) must stay **last** in `sessions`, because `stopRunning` and `isRunning` read `sessions.at(-1)`. Manually logged blocks (`blockFromTimes`: edit sheet "Add block", or the "Log time?" prompt shown whenever a task is checked off with no logged time) are inserted sorted before it. From/To times typed in the edit sheet count on Save even without pressing "+ Add".
- All writes go through `persist()`, which surfaces failures in the sticky `#banner` (also used for the offline notice). Deleting a task offers Undo through `ask()`.
- `tick()` also handles the **day rollover** (`rollOver` splits a running timer at midnight and continues it on the new day) and the **long-timer guard** (`LONG_TIMER_MS`, 3h: a notification plus an `ask()` offering to trim). Notifications are per-device (`localStorage` `dtl-notify`), and on iOS they only arrive while the app is open.
- In demo mode, `window.__dtl` exposes `{ S, rollOver }` for testing time-dependent paths without touching the clock.
- The edit sheet saves in its form `submit` handler, not in the `<dialog>` `close` event. Chrome defers `close` in background tabs.
- The web `apiKey` is public. Security comes from `firestore.rules`, which gives each user access only to `users/{uid}/**`.
- Chart colors use a validated categorical palette (CSS vars `--c1..--c8`, `--c0` gray) with separate light and dark steps. More hues fail the colorblind checks, so categories beyond 8 use the striped variants rather than new colors. Marks use `var(--cf)`.

## macOS extras

- The helper runs at login but shows its icon **only while the web app is running** (`item.isVisible`, driven by NSWorkspace launch/terminate notifications), and its Quit item quits the web app rather than the helper.
- `menubar/` is a small Swift menu bar app (`./menubar/build.sh` → `~/Applications/Habits Rabbits Menu.app`). It keeps no state: each item runs `open -g -a <web app> <site>?…`, which the web app turns into an action via `applyLaunchParams` (`?do=stop`, `?view=…`, `?date=today|tomorrow|YYYY-MM-DD`). Launch commands run after the **day** loads, not just settings, or the running timers are not known yet. The menu bar glyph comes from `npm run menubar-icon` (black silhouette + alpha, drawn as a template image).
- ⌥Space activates the web app, via a BetterTouchTool keyboard trigger; the sidebar footer shows that shortcut on Mac only.

## How the user plans (product context)

The app follows the user's Notes habit. Each evening they plan the next day by copying the previous one. Tasks are grouped under categories and many recur daily (Make plan tomorrow, Evening routine, AM run, a reading slot). Unfinished one-off tasks roll forward. Task text is free-form, in English, Dutch, or Spanish, and often starts with a duration ("2hr Shopify", "AM 1hr Read Outlander"). The user loves statistics: time per category per day, week, month, and year.

The project is on the Firebase Spark (free) plan, so there are no Cloud Functions.
