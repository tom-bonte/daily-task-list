import * as M from './model.js';
import { computeStats, renderStats, categoryBars, bucketName, previousAnchor } from './stats.js';
import { esc, catColor, catFill, catVars, renderTimeline, renderDayZoom, SLOT_NAMES } from './ui.js';

const DEMO = new URLSearchParams(location.search).has('demo');

const LONG_TIMER_MS = 3 * 3600000;
const NOTIFY_KEY = 'dtl-notify';

const S = {
  fb: null, store: null, user: null, today: M.todayKey(), longAsked: null, launchApplied: false, loadingTimer: null,
  settings: null,
  date: M.todayKey(), day: null, dayLoaded: false, lastBefore: undefined,
  view: 'day',
  stats: { kind: 'day', anchor: M.todayKey(), days: null, expanded: new Set() },
  search: { q: '', days: null, loading: false },
  sel: null,
  unsub: [],
};

const $ = sel => document.querySelector(sel);
const viewEl = $('#view'), runEl = $('#runbar'), navEl = $('#tabs'), sheet = $('#sheet'), tip = $('#tip');

// ---------------- boot / auth ----------------

async function boot() {
  if (DEMO) {
    const { createLocalStore } = await import('./local-store.js');
    S.user = { email: 'Demo mode' };
    S.store = createLocalStore();
    start();
    return;
  }
  try {
    S.fb = await import('./firebase.js');
  } catch (e) {
    viewEl.innerHTML = `<div class="login"><p>Couldn't load Firebase. Check your connection.</p><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  S.fb.onUser(async user => {
    stop();
    S.user = user;
    if (!user) return renderLogin();
    // This database belongs to whoever signed in first.
    let owner = 'owner';
    try { owner = await S.fb.claimOwnership(user.uid); } catch { owner = 'error'; }
    if (owner !== 'owner') {
      document.body.classList.add('logged-out');
      viewEl.innerHTML = owner === 'locked'
        ? '<div class="login"><h1>Locked</h1><p class="muted">This app is locked to another Google account.</p><button class="ghost" data-action="sign-out">Sign out</button></div>'
        : '<div class="login"><h1>Can\'t reach the database</h1><p class="muted">Check your connection and reload.</p><button class="ghost" data-action="sign-out">Sign out</button></div>';
      return;
    }
    S.store = S.fb.createFirestoreStore(user.uid);
    start();
  });
}

function renderLogin(error) {
  document.body.classList.add('logged-out');
  viewEl.innerHTML = `
    <div class="login">
      <h1>Habits Rabbits</h1>
      <p class="muted">Plan your day, time your tasks, see where the hours go.</p>
      <button class="primary big" data-action="sign-in">Sign in with Google</button>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <p class="muted small"><a href="?demo">Try demo mode</a> (stored in this browser only)</p>
    </div>`;
}

// Commands passed in the URL, used by the menu bar app (and handy as bookmarks):
// ?do=stop stops every running timer, ?view=stats|day|search|backlog|settings,
// ?date=YYYY-MM-DD|today|tomorrow opens that day.
async function applyLaunchParams() {
  const p = new URLSearchParams(location.search);
  if (p.get('updated')) toast('Updated to the latest version');
  if (![...p.keys()].some(k => ['do', 'view', 'date'].includes(k))) return;
  const date = p.get('date');
  if (date) openDay(date === 'tomorrow' ? M.addDays(M.todayKey(), 1) : date === 'today' ? M.todayKey() : date);
  if (p.get('do') === 'stop') {
    const task = p.get('task');
    const running = task ? S.settings.running.filter(r => r.id === task).length : S.settings.running.length;
    await stopRunning(task || null);
    toast(running ? `Stopped ${running} timer${running > 1 ? 's' : ''}` : 'No timer was running');
  }
  if (p.get('view')) showView(p.get('view'));
  history.replaceState({}, '', location.pathname + (DEMO ? '?demo' : ''));
}

function start() {
  document.body.classList.remove('logged-out');
  // Never sit on "Loading…" in silence: a page opened in the background can be
  // throttled before Firestore connects, so offer a way out.
  clearTimeout(S.loadingTimer);
  S.loadingTimer = setTimeout(() => {
    if (S.settings) return;
    viewEl.innerHTML = `
      <div class="login">
        <h1>Still connecting…</h1>
        <p class="muted">Habits Rabbits can't reach your data right now.</p>
        <button class="primary" data-action="reload">Reload</button>
      </div>`;
  }, 8000);
  S.unsub.push(S.store.watchSettings(s => {
    const first = !S.settings;
    clearTimeout(S.loadingTimer);
    S.settings = M.withDefaults(s);
    // First run, or settings from an older version: persist the defaults / migration.
    if (!s || (s.v ?? 1) < M.SETTINGS_VERSION) saveSettings();
    if (first || !sheet.open) render(); else renderRunbar();
  }));
  openDay(S.date);
}

function stop() {
  S.unsub.forEach(u => u());
  S.unsub = [];
  S.settings = null;
  S.day = null;
}

function openDay(key) {
  S.dayUnsub?.();
  Object.assign(S, { date: key, day: null, dayLoaded: false, lastBefore: undefined });
  S.dayUnsub = S.store.watchDay(key, d => {
    if (S.date !== key) return;
    S.day = d;
    S.dayLoaded = true;
    reconcileRunning(d, key);
    if (!S.launchApplied) { S.launchApplied = true; applyLaunchParams(); }
    if (!d?.tasks?.length && S.lastBefore === undefined) {
      S.lastBefore = null;
      S.store.getLastDayBefore(key).then(last => {
        if (S.date === key) { S.lastBefore = last; render(); }
      });
    }
    if (!sheet.open) render();
  });
  render();
}

// ---------------- persistence helpers ----------------

// Writes are fire-and-forget; a rejection (rules, bad data) must not pass silently.
// Offline writes stay pending in the Firestore cache and resolve on reconnect.
function persist(promise, what) {
  return promise.catch(err => {
    console.error(err);
    banner(`Couldn't save ${what}: ${err.code || err.message}`);
  });
}

function saveSettings() {
  return persist(S.store.saveSettings(S.settings), 'settings');
}

function saveDay() {
  return persist(S.store.saveDay(S.date, S.day), 'this day');
}

// Apply fn to a day's data and persist it, whether or not that day is on screen.
async function mutateDay(key, fn) {
  // Only trust the in-memory copy once the day has actually loaded, otherwise an
  // early action (a launch command, say) would save an empty day over real data.
  if (key === S.date && S.dayLoaded) {
    S.day ??= { tasks: [] };
    fn(S.day);
    render();
    await saveDay();
  } else {
    const d = (await S.store.getDay(key)) ?? { tasks: [] };
    fn(d);
    await persist(S.store.saveDay(key, d), 'that day');
  }
}

const catById = id => S.settings.categories.find(c => c.id === id)
  || S.settings.categories.find(c => c.id === M.FALLBACK_CAT)
  || S.settings.categories[0];
const findTask = id => S.day?.tasks.find(t => t.id === id);

// ---------------- timers ----------------

// A task with an open session IS running, whatever settings say. Settings only
// mirror that so the running bar can show timers from other days; devices that
// overwrite each other can leave the two out of step, so repair it on load.
function reconcileRunning(day, key) {
  if (!S.settings) return;
  const open = (day?.tasks || []).filter(t => M.isRunning(t));
  const runs = S.settings.running.filter(r => r.date !== key || open.some(t => t.id === r.id));
  for (const t of open) {
    if (runs.some(r => r.date === key && r.id === t.id)) continue;
    const last = t.sessions.at(-1);
    runs.push({ date: key, id: t.id, text: t.text, cat: t.cat, base: M.taskMs({ ...t, sessions: t.sessions.slice(0, -1) }), s: last.s });
  }
  if (JSON.stringify(runs) === JSON.stringify(S.settings.running)) return;
  S.settings.running = runs;
  saveSettings();
}

// Stops one running timer, or all of them when no id is given.
async function stopRunning(id = null, now = Date.now()) {
  const runs = S.settings.running.filter(r => id == null || r.id === id);
  // Fallback for sessions settings never recorded (see reconcileRunning).
  const strays = (S.day?.tasks || []).filter(t => M.isRunning(t) && (id == null || t.id === id) && !runs.some(r => r.id === t.id));
  for (const t of strays) runs.push({ date: S.date, id: t.id });
  if (!runs.length) return;
  S.settings.running = S.settings.running.filter(r => !runs.includes(r));
  saveSettings();
  let dropped = 0;
  for (const r of runs) {
    await mutateDay(r.date, d => {
      const t = d.tasks.find(t => t.id === r.id);
      const last = t?.sessions.at(-1);
      if (!last || last.e != null) return;
      last.e = now;
      if (now - last.s < M.MIN_SESSION_MS) dropped++;
      t.sessions = M.tidySessions(t.sessions);
    });
  }
  if (dropped) toast('Under a minute, not logged');
}

async function startTimer(id) {
  const now = Date.now();
  const t = findTask(id);
  if (!t) return;
  // Restarting within a couple of minutes (and nothing else ran meanwhile)
  // continues the previous block instead of starting a new one.
  const prev = t.sessions.at(-1);
  const resumable = prev && prev.e != null && now - prev.e >= 0 && now - prev.e <= M.MERGE_GAP_MS;
  if (resumable) prev.e = null;
  else t.sessions.push({ s: now, e: null });
  const open = t.sessions.at(-1);
  S.settings.running.push({ date: S.date, id, text: t.text, cat: t.cat, base: M.taskMs({ ...t, sessions: t.sessions.slice(0, -1) }), s: open.s });
  render();
  await saveDay();
  saveSettings();
}

const runFor = id => S.settings.running.find(r => r.date === S.date && r.id === id);
const isRunningTask = id => !!runFor(id) || M.isRunning(findTask(id) || {});

// ---------------- rendering ----------------

function render() {
  if (!S.settings) { viewEl.innerHTML = '<div class="loading">Loading…</div>'; return; }
  const add = viewEl.querySelector('form[data-form] input[name=text], form[data-form=search] input[name=q]');
  const keep = add && { form: add.form.dataset.form, value: add.value, focused: document.activeElement === add };

  viewEl.innerHTML = S.view === 'day' ? dayView()
    : S.view === 'stats' ? statsView()
    : S.view === 'search' ? searchView()
    : `<div class="page narrow">${S.view === 'backlog' ? backlogView() : settingsView()}</div>`;

  if (keep) {
    const again = viewEl.querySelector(`form[data-form="${keep.form}"] input`);
    if (again && keep.value) { again.value = keep.value; syncGuess(again); }
    if (again && keep.focused) again.focus();
  }
  // Quiet reminder of the macOS shortcut that brings this app forward.
  const mac = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
  $('#nav-foot').innerHTML = `
    <span class="nav-mail">${esc(S.user?.email || '')}</span>
    ${mac ? '<span class="nav-hint"><kbd>⌥</kbd><kbd>space</kbd><span>to open</span></span>' : ''}`;
  navEl.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-current', b.dataset.view === S.view ? 'page' : 'false'));
  renderRunbar();
}

function catOptions(selected) {
  return S.settings.categories.map(c => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.emoji || '')} ${esc(c.name)}</option>`).join('');
}

function dayTotals(now = Date.now()) {
  const byCat = {};
  let total = 0;
  // Ignore a few stray seconds of overlap; only real double counting is worth a warning.
  const overlap = Math.max(0, M.overlapMs(S.day?.tasks, now));
  for (const t of S.day?.tasks || []) {
    const ms = M.taskMs(t, now);
    const cat = catById(t.cat).id;
    byCat[cat] = (byCat[cat] || 0) + ms;
    total += ms;
  }
  return { total, byCat, overlap };
}

function dayView() {
  const tasks = S.day?.tasks || [];
  const rel = M.relativeLabel(S.date);
  const { total, byCat, overlap } = dayTotals();
  const done = tasks.filter(t => t.done).length;
  const next = M.addDays(S.date, 1);

  const sections = S.settings.categories.map(cat => {
    const items = tasks.filter(t => catById(t.cat).id === cat.id);
    if (!items.length) return '';
    return `
      <section class="catsec" data-cat="${esc(cat.id)}" style="${catVars(cat)}">
        <h2><span class="dot"></span><span class="emoji">${esc(cat.emoji || '')}</span>${esc(cat.name)}
          <span class="cat-total" data-cat-total="${esc(cat.id)}">${byCat[cat.id] ? M.fmtDur(byCat[cat.id]) : ''}</span></h2>
        <ul class="tasks">${items.map(taskRow).join('')}</ul>
      </section>`;
  }).join('');

  let empty = '';
  if (!tasks.length && S.dayLoaded) {
    const last = S.lastBefore;
    empty = `
      <div class="empty">
        <p>No plan for ${rel ? rel.toLowerCase() : esc(M.dayLabel(S.date))} yet.</p>
        ${last?.tasks?.length ? `<button class="primary" data-action="copy-last">Start from ${esc(M.dayLabel(last.date))}</button>
          <p class="muted small">Copies the tasks marked "repeat daily".</p>` : '<p class="muted small">Add your first task above.</p>'}
      </div>`;
  }

  const planned = tasks.reduce((a, t) => a + (t.target || 0), 0);
  const isToday = S.date === M.todayKey();

  return `
    <div class="page day-page">
      <header class="pagehead">
        <div class="datenav">
          <div class="datebtns">
            <button class="icon" data-action="day-shift" data-dir="-1" aria-label="Previous day" title="Previous day (←)">‹</button>
            <button class="icon" data-action="day-shift" data-dir="1" aria-label="Next day" title="Next day (→)">›</button>
          </div>
          <label class="daytitle" title="Pick a date">
            <h1>${esc(M.dayLabel(S.date, { weekday: 'long', day: 'numeric', month: 'long' }))}</h1>
            <input type="date" data-change="pick-day" value="${S.date}" aria-label="Pick a date">
          </label>
          ${rel ? `<span class="pill ${isToday ? 'accent' : ''}">${rel}</span>` : ''}
          ${isToday ? '' : '<button class="ghost" data-action="goto-today" title="Today (T)">Today</button>'}
        </div>
        <div class="tiles compact">
          <div class="tile"><span class="tile-label">Tracked</span><span class="tile-value" id="day-total">${M.fmtDur(total)}</span>${overlap >= 60000 ? `<span class="tile-sub warn" title="Two timers ran at the same time, so the total counts that time twice">⚠ ${M.fmtDur(overlap)} overlapped</span>` : ''}</div>
          <div class="tile"><span class="tile-label">Planned</span><span class="tile-value">${planned ? M.fmtMin(planned) : '–'}</span></div>
          <div class="tile"><span class="tile-label">Done</span><span class="tile-value">${done}/${tasks.length}</span></div>
        </div>
      </header>
      <div class="day-layout">
        <div class="day-main">
          <form class="addbar" data-form="add">
            <input name="text" placeholder="Add a task, e.g. 1hr read Outlander" autocomplete="off" enterkeyhint="done" aria-label="New task">
            <kbd class="addkey" aria-hidden="true">N</kbd>
            <select name="cat" aria-label="Category">${catOptions(M.FALLBACK_CAT)}</select>
            <button class="primary" aria-label="Add task">Add</button>
          </form>
          <div class="catgrid">${sections}</div>${empty}
          ${tasks.length ? `<button class="plan-next" data-action="plan-next">Plan ${isToday ? 'tomorrow' : esc(M.dayLabel(next))} →</button>` : ''}
        </div>
        <aside class="rail" id="rail">${railHtml()}</aside>
      </div>
    </div>`;
}

// Right-hand panel of the day view: live category split and timeline.
function railHtml(now = Date.now()) {
  const cats = S.settings.categories;
  const st = computeStats(S.day ? [{ ...S.day, date: S.date }] : [], cats, 'day', S.date, now);
  return `
    <section class="card">
      <div class="card-head"><h2>Time by category</h2><button class="linkish" data-action="day-stats">Stats →</button></div>
      ${categoryBars(st, null, false)}
      ${st.overlap >= 60000 ? `<p class="muted-note warn">⚠ ${M.fmtDur(st.overlap)} of this counts twice: timers overlapped.</p>` : ''}
    </section>
    <section class="card">
      <div class="card-head"><h2>Timeline</h2><button class="linkish" data-action="zoom-day">Zoom →</button></div>
      <div data-action="zoom-day" class="tl-click" title="Open the zoomed day view">${renderTimeline(S.date, S.day?.tasks, cats, now, 6, true)}</div>
    </section>
`;
}

const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function taskRow(t) {
  const running = isRunningTask(t.id);
  const ms = M.taskMs(t);
  const pct = t.target ? Math.min(100, (ms / (t.target * 60000)) * 100) : null;
  const meta = [
    ms || running ? `<span data-live="${t.id}">${M.fmtDur(ms)}</span>${t.target ? ` / ${M.fmtMin(t.target)}` : ''}` : (t.target ? `${M.fmtMin(t.target)} planned` : ''),
    t.repeat ? '<span title="Repeats daily">↻ daily</span>' : '',
  ].filter(Boolean).join(' · ');
  return `
    <li class="task ${t.done ? 'done' : ''} ${running ? 'running' : ''} ${S.sel === t.id ? 'selected' : ''}" draggable="true" data-id="${t.id}">
      <button class="check" role="checkbox" aria-checked="${t.done}" data-action="toggle-done" aria-label="Done: ${esc(t.text)}">${CHECK}</button>
      <button class="task-main" data-action="edit">
        <span class="task-text">${esc(t.text)}</span>
        ${meta ? `<span class="task-meta">${meta}</span>` : ''}
        ${pct != null && (ms || running) ? `<span class="progress"><span data-live-bar="${t.id}" style="width:${pct}%"></span></span>` : ''}
      </button>
      <button class="play ${running ? 'on' : ''}" data-action="toggle-timer" aria-label="${running ? 'Pause' : 'Start'} timer: ${esc(t.text)}">${running ? PAUSE : PLAY}</button>
    </li>`;
}

function renderRunbar() {
  const runs = S.settings?.running || [];
  if (!runs.length) { runEl.innerHTML = ''; runEl.hidden = true; document.title = 'Habits Rabbits'; return; }
  const now = Date.now();
  runEl.hidden = false;
  runEl.innerHTML = `
    ${runs.length > 1 ? `<div class="run-head">${runs.length} timers running<button class="linkish" data-action="stop-all">Stop all</button></div>` : ''}
    ${runs.map(r => {
      const cat = catById(r.cat);
      return `
        <div class="run" style="${catVars(cat)}" data-id="${esc(r.id)}">
          <button class="run-info" data-action="goto-running" data-id="${esc(r.id)}">
            <span class="pulse" aria-hidden="true"></span>
            <span class="run-text">${esc(r.text)}</span>
            <span class="run-cat">${esc(cat.name)}${r.date !== M.todayKey() ? ` · ${esc(M.dayLabel(r.date))}` : ''}</span>
          </button>
          <span class="run-clock" data-clock="${esc(r.id)}">${M.fmtClock(r.base + now - r.s)}</span>
          <button class="play on" data-action="stop-running" data-id="${esc(r.id)}" aria-label="Pause ${esc(r.text)}">${PAUSE}</button>
        </div>`;
    }).join('')}`;
  publishState(runs, now);
}

// One line of text describing the running timers, kept in a screen-reader-only
// element. The macOS menu bar helper reads it through the accessibility tree,
// so it can show the same cards without a copy of the data. Fields: id, clock,
// category, colour, task.
function publishState(runs, now = Date.now()) {
  const el = $('#ax-state');
  if (!el) return;
  const css = getComputedStyle(document.documentElement);
  const clean = v => String(v).replace(/[|~\n]/g, ' ');
  el.textContent = runs.length
    ? 'HRSTATE|' + runs.map(r => {
      const cat = catById(r.cat);
      const colour = css.getPropertyValue(`--c${(cat.slot ?? 0) > 8 ? ((cat.slot - 1) % 8) + 1 : cat.slot ?? 0}`).trim();
      return [r.id, M.fmtClock(r.base + now - r.s), cat.name, colour, r.text, r.date].map(clean).join('~');
    }).join('|')
    : 'HRSTATE';
}

function statsView() {
  const st = S.stats;
  if (!st.days) return `<header class="viewhead"><h1>Stats</h1></header><div class="loading">Loading…</div>`;
  st.computed = computeStats(st.days, S.settings.categories, st.kind, st.anchor);
  // The loaded range also covers the previous period, for the "vs last week" deltas.
  const prev = computeStats(st.days, S.settings.categories, st.kind, previousAnchor(st.kind, st.anchor));
  return renderStats(st.computed, S.settings.categories, st.expanded, st.days, prev);
}

function backlogView() {
  const items = S.settings.backlog;
  const target = M.relativeLabel(S.date) || M.dayLabel(S.date);
  return `
    <header class="viewhead">
      <h1>Wachtruimte</h1>
      <p class="muted">Someday tasks. Send one to a day when you're ready.</p>
    </header>
    <form class="addbar" data-form="backlog-add">
      <input name="text" placeholder="Add to the waiting room" autocomplete="off" aria-label="New backlog item">
      <select name="cat" aria-label="Category">${catOptions(M.FALLBACK_CAT)}</select>
      <button class="primary">Add</button>
    </form>
    <ul class="backlog">
      ${items.map(b => {
        const cat = catById(b.cat);
        return `
          <li data-id="${b.id}" style="${catVars(cat)}">
            <span class="dot"></span>
            <span class="task-text">${esc(b.text)}<span class="muted small"> · ${esc(cat.name)}</span></span>
            <button class="ghost" data-action="backlog-to-day">→ ${esc(target)}</button>
            <button class="icon" data-action="backlog-del" aria-label="Remove ${esc(b.text)}">×</button>
          </li>`;
      }).join('') || '<li class="muted-note">Empty. Nice.</li>'}
    </ul>`;
}

function settingsView() {
  const cats = S.settings.categories;
  return `
    <header class="viewhead"><h1>Settings</h1></header>
    <section class="card">
      <h2>Categories</h2>
      <p class="muted small">New tasks are sorted by their words: the keyword that appears first in the task wins, and a category's own name always counts.
        Separate keywords with commas; end one with * to match word endings (swim* → swimming). When you change a task's category by hand, the app remembers it.
        Tasks that fit nowhere go to <strong>${esc(catById(M.FALLBACK_CAT).name)}</strong>. Picking a color that's taken swaps it with that category.</p>
      <ul class="cat-edit">
        ${cats.map(c => `
          <li data-cat="${esc(c.id)}" style="${catVars(c)}">
            <div class="cat-edit-row">
              <input class="emoji" data-change="cat-field" data-field="emoji" value="${esc(c.emoji || '')}" aria-label="Emoji">
              <input data-change="cat-field" data-field="name" value="${esc(c.name)}" aria-label="Name">
              <span class="dot"></span>
              <select data-change="cat-field" data-field="slot" aria-label="Color">
                ${SLOT_NAMES.map((n, i) => {
                  const owner = cats.find(o => o.id !== c.id && (o.slot ?? 0) === i && i !== 0);
                  return `<option value="${i}" ${i === (c.slot ?? 0) ? 'selected' : ''}>${n}${owner ? ` · ${esc(owner.name)}` : ''}</option>`;
                }).join('')}
              </select>
                <button class="icon" data-action="cat-move" data-dir="-1" aria-label="Move ${esc(c.name)} up" title="Move up">↑</button>
              <button class="icon" data-action="cat-move" data-dir="1" aria-label="Move ${esc(c.name)} down" title="Move down">↓</button>
              ${c.id === M.FALLBACK_CAT ? '<span class="icon"></span>' : `<button class="icon" data-action="cat-del" aria-label="Delete ${esc(c.name)}">×</button>`}
            </div>
            ${c.id === M.FALLBACK_CAT ? '' : `<input class="keywords" data-change="cat-field" data-field="keywords" value="${esc((c.keywords || []).join(', '))}" placeholder="Keywords, e.g. run, gym, swim*" aria-label="Keywords for ${esc(c.name)}">`}
          </li>`).join('')}
      </ul>
      <button class="ghost" data-action="cat-add">+ Add category</button>
    </section>
    <section class="card">
      <h2>Account</h2>
      <p>${esc(S.user?.email || '')}</p>
      <label class="check-label settings-check">
        <input type="checkbox" data-change="notify" ${localStorage.getItem(NOTIFY_KEY) === '1' ? 'checked' : ''}>
        Warn me when a timer has run for ${M.fmtDur(LONG_TIMER_MS)}
      </label>
      <p class="muted small">Shows a notification on this device while the app is open (a background tab counts), plus a prompt in the app.</p>
      <p class="muted small">Your data lives in Firebase and is locked to this account. Keep a copy now and then.</p>
      <button class="ghost" data-action="export">Download my data (JSON)</button>
      <button class="ghost" data-action="import">Restore from a file…</button>
      <input type="file" id="importfile" accept="application/json,.json" data-change="import-file" hidden>
      <button class="ghost" data-action="force-update" title="Clears the offline cache and reloads">Force update</button>
      ${DEMO
        ? ' <button class="ghost" data-action="demo-reset">Clear demo data</button> <a class="ghost btnlink" href="./">Leave demo</a>'
        : '<button class="ghost" data-action="sign-out">Sign out</button>'}
    </section>`;
}

// Live-update only the ticking numbers, once a second.
function tick() {
  if (M.todayKey() !== S.today) rollOver();
  const runs = S.settings?.running || [];
  if (!runs.length) return;
  const now = Date.now();

  for (const r of runs) {
    const elapsed = now - r.s;
    if (elapsed >= LONG_TIMER_MS && S.longAsked !== r.s) {
      S.longAsked = r.s;
      const msg = `"${r.text}" has been running for ${M.fmtDur(r.base + elapsed)}. Still going?`;
      notify('Timer still running', msg);
      ask(msg, `Stop at ${M.fmtDur(LONG_TIMER_MS)}`, () => stopRunning(r.id, r.s + LONG_TIMER_MS));
    }
    const clock = M.fmtClock(r.base + now - r.s);
    const el = runEl.querySelector(`[data-clock="${r.id}"]`);
    if (el) el.textContent = clock;
    if (r === runs[runs.length - 1]) publishState(runs, now);
    if (S.view === 'day' && r.date === S.date) {
      const t = findTask(r.id);
      const ms = t ? M.taskMs(t, now) : 0;
      const live = viewEl.querySelector(`[data-live="${r.id}"]`);
      if (live) live.textContent = M.fmtDur(ms);
      const bar = viewEl.querySelector(`[data-live-bar="${r.id}"]`);
      if (bar && t?.target) bar.style.width = `${Math.min(100, (ms / (t.target * 60000)) * 100)}%`;
    }
  }
  document.title = runs.length > 1
    ? `▶ ${runs.length} timers running`
    : `▶ ${M.fmtClock(runs[0].base + now - runs[0].s)} · ${runs[0].text}`;

  if (S.view === 'day' && runs.some(r => r.date === S.date)) {
    const { total, byCat } = dayTotals(now);
    const tot = $('#day-total');
    if (tot) tot.textContent = M.fmtDur(total);
    viewEl.querySelectorAll('[data-cat-total]').forEach(e => { e.textContent = byCat[e.dataset.catTotal] ? M.fmtDur(byCat[e.dataset.catTotal]) : ''; });
    const rail = $('#rail');
    if (rail && Math.floor(now / 1000) % 15 === 0) rail.innerHTML = railHtml(now);
  }
  if (S.view === 'stats' && S.stats.days && Math.floor(now / 1000) % 30 === 0 && !tip.classList.contains('show')) render();
}

// Past midnight: move the view to the new day and split a running timer so its
// time lands on the day it was actually spent.
async function rollOver() {
  const prev = S.today;
  const today = M.todayKey();
  S.today = today;
  const runs = (S.settings?.running || []).filter(r => r.date === prev);
  if (S.settings && runs.length) {
    const midnight = M.parseKey(today).getTime();
    await stopRunning(null, midnight);
    for (const r of runs) {
      let id = null, base = 0;
      await mutateDay(today, d => {
        let x = d.tasks.find(t => M.normText(t.text) === M.normText(r.text));
        if (!x) { x = M.newTask(r.text, r.cat); d.tasks.push(x); }
        base = M.taskMs(x, midnight);
        x.sessions.push({ s: midnight, e: null });
        id = x.id;
      });
      S.settings.running.push({ date: today, id, text: r.text, cat: r.cat, base, s: midnight });
    }
    saveSettings();
    toast(`New day: ${runs.length > 1 ? 'the running timers continue' : 'the running timer continues'} here`);
  }
  if (S.date === prev) openDay(today); else render();
}

// Desktop/browser notification; on a phone this only arrives while the app is open.
function notify(title, body) {
  if (localStorage.getItem(NOTIFY_KEY) !== '1' || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag: 'dtl-timer' }); } catch { /* unsupported */ }
}

// ---------------- stats loading ----------------

async function loadStats() {
  const { to } = M.periodRange(S.stats.kind, S.stats.anchor);
  // From the start of the previous period, so the deltas have something to compare with.
  const { from } = M.periodRange(S.stats.kind, previousAnchor(S.stats.kind, S.stats.anchor));
  const want = `${from}|${to}`;
  S.stats.want = want;
  const days = await S.store.getDaysRange(from, to);
  if (S.stats.want !== want) return;
  S.stats.days = days;
  if (S.view === 'stats') render();
}

function showView(view) {
  S.view = view;
  hideTip();
  if (view === 'stats') loadStats();
  if (view === 'search') loadSearch();
  render();
  window.scrollTo(0, 0);
}

// Search across every day, filtered in the browser over one cached fetch.
async function loadSearch() {
  if (S.search.days || S.search.loading) return;
  S.search.loading = true;
  const days = await S.store.getDaysRange(M.addDays(M.todayKey(), -1095), M.addDays(M.todayKey(), 365));
  S.search = { ...S.search, days, loading: false };
  if (S.view === 'search') render();
}

function searchView() {
  const q = S.search.q.trim().toLowerCase();
  const days = (S.search.days || []).filter(d => d.date).sort((a, b) => b.date.localeCompare(a.date));
  const hits = q.length < 2 ? [] : days
    .map(d => ({ date: d.date, tasks: (d.tasks || []).filter(t => t.text.toLowerCase().includes(q)) }))
    .filter(d => d.tasks.length);
  const total = hits.reduce((a, d) => a + d.tasks.reduce((x, t) => x + M.taskMs(t), 0), 0);
  const count = hits.reduce((a, d) => a + d.tasks.length, 0);

  return `
    <div class="page narrow">
      <header class="viewhead"><h1>Search</h1></header>
      <form class="addbar" data-form="search" role="search">
        <input name="q" value="${esc(S.search.q)}" placeholder="Find a task in any day, e.g. etymology" autocomplete="off" aria-label="Search tasks">
        ${S.search.q ? '<button type="button" class="ghost" data-action="search-clear">Clear</button>' : ''}
      </form>
      ${S.search.loading && !S.search.days ? '<div class="loading">Loading your days…</div>' : ''}
      ${q.length < 2 ? '<p class="muted-note">Type at least two letters.</p>' : `
        <p class="muted small">${count} task${count === 1 ? '' : 's'} on ${hits.length} day${hits.length === 1 ? '' : 's'} · ${M.fmtDur(total)} tracked</p>
        ${hits.map(d => `
          <section class="card search-day">
            <div class="card-head">
              <h2>${esc(M.dayLabel(d.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</h2>
              <button class="linkish" data-action="search-open" data-date="${d.date}">Open day →</button>
            </div>
            <ul class="stat-tasks flat">
              ${d.tasks.map(t => {
                const cat = catById(t.cat);
                return `<li class="stat-task" style="${catVars(cat)}">
                  <span class="dot"></span>
                  <span class="stat-task-text">${t.done ? '<span class="muted">✓</span> ' : ''}${esc(t.text)}</span>
                  <span class="stat-task-val">${M.taskMs(t) ? M.fmtDur(M.taskMs(t)) : '–'}</span>
                </li>`;
              }).join('')}
            </ul>
          </section>`).join('') || '<p class="muted-note">Nothing found.</p>'}`}
    </div>`;
}

// ---------------- edit sheet ----------------

// Editable blocks. The end of a running block is blank; filling it in stops the
// timer. A block that started on an earlier day keeps its own date.
function sessionsHtml(sessions) {
  return sessions.map((s, i) => {
    const day = M.dateKey(new Date(s.s));
    const spans = M.dateKey(new Date(s.e ?? Date.now())) !== day;
    return `
      <li>
        <input class="time-input" type="text" inputmode="numeric" maxlength="5" value="${M.hhmm(new Date(s.s))}" data-sess="${i}" data-edge="from" aria-label="Start time">
        <span class="muted">–</span>
        <input class="time-input" type="text" inputmode="numeric" maxlength="5" value="${s.e ? M.hhmm(new Date(s.e)) : ''}" data-sess="${i}" data-edge="to" aria-label="End time" placeholder="running">
        <span class="muted small">${s.e ? M.fmtDur(s.e - s.s) : 'running'}${spans ? ' · next day' : ''}</span>
        <button type="button" class="icon small" data-sess-del="${i}" aria-label="Remove this time block">×</button>
      </li>`;
  }).join('');
}

function timeInputs(key, minutes) {
  const { from, to } = M.suggestBlock(key, minutes);
  return `
    <label>From<input class="time-input" type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" name="from" value="${from}" required></label>
    <label>To<input class="time-input" type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" name="to" value="${to}" required></label>`;
}

function openSheet(id) {
  const t = findTask(id);
  if (!t) return;
  const date = S.date;
  const draft = { adjust: t.adjust || 0, sessions: structuredClone(t.sessions) };
  const draftMs = () => M.taskMs({ sessions: draft.sessions, adjust: draft.adjust });
  sheet.innerHTML = `
    <form class="sheet-form">
      <h3>Edit task</h3>
      <label>Task<input name="text" value="${esc(t.text)}" required autocomplete="off"></label>
      <label>Category<select name="cat">${catOptions(catById(t.cat).id)}</select></label>
      <div class="sheet-row">
        <label>Planned minutes<input name="target" type="number" min="0" step="5" inputmode="numeric" value="${t.target ?? ''}" placeholder="none"></label>
        <label class="check-label"><input type="checkbox" name="repeat" ${t.repeat ? 'checked' : ''}> Repeat daily</label>
      </div>
      <div class="timebox">
        <div class="timebox-head">Time spent <strong id="sheet-time">${M.fmtDur(draftMs())}</strong></div>
        <ul class="sessions" id="sheet-sessions">${sessionsHtml(draft.sessions)}</ul>
        <div class="addblock">
          <span class="small">Forgot the timer? Add when you did it:</span>
          <div class="addblock-row">
            ${timeInputs(date, t.target).replaceAll('required', '').replace('name="from"', 'name="bfrom"').replace('name="to"', 'name="bto"')}
            <button type="button" class="ghost" data-sheet="addblock">+ Add</button>
          </div>
        </div>
        <div class="adj">
          <span class="small muted">Quick adjust</span>
          ${[-15, -5, 5, 15].map(m => `<button type="button" class="ghost" data-adj="${m}">${m > 0 ? '+' : '−'}${Math.abs(m)}m</button>`).join('')}
        </div>
      </div>
      <div class="sheet-actions">
        <button type="button" class="ghost danger" data-sheet="delete">Delete</button>
        <button type="button" class="ghost" data-sheet="backlog">To Wachtruimte</button>
        <span class="spacer"></span>
        <button type="button" class="ghost" data-sheet="cancel">Cancel</button>
        <button value="save" class="primary">Save</button>
      </div>
    </form>`;

  const form = sheet.querySelector('form');
  const textIn = form.elements.text, targetIn = form.elements.target;
  const parsedAtOpen = M.parseTarget(t.text);
  let targetTouched = false;
  targetIn.addEventListener('input', () => { targetTouched = true; });
  textIn.addEventListener('input', () => {
    if (!targetTouched && (t.target ?? null) === parsedAtOpen) targetIn.value = M.parseTarget(textIn.value) ?? '';
  });
  // Times typed into From/To count on Save even without pressing "+ Add".
  let blockDirty = false;
  form.elements.bfrom.addEventListener('input', () => { blockDirty = true; });
  form.elements.bto.addEventListener('input', () => { blockDirty = true; });
  const addDraftBlock = () => {
    const block = M.blockFromTimes(date, form.elements.bfrom.value, form.elements.bto.value);
    if (!block) return false;
    const open = draft.sessions.filter(s => s.e == null);
    draft.sessions = [...draft.sessions.filter(s => s.e != null), block].sort((a, b) => a.s - b.s).concat(open);
    blockDirty = false;
    return true;
  };
  const refreshTime = () => {
    $('#sheet-time').textContent = M.fmtDur(draftMs());
    $('#sheet-sessions').innerHTML = sessionsHtml(draft.sessions);
  };

  sheet.onchange = e => {
    if (e.target.classList?.contains('time-input')) {
      const tidy = M.normHHMM(e.target.value);
      if (tidy) e.target.value = tidy;
    }
    const input = e.target.closest?.('[data-sess]');
    if (!input) return;
    const at = +input.dataset.sess;
    const block = draft.sessions[at];
    if (!block) return;
    const dayOf = M.dateKey(new Date(block.s));
    if (input.dataset.edge === 'from') {
      const moved = M.blockFromTimes(dayOf, input.value, M.hhmm(new Date(block.e ?? Date.now())));
      if (moved) block.s = moved.s;
    } else if (!input.value) {
      block.e = null; // cleared: treat as still running
    } else {
      const ended = M.blockFromTimes(dayOf, M.hhmm(new Date(block.s)), input.value);
      if (ended) block.e = ended.e;
    }
    draft.sessions = draft.sessions.filter(b => b.e == null || b.e > b.s);
    refreshTime();
  };

  sheet.onclick = async e => {
    if (e.target === sheet) return sheet.close();
    const adj = e.target.closest('[data-adj]');
    if (adj) {
      const base = M.taskMs({ sessions: draft.sessions });
      draft.adjust = Math.max(-base, draft.adjust + (+adj.dataset.adj) * 60000);
      return refreshTime();
    }
    const del = e.target.closest('[data-sess-del]');
    if (del) {
      draft.sessions.splice(+del.dataset.sessDel, 1);
      return refreshTime();
    }
    const act = e.target.closest('[data-sheet]')?.dataset.sheet;
    if (act === 'addblock') {
      if (!addDraftBlock()) return toast('Pick a start and end time');
      return refreshTime();
    }
    if (act === 'cancel') sheet.close();
    if (act === 'delete') {
      if (isRunningTask(id)) await stopRunning(id);
      sheet.close();
      const date = S.date;
      const gone = structuredClone(findTask(id));
      const at = S.day.tasks.findIndex(x => x.id === id);
      await mutateDay(date, d => { d.tasks = d.tasks.filter(x => x.id !== id); });
      ask(`Deleted “${gone.text}”`, 'Undo', () => mutateDay(date, d => { d.tasks.splice(at, 0, gone); }));
    }
    if (act === 'backlog') {
      if (isRunningTask(id)) await stopRunning(id);
      S.settings.backlog.unshift({ id: M.uid(), text: t.text, cat: t.cat });
      saveSettings();
      sheet.close();
      await mutateDay(S.date, d => { d.tasks = d.tasks.filter(x => x.id !== id); });
      toast('Moved to Wachtruimte');
    }
  };

  // Save explicitly rather than via the dialog close event, which browsers may
  // defer in background tabs.
  form.onsubmit = e => {
    e.preventDefault();
    if (blockDirty) addDraftBlock();
    sheet.close();
    // Re-find the task: a snapshot may have replaced S.day while the sheet was open.
    const cur = findTask(id);
    if (!cur) return render();
    const text = textIn.value.trim() || cur.text;
    const cat = form.elements.cat.value;
    if (cat !== cur.cat) {
      S.settings.memory[M.normText(text)] = cat;
      offerLearn(text, cat);
    }
    const target = targetIn.value === '' ? null : Math.max(0, Math.round(+targetIn.value));
    // The sheet edits every block, so the draft wins. A block still open in the
    // draft takes the live copy, in case another device closed it meanwhile.
    const sessions = M.tidySessions(draft.sessions.map(b =>
      b.e != null ? { ...b } : ({ ...(cur.sessions.find(q => q.s === b.s) || b) })));
    // Typing an end time also stops the timer.
    if (!sessions.some(b => b.e == null)) S.settings.running = S.settings.running.filter(r => !(r.date === S.date && r.id === id));
    Object.assign(cur, { text, cat, target, repeat: form.elements.repeat.checked, adjust: draft.adjust, sessions });
    const run = runFor(id);
    if (run) Object.assign(run, { text, cat, base: M.taskMs({ ...cur, sessions: cur.sessions.slice(0, -1) }) });
    render();
    saveDay();
    saveSettings();
  };
  sheet.onclose = () => render();
  sheet.showModal();
}

// Full-height view of the day's sessions; overlapping timers sit side by side.
function openZoom() {
  const html = () => {
    const { total, overlap } = dayTotals();
    const sessions = (S.day?.tasks || []).reduce((n, t) => n + (t.sessions?.length || 0), 0);
    return `
      <div class="zoom-sheet">
        <header class="zoom-head">
          <div>
            <h3>${esc(M.dayLabel(S.date, { weekday: 'long', day: 'numeric', month: 'long' }))}</h3>
            <p class="zoom-sub">${M.fmtDur(total)} tracked · ${sessions} session${sessions === 1 ? '' : 's'}${overlap >= 60000 ? ` · <span class="warn">${M.fmtDur(overlap)} overlapping</span>` : ''}</p>
          </div>
          <button type="button" class="icon" data-sheet="cancel" aria-label="Close">×</button>
        </header>
        ${renderDayZoom(S.date, S.day?.tasks, S.settings.categories)}
        <footer class="zoom-foot"><span class="muted small">Click a block to edit that task</span></footer>
      </div>`;
  };
  sheet.className = 'zoom-dialog';
  sheet.innerHTML = html();
  sheet.onchange = null;
  sheet.onclick = e => {
    if (e.target === sheet || e.target.closest('[data-sheet=cancel]')) sheet.close();
  };
  sheet.onclose = () => { sheet.className = ''; render(); };
  sheet.showModal();
  // Scroll to the running block, or the last one of the day.
  const focus = sheet.querySelector('.zoom-block.live') || sheet.querySelector('.zoom-block:last-of-type');
  focus?.scrollIntoView({ block: 'center' });
  // Keep the running block growing while the view is open.
  const live = setInterval(() => {
    if (!sheet.open) return clearInterval(live);
    if (!S.settings.running.some(r => r.date === S.date)) return;
    const keep = sheet.querySelector('.zoom')?.scrollTop;
    sheet.innerHTML = html();
    if (keep) sheet.querySelector('.zoom').scrollTop = keep;
  }, 30000);
}

// Shown after checking off a task that has no logged time.
function openLogTime(id) {
  const t = findTask(id);
  if (!t) return;
  const date = S.date;
  sheet.innerHTML = `
    <form class="sheet-form">
      <h3>Log time?</h3>
      <p class="muted">No timer ran for <strong>${esc(t.text)}</strong>. When did you do it?</p>
      <div class="sheet-row times">${timeInputs(date, t.target)}<span class="muted" id="log-dur"></span></div>
      <div class="sheet-actions">
        <span class="spacer"></span>
        <button type="button" class="ghost" data-sheet="skip">Skip</button>
        <button class="primary">Log time</button>
      </div>
    </form>`;
  const form = sheet.querySelector('form');
  const showDur = () => {
    const b = M.blockFromTimes(date, form.elements.from.value, form.elements.to.value);
    $('#log-dur').textContent = b ? M.fmtDur(b.e - b.s) : '';
  };
  form.addEventListener('input', showDur);
  showDur();
  sheet.onclick = e => {
    if (e.target === sheet || e.target.closest('[data-sheet=skip]')) sheet.close();
  };
  form.onsubmit = async e => {
    e.preventDefault();
    const block = M.blockFromTimes(date, form.elements.from.value, form.elements.to.value);
    if (!block) return toast('Pick a start and end time');
    sheet.close();
    await mutateDay(date, d => {
      const x = d.tasks.find(x => x.id === id);
      if (!x) return;
      x.sessions = M.tidySessions([...x.sessions, block]);
    });
    toast(`Logged ${M.fmtDur(block.e - block.s)}`);
  };
  sheet.onclose = () => render();
  sheet.showModal();
  form.elements.from.focus();
}

// ---------------- stats tooltip ----------------

// Hover card for a chart column (data-bucket) or any element carrying a
// data-tip JSON { head, rows: [{ cat, ms }], total, note }.
function showTip(col) {
  let data;
  if (col.dataset.tip) {
    try { data = JSON.parse(col.dataset.tip); } catch { return; }
  } else {
    const st = S.stats.computed;
    const b = st?.buckets[+col.dataset.bucket];
    if (!b) return;
    data = { head: bucketName(st.kind, b.key), rows: Object.entries(b.byCat).map(([cat, ms]) => ({ cat, ms })), total: b.total };
  }
  tip.replaceChildren();
  const head = document.createElement('div');
  head.className = 'tip-head';
  head.textContent = data.head;
  tip.append(head);
  const rows = (data.rows || []).map(r => ({ cat: catById(r.cat), ms: r.ms })).filter(r => r.cat).sort((a, b) => b.ms - a.ms);
  for (const { cat, ms } of rows) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    row.style.setProperty('--cc', catColor(cat));
    row.style.setProperty('--cf', catFill(cat));
    const key = document.createElement('span'); key.className = 'tip-key';
    const val = document.createElement('strong'); val.textContent = M.fmtDur(ms);
    const name = document.createElement('span'); name.textContent = cat.name;
    row.append(key, val, name);
    tip.append(row);
  }
  const tot = document.createElement('div');
  tot.className = 'tip-total';
  tot.textContent = data.total ? `${rows.length ? 'Total ' : ''}${M.fmtDur(data.total)}` : 'Nothing tracked';
  tip.append(tot);
  if (data.note) {
    const note = document.createElement('div');
    note.className = 'tip-note';
    note.textContent = data.note;
    tip.append(note);
  }

  const r = col.getBoundingClientRect();
  tip.classList.add('show');
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  x = Math.max(8, Math.min(x, innerWidth - tw - 8));
  const y = Math.max(8, r.top - th - 8);
  tip.style.transform = `translate(${x}px, ${y}px)`;
  viewEl.querySelectorAll('.col.hover').forEach(c => c.classList.remove('hover'));
  col.classList.add('hover');
}

function hideTip() {
  tip.classList.remove('show');
  viewEl.querySelectorAll('.col.hover').forEach(c => c.classList.remove('hover'));
}

// ---------------- events ----------------

function syncGuess(input) {
  const sel = input.form.elements.cat;
  if (!sel.dataset.touched) sel.value = M.guessCategory(input.value, S.settings.memory, S.settings.categories);
}

// Offer to learn from a manual category change: move the keyword that caused
// the wrong guess (or the task's first meaningful word) to the chosen category.
function offerLearn(text, chosen) {
  const cats = S.settings.categories;
  const { cat: guessed, kw } = M.explainGuess(text, cats);
  if (guessed === chosen) return;
  const word = kw || M.learnableWord(text);
  const target = cats.find(c => c.id === chosen);
  if (!word || !target || chosen === M.FALLBACK_CAT) return;
  ask(`Always sort “${word}” into ${target.name}?`, 'Yes', () => {
    for (const c of S.settings.categories) c.keywords = (c.keywords || []).filter(k => k !== word);
    S.settings.categories.find(c => c.id === chosen).keywords.unshift(word);
    saveSettings();
    toast(`“${word}” now goes to ${target.name}`);
  });
}

// Restore a downloaded export. Only the days in the file are touched; every
// other day stays as it is. Nothing is written before the user confirms.
async function importBackup(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    banner("Couldn't read that file: it is not valid JSON.");
    return;
  }
  const b = M.parseBackup(data);
  if (b.error) { banner(b.error); return; }
  if (!b.days.length && !b.settings) { banner('Nothing to restore: that file holds no days and no settings.'); return; }
  clearBanner();

  const keys = b.days.map(d => d.date);
  let already = 0;
  if (keys.length) {
    const have = await S.store.getDaysRange(keys[0], keys.at(-1));
    const mine = new Set(have.filter(d => d.tasks?.length).map(d => d.date));
    already = keys.filter(k => mine.has(k)).length;
  }
  const notes = [
    `Restore ${b.days.length} day${b.days.length === 1 ? '' : 's'} from “${file.name}”?`,
    keys.length ? `${M.dayLabel(keys[0])} – ${M.dayLabel(keys.at(-1))}.` : '',
    already ? `${already} of those days already ${already === 1 ? 'has' : 'have'} tasks here and will be replaced.` : '',
    b.settings ? 'Your categories, keywords, backlog and learned choices are replaced too.' : '',
    b.closedRuns ? `${b.closedRuns} timer${b.closedRuns === 1 ? '' : 's'} still running in the file ${b.closedRuns === 1 ? 'is' : 'are'} stopped at the export time.` : '',
    b.skippedDays || b.skippedTasks || b.droppedBlocks ? `Skipping ${b.skippedDays} unreadable day(s), ${b.skippedTasks} task(s) and ${b.droppedBlocks} block(s).` : '',
    'Days that are not in the file are left alone. This cannot be undone.',
  ].filter(Boolean);
  if (!confirm(notes.join('\n\n'))) return;

  await stopRunning();
  let done = 0, failed = 0;
  // In batches, so a year of days doesn't take a round trip each.
  for (let i = 0; i < b.days.length; i += 10) {
    const batch = b.days.slice(i, i + 10);
    const results = await Promise.allSettled(batch.map(d => S.store.saveDay(d.date, d)));
    for (const r of results) {
      if (r.status === 'rejected') { failed++; console.error(r.reason); } else done++;
    }
    if (b.days.length > 10) banner(`Restoring… ${done + failed}/${b.days.length}`, 'warn');
  }
  if (b.settings) {
    S.settings = b.settings;
    try { await S.store.saveSettings(S.settings); } catch (err) { failed++; console.error(err); }
  }
  clearBanner();
  if (failed) banner(`Restored ${done} day${done === 1 ? '' : 's'}, but ${failed} write${failed === 1 ? '' : 's'} failed. Try again when you are back online.`);
  else toast(`Restored ${done} day${done === 1 ? '' : 's'}`);
  openDay(S.date);
}

// Sticky message for problems the user must see (save errors, offline).
function banner(msg, kind = 'error') {
  const el = $('#banner');
  el.textContent = msg;
  el.className = `show ${kind}`;
}
function clearBanner() { $('#banner').className = ''; }

function watchConnection() {
  const sync = () => (navigator.onLine ? clearBanner() : banner('Offline. Changes are saved on this device and sync when you reconnect.', 'warn'));
  addEventListener('online', sync);
  addEventListener('offline', sync);
  sync();
}

let askTimer;
function ask(msg, yesLabel, onYes) {
  const el = $('#ask');
  el.innerHTML = `<span>${esc(msg)}</span><button class="primary" data-ask="yes">${esc(yesLabel)}</button><button class="ghost" data-ask="no">No</button>`;
  el.classList.add('show');
  el.onclick = e => {
    const a = e.target.closest('[data-ask]')?.dataset.ask;
    if (!a) return;
    el.classList.remove('show');
    if (a === 'yes') onYes();
  };
  clearTimeout(askTimer);
  askTimer = setTimeout(() => el.classList.remove('show'), 12000);
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

document.addEventListener('click', async e => {
  const el = e.target?.closest?.('[data-action]');
  if (!el || sheet.contains(el)) return;
  const act = el.dataset.action;
  const id = el.closest('[data-id]')?.dataset.id;

  switch (act) {
    case 'sign-in':
      try { await S.fb.signIn(); } catch (err) {
        renderLogin(err.code === 'auth/operation-not-allowed' || err.code === 'auth/configuration-not-found'
          ? 'Google sign-in is not enabled yet: Firebase Console → Authentication → Sign-in method → Google → Enable.'
          : err.code === 'auth/popup-closed-by-user' ? '' : err.message);
      }
      break;
    case 'reload': location.reload(); break;
    case 'force-update': location.href = 'reset.html'; break;
    case 'sign-out': await stopRunning(); S.fb.signOut(); break;
    case 'view': showView(el.dataset.view); break;
    case 'day-shift': openDay(M.addDays(S.date, +el.dataset.dir)); break;
    case 'goto-today': openDay(M.todayKey()); break;
    case 'day-stats': S.stats.kind = 'day'; S.stats.anchor = S.date; S.stats.days = null; showView('stats'); break;
    case 'toggle-done': {
      const t = findTask(id);
      if (!t) break;
      if (!t.done && isRunningTask(id)) await stopRunning(id);
      await mutateDay(S.date, d => { const x = d.tasks.find(x => x.id === id); x.done = !x.done; });
      // Checked off without any logged time: ask when it happened.
      const x = findTask(id);
      if (x?.done && !M.taskMs(x)) openLogTime(id);
      break;
    }
    case 'toggle-timer':
      if (isRunningTask(id)) await stopRunning(id); else await startTimer(id);
      break;
    case 'stop-running': await stopRunning(el.dataset.id); break;
    case 'stop-all': await stopRunning(); break;
    case 'goto-running': {
      const r = S.settings.running.find(x => x.id === el.dataset.id) || S.settings.running[0];
      if (S.view !== 'day') S.view = 'day';
      if (r && r.date !== S.date) openDay(r.date); else render();
      break;
    }
    case 'edit': if (sheet.open) sheet.close(); openSheet(id); break;
    case 'zoom-day': openZoom(); break;
    case 'session-del': {
      const taskId = el.dataset.task, start = +el.dataset.s;
      if (!confirm('Delete this time block?')) break;
      await mutateDay(S.date, d => {
        const x = d.tasks.find(x => x.id === taskId);
        if (x) x.sessions = x.sessions.filter(q => q.s !== start || q.e == null);
      });
      break;
    }
    case 'copy-last': {
      const tasks = M.carryOver(S.lastBefore?.tasks || []);
      await mutateDay(S.date, d => { d.tasks = [...d.tasks, ...tasks]; });
      break;
    }
    case 'plan-next': {
      const next = M.addDays(S.date, 1);
      const existing = (await S.store.getDay(next)) ?? { tasks: [] };
      const have = new Set(existing.tasks.map(t => M.normText(t.text)));
      const add = M.carryOver(S.day?.tasks || []).filter(t => !have.has(M.normText(t.text)));
      await persist(S.store.saveDay(next, { tasks: [...existing.tasks, ...add] }), 'the next day');
      openDay(next);
      toast(add.length ? `${add.length} task${add.length > 1 ? 's' : ''} carried over. Edit away.` : 'Already planned');
      break;
    }
    case 'backlog-to-day': {
      const i = S.settings.backlog.findIndex(b => b.id === id);
      if (i < 0) break;
      const [b] = S.settings.backlog.splice(i, 1);
      saveSettings();
      await mutateDay(S.date, d => d.tasks.push(M.newTask(b.text, b.cat)));
      toast(`Added to ${M.relativeLabel(S.date) || M.dayLabel(S.date)}`);
      break;
    }
    case 'backlog-del':
      S.settings.backlog = S.settings.backlog.filter(b => b.id !== id);
      saveSettings(); render();
      break;
    case 'search-open': openDay(el.dataset.date); showView('day'); break;
    case 'search-clear': S.search.q = ''; render(); break;
    case 'stats-day':
      hideTip();
      S.stats.kind = 'day'; S.stats.anchor = el.dataset.date; S.stats.days = null; S.stats.expanded.clear(); loadStats(); render();
      break;
    case 'stats-range':
      S.stats.kind = el.dataset.range; S.stats.days = null; S.stats.expanded.clear(); loadStats(); render();
      break;
    case 'stats-shift':
      S.stats.anchor = M.shiftPeriod(S.stats.kind, S.stats.anchor, +el.dataset.dir); S.stats.days = null; loadStats(); render();
      break;
    case 'stats-toggle': {
      const c = el.dataset.cat;
      S.stats.expanded.has(c) ? S.stats.expanded.delete(c) : S.stats.expanded.add(c);
      render();
      break;
    }
    case 'cat-move': {
      const cats = S.settings.categories;
      const at = cats.findIndex(c => c.id === el.closest('[data-cat]').dataset.cat);
      const to = at + (+el.dataset.dir);
      if (to < 0 || to >= cats.length) break;
      cats.splice(to, 0, ...cats.splice(at, 1));
      saveSettings();
      render();
      break;
    }
    case 'cat-add': {
      S.settings.categories.push({ id: M.uid(), name: 'New category', emoji: '⭐', slot: M.freeSlot(S.settings.categories), keywords: [] });
      saveSettings(); render();
      break;
    }
    case 'cat-del': {
      const c = el.closest('[data-cat]').dataset.cat;
      const cat = catById(c);
      if (!confirm(`Delete "${cat.name}"? Its tasks will show under ${catById(M.FALLBACK_CAT).name}.`)) break;
      S.settings.categories = S.settings.categories.filter(x => x.id !== c);
      saveSettings(); render();
      break;
    }
    case 'export': {
      toast('Collecting your data…');
      const days = await S.store.getDaysRange('0000-01-01', '9999-12-31');
      const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), settings: S.settings, days }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `daily-task-list-${M.todayKey()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Downloaded ${days.length} day${days.length === 1 ? '' : 's'}`);
      break;
    }
    case 'import': $('#importfile').click(); break;
    case 'demo-reset':
      if (confirm('Clear all demo data?')) { localStorage.removeItem('dtl-demo'); location.reload(); }
      break;
  }
});

document.addEventListener('submit', async e => {
  const form = e.target?.closest?.('form[data-form]');
  if (!form) return;
  e.preventDefault();
  if (form.dataset.form === 'search') return;
  const text = form.elements.text.value.trim();
  if (!text) return;
  const touched = !!form.elements.cat.dataset.touched;
  // Unless a category was picked by hand, guess from the final text.
  const cat = touched ? form.elements.cat.value : M.guessCategory(text, S.settings.memory, S.settings.categories);
  if (touched) {
    S.settings.memory[M.normText(text)] = cat;
    offerLearn(text, cat);
  }
  form.elements.text.value = '';
  delete form.elements.cat.dataset.touched;
  if (form.dataset.form === 'add') {
    if (touched) saveSettings();
    await mutateDay(S.date, d => d.tasks.push(M.newTask(text, cat)));
  } else {
    S.settings.backlog.unshift({ id: M.uid(), text, cat });
    saveSettings(); render();
  }
  viewEl.querySelector(`form[data-form="${form.dataset.form}"] input[name=text]`)?.focus();
});

// Global shortcuts (ignored while typing or with a dialog open).
const VIEW_KEYS = { 1: 'day', 2: 'stats', 3: 'search', 4: 'backlog', 5: 'settings' };
document.addEventListener('keydown', e => {
  if (!S.settings || sheet.open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target?.closest?.('input, select, textarea')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (VIEW_KEYS[e.key]) return showView(VIEW_KEYS[e.key]);
  if (e.key === 'n') {
    e.preventDefault();
    if (S.view !== 'day' && S.view !== 'backlog') showView('day');
    viewEl.querySelector('form[data-form] input[name=text]')?.focus();
    return;
  }
  if (e.key === '/') {
    e.preventDefault();
    showView('search');
    viewEl.querySelector('input[name=q]')?.focus();
    return;
  }
  if (S.view !== 'day') return;
  if (e.key === 'ArrowLeft') return openDay(M.addDays(S.date, -1));
  if (e.key === 'ArrowRight') return openDay(M.addDays(S.date, 1));
  if (e.key === 't') return openDay(M.todayKey());

  // Task selection: j/k (or ↓/↑ with shift) move, space starts/stops its timer.
  const ids = (S.day?.tasks || []).map(t => t.id);
  if (!ids.length) return;
  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    const at = ids.indexOf(S.sel);
    S.sel = at < 0
      ? ids[e.key === 'j' ? 0 : ids.length - 1]
      : ids[Math.max(0, Math.min(ids.length - 1, at + (e.key === 'j' ? 1 : -1)))];
    render();
    viewEl.querySelector('.task.selected')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (!S.sel || !ids.includes(S.sel)) return;
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); isRunningTask(S.sel) ? stopRunning(S.sel) : startTimer(S.sel); }
  if (e.key === 'e') { e.preventDefault(); openSheet(S.sel); }
  if (e.key === 'x') { e.preventDefault(); viewEl.querySelector(`.task[data-id="${S.sel}"] .check`)?.click(); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing && e.target?.matches?.('form[data-form] input[name=text]')) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

let searchDebounce;
document.addEventListener('input', e => {
  if (!e.target?.matches) return;
  if (e.target.matches('form[data-form] input[name=text]')) syncGuess(e.target);
  if (e.target.matches('form[data-form=search] input[name=q]')) {
    S.search.q = e.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { const at = e.target.selectionStart; render(); const again = viewEl.querySelector('input[name=q]'); again?.focus(); again?.setSelectionRange(at, at); }, 200);
  }
});

document.addEventListener('change', e => {
  const el = e.target;
  if (!el?.matches) return;
  if (el.matches('form[data-form] select[name=cat]')) el.dataset.touched = '1';
  const kind = el.dataset.change;
  if (kind === 'pick-day' && el.value) openDay(el.value);
  if (kind === 'notify') {
    if (!el.checked) { localStorage.removeItem(NOTIFY_KEY); return; }
    Notification.requestPermission().then(p => {
      if (p === 'granted') { localStorage.setItem(NOTIFY_KEY, '1'); toast('Notifications on for this device'); }
      else { el.checked = false; toast('Your browser blocked notifications'); }
    });
  }
  if (kind === 'import-file') {
    const file = el.files?.[0];
    el.value = ''; // so picking the same file twice still fires
    importBackup(file);
  }
  if (kind === 'cat-field') {
    const cat = S.settings.categories.find(c => c.id === el.closest('[data-cat]').dataset.cat);
    const field = el.dataset.field;
    if (field === 'slot') {
      const slot = +el.value;
      const owner = S.settings.categories.find(o => o !== cat && o.slot === slot && slot !== 0);
      if (owner) owner.slot = cat.slot ?? 0; // swap so colors stay unique
      cat.slot = slot;
    } else if (field === 'keywords') {
      cat.keywords = [...new Set(el.value.split(',').map(k => k.trim().toLowerCase()).filter(Boolean))];
    } else {
      cat[field] = el.value;
      if (field === 'name' && !cat.keywords?.length) cat.keywords = M.presetKeywordsFor({ name: el.value });
    }
    saveSettings(); render();
  }
});

let dragId = null;
const clearDropMarks = () => viewEl.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));

viewEl.addEventListener('dragstart', e => {
  const li = e.target.closest('.task');
  if (!li) return;
  dragId = li.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
  li.classList.add('dragging');
});

viewEl.addEventListener('dragend', () => {
  dragId = null;
  clearDropMarks();
  viewEl.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
});

viewEl.addEventListener('dragover', e => {
  if (!dragId) return;
  const li = e.target.closest('.task');
  const sec = e.target.closest('.catsec');
  if (!li && !sec) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  if (li && li.dataset.id !== dragId) {
    const box = li.getBoundingClientRect();
    li.classList.add(e.clientY < box.top + box.height / 2 ? 'drop-before' : 'drop-after');
  } else if (sec && !li) {
    sec.querySelector('.tasks')?.lastElementChild?.classList.add('drop-after');
  }
});

viewEl.addEventListener('drop', async e => {
  if (!dragId) return;
  e.preventDefault();
  const id = dragId;
  const li = e.target.closest('.task');
  const sec = e.target.closest('.catsec');
  const cat = sec?.dataset.cat;
  const marked = viewEl.querySelector('.drop-before, .drop-after');
  const before = marked?.classList.contains('drop-before');
  const refId = marked?.dataset.id;
  clearDropMarks();
  dragId = null;
  if (!cat || (li && li.dataset.id === id)) return;
  await mutateDay(S.date, d => {
    const from = d.tasks.findIndex(t => t.id === id);
    if (from < 0) return;
    const [moved] = d.tasks.splice(from, 1);
    moved.cat = cat;
    const refAt = refId && refId !== id ? d.tasks.findIndex(t => t.id === refId) : -1;
    if (refAt < 0) d.tasks.push(moved);
    else d.tasks.splice(before ? refAt : refAt + 1, 0, moved);
  });
});

viewEl.addEventListener('pointerover', e => { const col = e.target.closest('.col, [data-tip]'); if (col) showTip(col); });
viewEl.addEventListener('pointerleave', hideTip);
viewEl.addEventListener('focusin', e => { const col = e.target.closest('.col, [data-tip]'); if (col) showTip(col); });
viewEl.addEventListener('focusout', hideTip);
addEventListener('scroll', hideTip, { passive: true });

setInterval(tick, 1000);
watchConnection();
boot();

// Demo-only hook so the day-rollover path can be exercised in tests.
if (DEMO) window.__dtl = { S, rollOver };

// Offline shell. Skipped during local development so edits are never served stale.
if ("serviceWorker" in navigator) {
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  addEventListener("load", () => {
    if (local) navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
    else navigator.serviceWorker.register("sw.js").catch(err => console.warn("Service worker failed:", err));
  });
}
