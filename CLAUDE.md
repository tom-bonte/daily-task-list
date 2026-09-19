# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal daily task list with per-task timers and time statistics. It replaces an Apple Notes checklist. It has a single user (Google sign-in) and is a plain HTML/CSS/JS web app with no build step. Data lives in Firebase (Auth + Firestore) and hosting is on **Netlify**.

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
- Keyboard shortcuts (in the `keydown` handler): `1`–`4` switch views, `N` or `/` focuses the add field, `←`/`→` change day, `T` jumps to today.
- `js/ui.js`: `esc`, `catColor` (solid hue) / `catFill` (mark background, striped for slots 9–16) / `catVars` (sets both as `--cc` / `--cf` inline), `renderTimeline` (the day's timer sessions as a strip plus a list).
- `js/stats.js`: `computeStats` (pure aggregation into categories, tasks, and day/month buckets) and `renderStats` (bars, stacked-column chart, table view).
- `js/firebase.js` (Firestore store + Google auth) and `js/local-store.js` (demo store) implement the **same store interface**: `watchSettings`, `saveSettings`, `watchDay`, `getDay`, `saveDay`, `getDaysRange`, `getLastDayBefore`. `app.js` only talks to that interface.

### Data model (Firestore)

- `users/{uid}/meta/settings`: `{ v, categories, backlog, memory, running }`
  - `v`: settings schema version. `withDefaults` migrates older settings via `migrateCategories`, and `app.js` saves them back once. Bump `SETTINGS_VERSION` when adding a migration.
  - `categories`: `[{ id, name, emoji, slot, keywords }]`. `slot` 0 is gray, 1–8 are the palette hues, and 9–16 are the same hues striped. Every category gets a unique slot; picking a taken slot in Settings swaps it. `keywords` are user-editable (a trailing `*` is a prefix wildcard), and a category's name words also count. `general` is the fallback category and can't be deleted. Custom categories have random ids; `presetKeywordsFor` matches presets by id or by name (e.g. Family/Familie, Work/Werk).
  - `backlog`: the "Wachtruimte" (someday list).
  - `memory`: `{ normText → categoryId }`. Learned whenever the user overrides a category, and checked before keywords. Among keywords, the one appearing **earliest** in the text wins, then the longest ("Ma bellen" → Family, not the "bellen" errand).
  - `running`: `{ date, id, text, cat, base, s }`, a pointer to the single running timer. It carries enough data to render the running bar without loading that day.
- `users/{uid}/days/{YYYY-MM-DD}`: `{ date, tasks: [{ id, text, cat, done, repeat, target, sessions: [{s, e}], adjust }] }`
  - Time spent = sum of sessions (a running session has `e: null`) + `adjust` (manual ± minutes).
  - Unknown `cat` values (from deleted categories) are shown under `general`.

### Invariants worth knowing

- Only one timer runs at a time. `startTimer` always calls `stopRunning` first, and completing, deleting, or moving a running task stops it.
- Days are keyed by **local** date. "Plan tomorrow" and "Start from <last day>" use `carryOver`, which copies **only** tasks marked "repeat daily" (user preference), with fresh ids and zero time.
- A snapshot can replace `S.day` at any time, so re-find tasks by id before mutating after any async gap (see the edit sheet's submit handler).
- A running session (`e: null`) must stay **last** in `sessions`, because `stopRunning` and `isRunning` read `sessions.at(-1)`. Manually logged blocks (`blockFromTimes`: edit sheet "Add block", or the "Log time?" prompt shown when a task with planned time is checked off untimed) are inserted sorted before it.
- The edit sheet saves in its form `submit` handler, not in the `<dialog>` `close` event. Chrome defers `close` in background tabs.
- The web `apiKey` is public. Security comes from `firestore.rules`, which gives each user access only to `users/{uid}/**`.
- Chart colors use a validated categorical palette (CSS vars `--c1..--c8`, `--c0` gray) with separate light and dark steps. More hues fail the colorblind checks, so categories beyond 8 use the striped variants rather than new colors. Marks use `var(--cf)`.

## How the user plans (product context)

The app follows the user's Notes habit. Each evening they plan the next day by copying the previous one. Tasks are grouped under categories and many recur daily (Make plan tomorrow, Evening routine, AM run, a reading slot). Unfinished one-off tasks roll forward. Task text is free-form, in English, Dutch, or Spanish, and often starts with a duration ("2hr Shopify", "AM 1hr Read Outlander"). The user loves statistics: time per category per day, week, month, and year.

The project is on the Firebase Spark (free) plan, so there are no Cloud Functions.
