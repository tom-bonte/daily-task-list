// Statistics: aggregation (pure) + HTML rendering for the Stats view.
import { taskMs, normText, periodRange, periodLabel, addDays, parseKey, dayLabel, fmtDur, fmtMin, todayKey, FALLBACK_CAT } from './model.js';
import { esc, catVars, catFill, renderTimeline } from './ui.js';

export const RANGES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];

export function computeStats(days, categories, kind, anchor, now = Date.now()) {
  const { from, to } = periodRange(kind, anchor);
  const known = new Set(categories.map(c => c.id));
  const bucketKey = date => (kind === 'year' ? date.slice(0, 7) : date);

  // Empty buckets for every day (or month) so gaps show as gaps.
  const buckets = [];
  if (kind === 'year') {
    for (let m = 0; m < 12; m++) buckets.push({ key: `${from.slice(0, 4)}-${String(m + 1).padStart(2, '0')}`, byCat: {}, total: 0 });
  } else {
    for (let k = from; k <= to; k = addDays(k, 1)) buckets.push({ key: k, byCat: {}, total: 0 });
  }
  const bucketMap = new Map(buckets.map(b => [b.key, b]));

  const byCat = {};
  const tasks = new Map();
  let total = 0, done = 0, planned = 0;
  const activeDays = new Set();

  for (const day of days) {
    if (day.date < from || day.date > to) continue;
    for (const t of day.tasks || []) {
      const cat = known.has(t.cat) ? t.cat : FALLBACK_CAT;
      planned++;
      if (t.done) done++;
      const ms = taskMs(t, now);
      const key = `${cat}|${normText(t.text) || t.text.toLowerCase()}`;
      const entry = tasks.get(key) || { text: t.text, cat, ms: 0, target: 0, days: new Set(), done: 0 };
      entry.ms += ms;
      entry.target += t.target || 0;
      entry.done += t.done ? 1 : 0;
      if (ms) entry.days.add(day.date);
      tasks.set(key, entry);
      if (!ms) continue;
      total += ms;
      activeDays.add(day.date);
      byCat[cat] = (byCat[cat] || 0) + ms;
      const b = bucketMap.get(bucketKey(day.date));
      if (b) { b.byCat[cat] = (b.byCat[cat] || 0) + ms; b.total += ms; }
    }
  }

  const catRows = categories
    .map(c => ({ cat: c, ms: byCat[c.id] || 0 }))
    .filter(r => r.ms > 0)
    .sort((a, b) => b.ms - a.ms);

  const taskRows = [...tasks.values()].sort((a, b) => b.ms - a.ms || b.done - a.done);

  return { kind, anchor, from, to, total, done, planned, activeDays: activeDays.size, catRows, taskRows, buckets };
}

export function renderStats(st, categories, expanded, days = []) {
  const catById = Object.fromEntries(categories.map(c => [c.id, c]));
  const isDay = st.kind === 'day';

  const tabs = RANGES.map(([k, label]) =>
    `<button class="seg ${k === st.kind ? 'on' : ''}" data-action="stats-range" data-range="${k}" aria-pressed="${k === st.kind}">${label}</button>`).join('');

  const top = st.catRows[0];
  const tiles = [
    ['Tracked', fmtDur(st.total), isDay ? '' : `${st.activeDays} active day${st.activeDays === 1 ? '' : 's'}`],
    isDay
      ? ['Planned', fmtDur(st.taskRows.reduce((a, t) => a + t.target, 0) * 60000), 'from task durations']
      : ['Per active day', st.activeDays ? fmtDur(st.total / st.activeDays) : '–', 'average'],
    ['Tasks done', `${st.done}/${st.planned}`, st.planned ? `${Math.round((st.done / st.planned) * 100)}%` : ''],
    ['Top category', top ? `${esc(top.cat.emoji || '')} ${esc(top.cat.name)}` : '–', top ? fmtDur(top.ms) : ''],
  ].map(([label, value, sub]) => `
    <div class="tile"><span class="tile-label">${label}</span><span class="tile-value">${value}</span><span class="tile-sub">${sub}</span></div>`).join('');

  const right = isDay
    ? `<section class="card"><h2>Timeline</h2>${renderTimeline(st.anchor, days.find(d => d.date === st.anchor)?.tasks, categories, Date.now(), 20)}</section>`
    : chart(st, categories, catById);

  const rows = st.taskRows.filter(t => t.ms > 0 || t.done);
  const untracked = rows.filter(t => !t.ms).length;

  return `
    <div class="page">
      <header class="pagehead">
        <h1>Stats</h1>
        <div class="stats-controls">
          <div class="periodnav">
            <button class="icon" data-action="stats-shift" data-dir="-1" aria-label="Previous period">‹</button>
            <span>${esc(periodLabel(st.kind, st.anchor))}</span>
            <button class="icon" data-action="stats-shift" data-dir="1" aria-label="Next period">›</button>
          </div>
          <div class="segs" role="group" aria-label="Period">${tabs}</div>
        </div>
      </header>
      <div class="tiles">${tiles}</div>
      <div class="stats-grid">
        <section class="card">
          <h2>By category</h2>
          ${categoryBars(st, expanded, true)}
        </section>
        ${right}
      </div>
      <section class="card">
        <h2>${isDay ? 'Tasks' : 'Tasks in this period'}</h2>
        ${rows.length ? `
          <div class="table-scroll"><table class="datatable">
            <thead><tr><th>Task</th><th>Category</th>${isDay ? '' : '<th class="num">Days</th>'}<th class="num">Planned</th><th class="num">Tracked</th><th class="bar-col"><span class="sr-only">Progress</span></th></tr></thead>
            <tbody>${rows.slice(0, 60).map(t => {
              const cat = catById[t.cat];
              const pct = t.target ? Math.min(100, (t.ms / (t.target * 60000)) * 100) : null;
              return `<tr style="${catVars(cat)}">
                <td>${esc(t.text)}${t.done ? ' <span class="muted">✓</span>' : ''}</td>
                <td><span class="dot"></span> ${esc(cat?.name || '')}</td>
                ${isDay ? '' : `<td class="num">${t.days.size || '–'}</td>`}
                <td class="num muted">${t.target ? fmtMin(t.target) : '–'}</td>
                <td class="num"><strong>${t.ms ? fmtDur(t.ms) : '–'}</strong></td>
                <td class="bar-col">${pct != null ? `<span class="progress"><span style="width:${pct}%"></span></span>` : ''}</td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>
          ${untracked ? `<p class="muted-note">${untracked} task${untracked > 1 ? 's' : ''} done without a timer.</p>` : ''}`
        : '<p class="muted-note">Nothing tracked yet.</p>'}
      </section>
    </div>`;
}

// Category bars; interactive rows expand to the tasks behind them.
export function categoryBars(st, expanded, interactive) {
  if (!st.catRows.length) return `<p class="muted-note">No time tracked ${st.kind === 'day' ? 'this day' : 'in this period'} yet.</p>`;
  const maxCat = st.catRows[0].ms;
  const Tag = interactive ? 'button' : 'div';
  return `<ul class="stat-list">${st.catRows.map(({ cat, ms }) => {
    const open = interactive && expanded.has(cat.id);
    const rows = open ? st.taskRows.filter(t => t.cat === cat.id && t.ms > 0).map(t => `
      <li class="stat-task"><span class="stat-task-text">${esc(t.text)}</span><span class="stat-task-val">${fmtDur(t.ms)}</span></li>`).join('') : '';
    return `
      <li>
        <${Tag} class="stat-row ${interactive ? '' : 'static'}" ${interactive ? `data-action="stats-toggle" data-cat="${esc(cat.id)}" aria-expanded="${open}"` : ''} style="${catVars(cat)}">
          <span class="stat-name"><span class="dot"></span><span class="emoji">${esc(cat.emoji || '')}</span><span class="ellipsis">${esc(cat.name)}</span></span>
          <span class="bar-track"><span class="bar" style="width:${(ms / maxCat) * 100}%"></span></span>
          <span class="stat-val">${fmtDur(ms)}</span>
          <span class="stat-pct">${Math.round((ms / st.total) * 100)}%</span>
        </${Tag}>
        ${open ? `<ul class="stat-tasks">${rows}</ul>` : ''}
      </li>`;
  }).join('')}</ul>`;
}


// Stacked columns: one column per day (per month for Year), segments per category.
function chart(st, categories, catById) {
  const maxMs = Math.max(...st.buckets.map(b => b.total), 0);
  if (!maxMs) return '';
  const stepH = [0.5, 1, 2, 3, 4, 6, 8, 12, 24, 48, 100, 200].find(h => maxMs / (h * 3600000) <= 4);
  const top = Math.ceil(maxMs / (stepH * 3600000)) * stepH;
  const ticks = [];
  for (let h = 0; h <= top + 1e-9; h += stepH) ticks.push(h);
  const present = categories.filter(c => st.catRows.some(r => r.cat.id === c.id));
  const today = todayKey();

  const label = (b, i) => {
    if (st.kind === 'year') return parseKey(`${b.key}-01`).toLocaleDateString('en-GB', { month: 'narrow' });
    if (st.kind === 'week') return dayLabel(b.key, { weekday: 'short' });
    const d = +b.key.slice(8);
    return d === 1 || d % 5 === 0 ? String(d) : '';
  };

  const cols = st.buckets.map((b, i) => {
    const segs = categories.filter(c => b.byCat[c.id]).map(c =>
      `<span class="seg-fill" style="flex-grow:${b.byCat[c.id]};background:${catFill(c)}"></span>`).join('');
    const current = st.kind === 'year' ? today.startsWith(b.key) : b.key === today;
    return `
      <div class="col ${current ? 'current' : ''}" data-bucket="${i}" tabindex="0" aria-label="${esc(bucketName(st.kind, b.key))}: ${fmtDur(b.total)}">
        <div class="col-plot"><div class="col-stack" style="height:${(b.total / (top * 3600000)) * 100}%">${segs}</div></div>
        <div class="col-label">${label(b, i)}</div>
      </div>`;
  }).join('');

  const tableRows = st.buckets.filter(b => b.total).map(b =>
    `<tr><th scope="row">${esc(bucketName(st.kind, b.key))}</th>${present.map(c => `<td>${b.byCat[c.id] ? fmtDur(b.byCat[c.id]) : '–'}</td>`).join('')}<td><strong>${fmtDur(b.total)}</strong></td></tr>`).join('');

  return `
    <section class="card">
      <h2>${st.kind === 'year' ? 'Per month' : 'Per day'}</h2>
      <ul class="legend">${present.map(c => `<li style="${catVars(c)}"><span class="swatch"></span>${esc(c.name)}</li>`).join('')}</ul>
      <div class="chart">
        <div class="grid">${ticks.map(h => `<div class="gridline" style="bottom:${(h / top) * 100}%"><span>${h}h</span></div>`).join('')}</div>
        <div class="cols ${st.buckets.length > 14 ? 'dense' : ''}">${cols}</div>
      </div>
      <details class="table-view">
        <summary>Show as table</summary>
        <div class="table-scroll"><table>
          <thead><tr><th></th>${present.map(c => `<th scope="col">${esc(c.name)}</th>`).join('')}<th scope="col">Total</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table></div>
      </details>
    </section>`;
}

export function bucketName(kind, key) {
  return kind === 'year'
    ? parseKey(`${key}-01`).toLocaleDateString('en-GB', { month: 'long' })
    : dayLabel(key, { weekday: 'short', day: 'numeric', month: 'short' });
}
