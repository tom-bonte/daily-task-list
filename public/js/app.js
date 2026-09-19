import * as M from './model.js';
import { computeStats, renderStats, categoryBars, bucketName } from './stats.js';
import { esc, catColor, renderTimeline, SLOT_NAMES } from './ui.js';

const DEMO = new URLSearchParams(location.search).has('demo');

const S = {
  fb: null, store: null, user: null,
  settings: null,
  date: M.todayKey(), day: null, dayLoaded: false, lastBefore: undefined,
  view: 'day',
  stats: { kind: 'day', anchor: M.todayKey(), days: null, expanded: new Set() },
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
  S.fb.onUser(user => {
    stop();
    S.user = user;
    if (!user) return renderLogin();
    S.store = S.fb.createFirestoreStore(user.uid);
    start();
  });
}

function renderLogin(error) {
  document.body.classList.add('logged-out');
  viewEl.innerHTML = `
    <div class="login">
      <h1>Daily Task List</h1>
      <p class="muted">Plan your day, time your tasks, see where the hours go.</p>
      <button class="primary big" data-action="sign-in">Sign in with Google</button>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <p class="muted small"><a href="?demo">Try demo mode</a> (stored in this browser only)</p>
    </div>`;
}

function start() {
  document.body.classList.remove('logged-out');
  S.unsub.push(S.store.watchSettings(s => {
    const first = !S.settings;
    S.settings = M.withDefaults(s);
    if (!s) saveSettings(); // first run: persist the preset categories + backlog
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

function saveSettings() {
  return S.store.saveSettings(S.settings);
}

function saveDay() {
  return S.store.saveDay(S.date, S.day);
}

// Apply fn to a day's data and persist it, whether or not that day is on screen.
async function mutateDay(key, fn) {
  if (key === S.date) {
    S.day ??= { tasks: [] };
    fn(S.day);
    render();
    await saveDay();
  } else {
    const d = (await S.store.getDay(key)) ?? { tasks: [] };
    fn(d);
    await S.store.saveDay(key, d);
  }
}

const catById = id => S.settings.categories.find(c => c.id === id)
  || S.settings.categories.find(c => c.id === M.FALLBACK_CAT)
  || S.settings.categories[0];
const findTask = id => S.day?.tasks.find(t => t.id === id);

// ---------------- timers ----------------

async function stopRunning(now = Date.now()) {
  const r = S.settings.running;
  if (!r) return;
  S.settings.running = null;
  saveSettings();
  await mutateDay(r.date, d => {
    const last = d.tasks.find(t => t.id === r.id)?.sessions.at(-1);
    if (last && last.e == null) last.e = now;
  });
}

async function startTimer(id) {
  const now = Date.now();
  await stopRunning(now);
  const t = findTask(id);
  if (!t) return;
  t.sessions.push({ s: now, e: null });
  S.settings.running = { date: S.date, id, text: t.text, cat: t.cat, base: M.taskMs(t, now), s: now };
  render();
  await saveDay();
  saveSettings();
}

const isRunningTask = id => S.settings.running?.date === S.date && S.settings.running?.id === id;

// ---------------- rendering ----------------

function render() {
  if (!S.settings) { viewEl.innerHTML = '<div class="loading">Loading…</div>'; return; }
  const add = viewEl.querySelector('form[data-form] input[name=text]');
  const keep = add && { form: add.form.dataset.form, value: add.value, focused: document.activeElement === add };

  viewEl.innerHTML = S.view === 'day' ? dayView()
    : S.view === 'stats' ? statsView()
    : `<div class="page narrow">${S.view === 'backlog' ? backlogView() : settingsView()}</div>`;

  if (keep) {
    const again = viewEl.querySelector(`form[data-form="${keep.form}"] input[name=text]`);
    if (again && keep.value) { again.value = keep.value; syncGuess(again); }
    if (again && keep.focused) again.focus();
  }
  $('#nav-foot').textContent = S.user?.email || '';
  navEl.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-current', b.dataset.view === S.view ? 'page' : 'false'));
  renderRunbar();
}

function catOptions(selected) {
  return S.settings.categories.map(c => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.emoji || '')} ${esc(c.name)}</option>`).join('');
}

function dayTotals(now = Date.now()) {
  const byCat = {};
  let total = 0;
  for (const t of S.day?.tasks || []) {
    const ms = M.taskMs(t, now);
    const cat = catById(t.cat).id;
    byCat[cat] = (byCat[cat] || 0) + ms;
    total += ms;
  }
  return { total, byCat };
}

function dayView() {
  const tasks = S.day?.tasks || [];
  const rel = M.relativeLabel(S.date);
  const { total, byCat } = dayTotals();
  const done = tasks.filter(t => t.done).length;
  const next = M.addDays(S.date, 1);

  const sections = S.settings.categories.map(cat => {
    const items = tasks.filter(t => catById(t.cat).id === cat.id);
    if (!items.length) return '';
    return `
      <section class="catsec" style="--cc:${catColor(cat)}">
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
          <p class="muted small">Copies repeating and unfinished tasks.</p>` : '<p class="muted small">Add your first task above.</p>'}
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
          <div class="tile"><span class="tile-label">Tracked</span><span class="tile-value" id="day-total">${M.fmtDur(total)}</span></div>
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

// Right-hand panel of the day view: live category split, timeline, backlog.
function railHtml(now = Date.now()) {
  const cats = S.settings.categories;
  const st = computeStats(S.day ? [{ ...S.day, date: S.date }] : [], cats, 'day', S.date, now);
  const backlog = S.settings.backlog.slice(0, 5);
  return `
    <section class="card">
      <div class="card-head"><h2>Time by category</h2><button class="linkish" data-action="day-stats">Stats →</button></div>
      ${categoryBars(st, null, false)}
    </section>
    <section class="card">
      <h2>Timeline</h2>
      ${renderTimeline(S.date, S.day?.tasks, cats, now)}
    </section>
    <section class="card">
      <div class="card-head"><h2>Wachtruimte</h2><button class="linkish" data-action="view" data-view="backlog">All ${S.settings.backlog.length} →</button></div>
      ${backlog.length ? `<ul class="mini-backlog">${backlog.map(b => `
        <li data-id="${b.id}" style="--cc:${catColor(catById(b.cat))}">
          <span class="dot"></span><span class="task-text">${esc(b.text)}</span>
          <button class="icon small" data-action="backlog-to-day" aria-label="Add ${esc(b.text)} to this day" title="Add to this day">+</button>
        </li>`).join('')}</ul>` : '<p class="muted-note">Empty.</p>'}
    </section>`;
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
    <li class="task ${t.done ? 'done' : ''} ${running ? 'running' : ''}" data-id="${t.id}">
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
  const r = S.settings?.running;
  if (!r) { runEl.innerHTML = ''; runEl.hidden = true; document.title = 'Daily Task List'; return; }
  const cat = catById(r.cat);
  runEl.hidden = false;
  runEl.style.setProperty('--cc', catColor(cat));
  runEl.innerHTML = `
    <button class="run-info" data-action="goto-running">
      <span class="pulse" aria-hidden="true"></span>
      <span class="run-text">${esc(r.text)}</span>
      <span class="run-cat">${esc(cat.name)}${r.date !== M.todayKey() ? ` · ${esc(M.dayLabel(r.date))}` : ''}</span>
    </button>
    <span class="run-clock" id="run-clock">${M.fmtClock(r.base + Date.now() - r.s)}</span>
    <button class="play on" data-action="stop-running" aria-label="Pause timer">${PAUSE}</button>`;
}

function statsView() {
  const st = S.stats;
  if (!st.days) return `<header class="viewhead"><h1>Stats</h1></header><div class="loading">Loading…</div>`;
  st.computed = computeStats(st.days, S.settings.categories, st.kind, st.anchor);
  return renderStats(st.computed, S.settings.categories, st.expanded, st.days);
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
          <li data-id="${b.id}" style="--cc:${catColor(cat)}">
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
      <p class="muted small">New tasks are sorted automatically based on their words. When you change a task's category, the app remembers it next time.
        Tasks that fit nowhere go to <strong>${esc(catById(M.FALLBACK_CAT).name)}</strong>.</p>
      <ul class="cat-edit">
        ${cats.map(c => `
          <li data-cat="${esc(c.id)}" style="--cc:${catColor(c)}">
            <input class="emoji" data-change="cat-field" data-field="emoji" value="${esc(c.emoji || '')}" aria-label="Emoji">
            <input data-change="cat-field" data-field="name" value="${esc(c.name)}" aria-label="Name">
            <span class="dot"></span>
            <select data-change="cat-field" data-field="slot" aria-label="Color">
              ${SLOT_NAMES.map((n, i) => `<option value="${i}" ${i === (c.slot ?? 0) ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
            ${c.id === M.FALLBACK_CAT ? '<span class="icon"></span>' : `<button class="icon" data-action="cat-del" aria-label="Delete ${esc(c.name)}">×</button>`}
          </li>`).join('')}
      </ul>
      <button class="ghost" data-action="cat-add">+ Add category</button>
    </section>
    <section class="card">
      <h2>Account</h2>
      <p>${esc(S.user?.email || '')}</p>
      ${DEMO
        ? '<p class="muted small">Demo data lives only in this browser.</p><button class="ghost" data-action="demo-reset">Clear demo data</button> <a class="ghost btnlink" href="./">Leave demo</a>'
        : '<button class="ghost" data-action="sign-out">Sign out</button>'}
    </section>`;
}

// Live-update only the ticking numbers, once a second.
function tick() {
  const r = S.settings?.running;
  if (!r) return;
  const now = Date.now();
  const clock = M.fmtClock(r.base + now - r.s);
  const el = $('#run-clock');
  if (el) el.textContent = clock;
  document.title = `▶ ${clock} · ${r.text}`;

  if (S.view === 'day' && r.date === S.date) {
    const t = findTask(r.id);
    if (!t) return;
    const ms = M.taskMs(t, now);
    const live = viewEl.querySelector(`[data-live="${r.id}"]`);
    if (live) live.textContent = M.fmtDur(ms);
    const bar = viewEl.querySelector(`[data-live-bar="${r.id}"]`);
    if (bar && t.target) bar.style.width = `${Math.min(100, (ms / (t.target * 60000)) * 100)}%`;
    const { total, byCat } = dayTotals(now);
    const tot = $('#day-total');
    if (tot) tot.textContent = M.fmtDur(total);
    viewEl.querySelectorAll('[data-cat-total]').forEach(e => { e.textContent = byCat[e.dataset.catTotal] ? M.fmtDur(byCat[e.dataset.catTotal]) : ''; });
    const rail = $('#rail');
    if (rail && Math.floor(now / 1000) % 15 === 0) rail.innerHTML = railHtml(now);
  }
  if (S.view === 'stats' && S.stats.days && Math.floor(now / 1000) % 30 === 0 && !tip.classList.contains('show')) render();
}

// ---------------- stats loading ----------------

async function loadStats() {
  const { from, to } = M.periodRange(S.stats.kind, S.stats.anchor);
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
  render();
  window.scrollTo(0, 0);
}

// ---------------- edit sheet ----------------

function openSheet(id) {
  const t = findTask(id);
  if (!t) return;
  const draft = { adjust: t.adjust || 0 };
  const sessions = t.sessions.map(s => `<li>${M.fmtTime(s.s)} – ${s.e ? M.fmtTime(s.e) : 'now'}<span class="muted"> · ${M.fmtDur((s.e ?? Date.now()) - s.s)}</span></li>`).join('');
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
        <div>Time spent <strong id="sheet-time">${M.fmtDur(M.taskMs(t))}</strong></div>
        <div class="adj">
          ${[-15, -5, 5, 15].map(m => `<button type="button" class="ghost" data-adj="${m}">${m > 0 ? '+' : '−'}${Math.abs(m)}m</button>`).join('')}
        </div>
        <p class="muted small">Forgot the timer? Add the time here.</p>
        ${sessions ? `<ul class="sessions">${sessions}</ul>` : ''}
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

  sheet.onclick = async e => {
    if (e.target === sheet) return sheet.close();
    const adj = e.target.closest('[data-adj]');
    if (adj) {
      const base = M.taskMs({ ...t, adjust: 0 });
      draft.adjust = Math.max(-base, draft.adjust + (+adj.dataset.adj) * 60000);
      $('#sheet-time').textContent = M.fmtDur(base + draft.adjust);
      return;
    }
    const act = e.target.closest('[data-sheet]')?.dataset.sheet;
    if (act === 'cancel') sheet.close();
    if (act === 'delete') {
      if (isRunningTask(id)) await stopRunning();
      sheet.close();
      await mutateDay(S.date, d => { d.tasks = d.tasks.filter(x => x.id !== id); });
    }
    if (act === 'backlog') {
      if (isRunningTask(id)) await stopRunning();
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
    sheet.close();
    // Re-find the task: a snapshot may have replaced S.day while the sheet was open.
    const cur = findTask(id);
    if (!cur) return render();
    const text = textIn.value.trim() || cur.text;
    const cat = form.elements.cat.value;
    if (cat !== cur.cat) S.settings.memory[M.normText(text)] = cat;
    const target = targetIn.value === '' ? null : Math.max(0, Math.round(+targetIn.value));
    Object.assign(cur, { text, cat, target, repeat: form.elements.repeat.checked, adjust: draft.adjust });
    if (isRunningTask(id)) Object.assign(S.settings.running, { text, cat, base: M.taskMs({ ...cur, sessions: cur.sessions.slice(0, -1) }) });
    render();
    saveDay();
    saveSettings();
  };
  sheet.onclose = () => render();
  sheet.showModal();
}

// ---------------- stats tooltip ----------------

function showTip(col) {
  const st = S.stats.computed;
  const b = st?.buckets[+col.dataset.bucket];
  if (!b) return;
  tip.replaceChildren();
  const head = document.createElement('div');
  head.className = 'tip-head';
  head.textContent = bucketName(st.kind, b.key);
  tip.append(head);
  const rows = S.settings.categories.filter(c => b.byCat[c.id]).sort((a, c) => b.byCat[c.id] - b.byCat[a.id]);
  for (const c of rows) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    row.style.setProperty('--cc', catColor(c));
    const key = document.createElement('span'); key.className = 'tip-key';
    const val = document.createElement('strong'); val.textContent = M.fmtDur(b.byCat[c.id]);
    const name = document.createElement('span'); name.textContent = c.name;
    row.append(key, val, name);
    tip.append(row);
  }
  const tot = document.createElement('div');
  tot.className = 'tip-total';
  tot.textContent = b.total ? `Total ${M.fmtDur(b.total)}` : 'Nothing tracked';
  tip.append(tot);

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

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
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
    case 'sign-out': await stopRunning(); S.fb.signOut(); break;
    case 'view': showView(el.dataset.view); break;
    case 'day-shift': openDay(M.addDays(S.date, +el.dataset.dir)); break;
    case 'goto-today': openDay(M.todayKey()); break;
    case 'day-stats': S.stats.kind = 'day'; S.stats.anchor = S.date; S.stats.days = null; showView('stats'); break;
    case 'toggle-done': {
      const t = findTask(id);
      if (!t) break;
      if (!t.done && isRunningTask(id)) await stopRunning();
      await mutateDay(S.date, d => { const x = d.tasks.find(x => x.id === id); x.done = !x.done; });
      break;
    }
    case 'toggle-timer':
      if (isRunningTask(id)) await stopRunning(); else await startTimer(id);
      break;
    case 'stop-running': await stopRunning(); break;
    case 'goto-running':
      if (S.view !== 'day') S.view = 'day';
      if (S.settings.running.date !== S.date) openDay(S.settings.running.date); else render();
      break;
    case 'edit': openSheet(id); break;
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
      await S.store.saveDay(next, { tasks: [...existing.tasks, ...add] });
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
    case 'cat-add': {
      const used = new Set(S.settings.categories.map(c => c.slot));
      const slot = [1, 2, 3, 4, 5, 6, 7, 8].find(s => !used.has(s)) ?? 0;
      S.settings.categories.push({ id: M.uid(), name: 'New category', emoji: '⭐', slot });
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
    case 'demo-reset':
      if (confirm('Clear all demo data?')) { localStorage.removeItem('dtl-demo'); location.reload(); }
      break;
  }
});

document.addEventListener('submit', async e => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const text = form.elements.text.value.trim();
  if (!text) return;
  const cat = form.elements.cat.value;
  const touched = !!form.elements.cat.dataset.touched;
  if (touched) S.settings.memory[M.normText(text)] = cat;
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
const VIEW_KEYS = { 1: 'day', 2: 'stats', 3: 'backlog', 4: 'settings' };
document.addEventListener('keydown', e => {
  if (!S.settings || sheet.open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, select, textarea')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (VIEW_KEYS[e.key]) return showView(VIEW_KEYS[e.key]);
  if (e.key === 'n' || e.key === '/') {
    e.preventDefault();
    if (S.view !== 'day' && S.view !== 'backlog') showView('day');
    viewEl.querySelector('form[data-form] input[name=text]')?.focus();
    return;
  }
  if (S.view !== 'day') return;
  if (e.key === 'ArrowLeft') openDay(M.addDays(S.date, -1));
  if (e.key === 'ArrowRight') openDay(M.addDays(S.date, 1));
  if (e.key === 't') openDay(M.todayKey());
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing && e.target.matches('form[data-form] input[name=text]')) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

document.addEventListener('input', e => {
  if (e.target.matches('form[data-form] input[name=text]')) syncGuess(e.target);
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.matches('form[data-form] select[name=cat]')) el.dataset.touched = '1';
  const kind = el.dataset.change;
  if (kind === 'pick-day' && el.value) openDay(el.value);
  if (kind === 'cat-field') {
    const cat = S.settings.categories.find(c => c.id === el.closest('[data-cat]').dataset.cat);
    cat[el.dataset.field] = el.dataset.field === 'slot' ? +el.value : el.value;
    saveSettings(); render();
  }
});

viewEl.addEventListener('pointerover', e => { const col = e.target.closest('.col'); if (col) showTip(col); });
viewEl.addEventListener('pointerleave', hideTip);
viewEl.addEventListener('focusin', e => { const col = e.target.closest('.col'); if (col) showTip(col); });
viewEl.addEventListener('focusout', hideTip);
addEventListener('scroll', hideTip, { passive: true });

setInterval(tick, 1000);
boot();
