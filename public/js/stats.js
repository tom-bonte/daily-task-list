// Statistics: aggregation (pure) + HTML rendering for the Stats view.
import { taskMs, overlapMs, normText, periodRange, periodLabel, shiftPeriod, addDays, parseKey, dayLabel, fmtDur, fmtMin, todayKey, FALLBACK_CAT } from './model.js';
import { esc, catVars, catFill, renderTimeline } from './ui.js';

export const RANGES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const HOUR = 3600000, DAY = 86400000;

// Monday = 0 … Sunday = 6.
const weekdayOf = key => (parseKey(key).getDay() + 6) % 7;

export function computeStats(days, categories, kind, anchor, now = Date.now()) {
  const { from, to } = periodRange(kind, anchor);
  const known = new Set(categories.map(c => c.id));
  const bucketKey = date => (kind === 'year' ? date.slice(0, 7) : date);
  const today = todayKey();
  // Nothing can be tracked after today, so averages and streaks stop there.
  const last = to < today ? to : today;

  // Empty buckets for every day (or month) so gaps show as gaps.
  const buckets = [];
  if (kind === 'year') {
    for (let m = 0; m < 12; m++) buckets.push({ key: `${from.slice(0, 4)}-${String(m + 1).padStart(2, '0')}`, byCat: {}, total: 0 });
  } else {
    for (let k = from; k <= to; k = addDays(k, 1)) buckets.push({ key: k, byCat: {}, total: 0 });
  }
  const bucketMap = new Map(buckets.map(b => [b.key, b]));
  const bucketIndex = new Map(buckets.map((b, i) => [b.key, i]));

  const byCat = {};
  const tasks = new Map();
  const perDay = new Map();                                   // date → { ms, byCat }
  const hours = Array.from({ length: 7 }, () => new Array(24).fill(0)); // weekday × hour of day
  let total = 0, done = 0, planned = 0, overlap = 0;
  let longest = null;                                         // the single longest timer block

  for (const day of days) {
    if (day.date < from || day.date > to) continue;
    overlap += overlapMs(day.tasks, now);
    const dayStart = parseKey(day.date).getTime(), dayEnd = dayStart + DAY;
    const wd = weekdayOf(day.date);
    const bi = bucketIndex.get(bucketKey(day.date));
    for (const t of day.tasks || []) {
      const cat = known.has(t.cat) ? t.cat : FALLBACK_CAT;
      planned++;
      if (t.done) done++;
      const ms = taskMs(t, now);
      const key = `${cat}|${normText(t.text) || t.text.toLowerCase()}`;
      const entry = tasks.get(key) || { text: t.text, cat, ms: 0, target: 0, days: new Set(), done: 0, series: new Array(buckets.length).fill(0) };
      entry.ms += ms;
      entry.target += t.target || 0;
      entry.done += t.done ? 1 : 0;
      if (ms) entry.days.add(day.date);
      if (bi != null) entry.series[bi] += ms;
      tasks.set(key, entry);
      for (const s of t.sessions || []) {
        let a = Math.max(s.s, dayStart);
        const b = Math.min(s.e ?? now, dayEnd);
        if (b <= a) continue;
        if (!longest || b - a > longest.ms) longest = { ms: b - a, text: t.text, cat, date: day.date };
        // Spread the block over the hour cells it touches.
        while (a < b) {
          const h = Math.floor((a - dayStart) / HOUR);
          const cellEnd = dayStart + (h + 1) * HOUR;
          hours[wd][Math.min(h, 23)] += Math.min(b, cellEnd) - a;
          a = cellEnd;
        }
      }
      if (!ms) continue;
      total += ms;
      byCat[cat] = (byCat[cat] || 0) + ms;
      const pd = perDay.get(day.date) || { ms: 0, byCat: {} };
      pd.ms += ms;
      pd.byCat[cat] = (pd.byCat[cat] || 0) + ms;
      perDay.set(day.date, pd);
      const bk = bucketMap.get(bucketKey(day.date));
      if (bk) { bk.byCat[cat] = (bk.byCat[cat] || 0) + ms; bk.total += ms; }
    }
  }

  // How often each weekday occurs up to today, for "average Tuesday" figures.
  const weekdayCount = new Array(7).fill(0);
  for (let k = from; k <= last; k = addDays(k, 1)) weekdayCount[weekdayOf(k)]++;
  const daysSoFar = weekdayCount.reduce((a, b) => a + b, 0);

  // Streaks of days with tracked time. A quiet today does not end the current one yet.
  let current = 0, k = last;
  if (!perDay.has(k)) k = addDays(k, -1);
  while (k >= from && perDay.has(k)) { current++; k = addDays(k, -1); }
  let best = 0, run = 0;
  for (let d = from; d <= last; d = addDays(d, 1)) { run = perDay.has(d) ? run + 1 : 0; best = Math.max(best, run); }

  let bestDay = null;
  for (const [date, pd] of perDay) if (!bestDay || pd.ms > bestDay.ms) bestDay = { date, ms: pd.ms };

  let peak = null;
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) if (hours[w][h] && (!peak || hours[w][h] > peak.ms)) peak = { wd: w, hour: h, ms: hours[w][h] };
  const weekdayAvg = hours.map((row, w) => (weekdayCount[w] ? row.reduce((a, b) => a + b, 0) / weekdayCount[w] : 0));
  const busiest = weekdayAvg.some(Boolean) ? weekdayAvg.indexOf(Math.max(...weekdayAvg)) : null;

  const catRows = categories
    .map(c => ({ cat: c, ms: byCat[c.id] || 0 }))
    .filter(r => r.ms > 0)
    .sort((a, b) => b.ms - a.ms);

  const taskRows = [...tasks.values()].sort((a, b) => b.ms - a.ms || b.done - a.done);

  return {
    kind, anchor, from, to, last, total, done, planned, overlap, activeDays: perDay.size, daysSoFar,
    catRows, taskRows, buckets, perDay, hours, weekdayCount, weekdayAvg,
    streak: { current, best }, bestDay, longest, peak, busiest,
  };
}

const PREV_LABEL = { day: 'yesterday', week: 'last week', month: 'last month', year: 'last year' };

// "▲ 1h 20m vs last week" — the change against the previous period.
function deltaHtml(cur, prev, kind) {
  const label = PREV_LABEL[kind];
  if (prev == null) return '';
  if (!prev && !cur) return '';
  if (!prev) return `nothing ${label}`;
  const d = cur - prev;
  if (Math.abs(d) < 60000) return `same as ${label}`;
  return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${fmtDur(Math.abs(d))}</span> vs ${label}`;
}

const tipAttr = tip => `data-tip="${esc(JSON.stringify(tip))}"`;

// 0 = nothing, 1–5 = share of the largest cell. One hue, light → dark.
const level = (ms, max) => (!ms || !max ? 0 : Math.max(1, Math.ceil((ms / max) * 5)));

export function renderStats(st, categories, expanded, days = [], prev = null) {
  const catById = Object.fromEntries(categories.map(c => [c.id, c]));
  const isDay = st.kind === 'day';

  const tabs = RANGES.map(([k, label]) =>
    `<button class="seg ${k === st.kind ? 'on' : ''}" data-action="stats-range" data-range="${k}" aria-pressed="${k === st.kind}">${label}</button>`).join('');

  const top = st.catRows[0];
  const overlapNote = st.overlap >= 60000 ? `<span class="warn">⚠ ${fmtDur(st.overlap)} overlapped</span>` : '';
  const tiles = [
    ['Tracked', fmtDur(st.total), [deltaHtml(st.total, prev?.total, st.kind), overlapNote].filter(Boolean).join(' · ')],
    isDay
      ? ['Planned', fmtDur(st.taskRows.reduce((a, t) => a + t.target, 0) * 60000), 'from task durations']
      : ['Per active day', st.activeDays ? fmtDur(st.total / st.activeDays) : '–', `${st.activeDays} of ${st.daysSoFar} day${st.daysSoFar === 1 ? '' : 's'} active`],
    ['Tasks done', `${st.done}/${st.planned}`, st.planned ? `${Math.round((st.done / st.planned) * 100)}%` : ''],
    ['Top category', top ? `${esc(top.cat.emoji || '')} ${esc(top.cat.name)}` : '–', top ? `${fmtDur(top.ms)} · ${Math.round((top.ms / st.total) * 100)}%` : ''],
    isDay
      ? ['Longest block', st.longest ? fmtDur(st.longest.ms) : '–', st.longest ? esc(st.longest.text) : '']
      : ['Streak', st.streak.current ? `${st.streak.current} day${st.streak.current === 1 ? '' : 's'}` : '–', st.streak.best > st.streak.current ? `best ${st.streak.best} in a row` : st.streak.current ? 'your best this period' : 'no active days yet'],
    ...(isDay ? [] : [['Best day', st.bestDay ? fmtDur(st.bestDay.ms) : '–', st.bestDay ? dayLabel(st.bestDay.date) : '']]),
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
      ${st.kind === 'year' ? calendar(st) : ''}
      <div class="stats-grid">
        <section class="card">
          <h2>By category</h2>
          ${categoryBars(st, expanded, true, prev)}
        </section>
        ${right}
      </div>
      ${isDay ? '' : rhythm(st)}
      <section class="card">
        <h2>${isDay ? 'Tasks' : 'Tasks in this period'}</h2>
        ${rows.length ? `
          <div class="table-scroll"><table class="datatable">
            <thead><tr><th>Task</th><th>Category</th>${isDay ? '' : `<th class="num">Days</th><th class="spark-col">${st.kind === 'year' ? 'Per month' : 'Per day'}</th>`}<th class="num">Planned</th><th class="num">Tracked</th><th class="bar-col"><span class="sr-only">Progress</span></th></tr></thead>
            <tbody>${rows.slice(0, 60).map(t => {
              const cat = catById[t.cat];
              const pct = t.target ? Math.min(100, (t.ms / (t.target * 60000)) * 100) : null;
              return `<tr style="${catVars(cat)}">
                <td>${esc(t.text)}${t.done ? ' <span class="muted">✓</span>' : ''}</td>
                <td><span class="dot"></span> ${esc(cat?.name || '')}</td>
                ${isDay ? '' : `<td class="num">${t.days.size || '–'}</td><td class="spark-col">${sparkline(t.series, st)}</td>`}
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

// Tiny bar-per-bucket trend for one task, in its category colour.
function sparkline(series, st) {
  const max = Math.max(...series);
  if (!max) return '';
  const bars = series.map((v, i) => `<i style="height:${v ? Math.max(8, (v / max) * 100) : 0}%" title="${esc(bucketName(st.kind, st.buckets[i].key))}: ${v ? fmtDur(v) : '–'}"></i>`).join('');
  return `<span class="spark ${series.length > 14 ? 'dense' : ''}" role="img" aria-label="Trend over ${series.length} ${st.kind === 'year' ? 'months' : 'days'}">${bars}</span>`;
}

// Category bars; interactive rows expand to the tasks behind them. With `prev`,
// each row also shows its change against the previous period.
export function categoryBars(st, expanded, interactive, prev = null) {
  if (!st.catRows.length) return `<p class="muted-note">No time tracked ${st.kind === 'day' ? 'this day' : 'in this period'} yet.</p>`;
  const maxCat = st.catRows[0].ms;
  const Tag = interactive ? 'button' : 'div';
  const prevMs = id => prev?.catRows.find(r => r.cat.id === id)?.ms ?? 0;
  return `<ul class="stat-list">${st.catRows.map(({ cat, ms }) => {
    const open = interactive && expanded.has(cat.id);
    const rows = open ? st.taskRows.filter(t => t.cat === cat.id && t.ms > 0).map(t => `
      <li class="stat-task"><span class="stat-task-text">${esc(t.text)}</span><span class="stat-task-val">${fmtDur(t.ms)}</span></li>`).join('') : '';
    let delta = '';
    if (prev) {
      const d = ms - prevMs(cat.id);
      delta = Math.abs(d) < 60000 ? '<span class="stat-delta muted">=</span>'
        : `<span class="stat-delta delta ${d > 0 ? 'up' : 'down'}" title="vs ${PREV_LABEL[st.kind]}">${d > 0 ? '▲' : '▼'} ${fmtDur(Math.abs(d))}</span>`;
    }
    return `
      <li>
        <${Tag} class="stat-row ${interactive ? '' : 'static'} ${prev ? 'with-delta' : ''}" ${interactive ? `data-action="stats-toggle" data-cat="${esc(cat.id)}" aria-expanded="${open}"` : ''} style="${catVars(cat)}">
          <span class="stat-name"><span class="dot"></span><span class="emoji">${esc(cat.emoji || '')}</span><span class="ellipsis">${esc(cat.name)}</span></span>
          <span class="bar-track"><span class="bar" style="width:${(ms / maxCat) * 100}%"></span></span>
          <span class="stat-val">${fmtDur(ms)}</span>
          <span class="stat-pct">${Math.round((ms / st.total) * 100)}%</span>
          ${delta}
        </${Tag}>
        ${open ? `<ul class="stat-tasks">${rows}</ul>` : ''}
      </li>`;
  }).join('')}</ul>`;
}

// Year: one cell per day, GitHub-style, weeks as columns from Monday down.
function calendar(st) {
  const today = todayKey();
  const max = Math.max(0, ...[...st.perDay.values()].map(d => d.ms));
  const weeks = [];
  let k = addDays(st.from, -weekdayOf(st.from));
  while (k <= st.to) {
    const col = [];
    for (let i = 0; i < 7; i++) { col.push(k); k = addDays(k, 1); }
    weeks.push(col);
  }
  const months = weeks.map((col, i) => {
    const first = col.find(d => d >= st.from && d <= st.to && d.endsWith('-01'));
    return first ? `<span style="grid-column:${i + 1}">${parseKey(first).toLocaleDateString('en-GB', { month: 'short' })}</span>` : '';
  }).join('');
  const cells = weeks.flat().map(d => {
    if (d < st.from || d > st.to) return '<span class="cal-cell pad"></span>';
    const pd = st.perDay.get(d);
    if (d > today) return `<span class="cal-cell future" title="${esc(dayLabel(d))}"></span>`;
    const tip = { head: dayLabel(d, { weekday: 'long', day: 'numeric', month: 'short' }), rows: pd ? Object.entries(pd.byCat).map(([cat, ms]) => ({ cat, ms })) : [], total: pd?.ms || 0 };
    return `<button class="cal-cell l${level(pd?.ms, max)} ${d === today ? 'today' : ''}" data-action="stats-day" data-date="${d}" ${tipAttr(tip)} aria-label="${esc(dayLabel(d))}: ${pd ? fmtDur(pd.ms) : 'nothing tracked'}"></button>`;
  }).join('');
  const quiet = st.daysSoFar - st.activeDays;
  return `
    <section class="card cal-card">
      <div class="card-head">
        <h2>Every day</h2>
        <span class="muted small">${st.activeDays} active · ${quiet} quiet · click a day to open it</span>
      </div>
      <div class="cal-wrap">
        <div class="cal-months" style="grid-template-columns:repeat(${weeks.length},1fr)">${months}</div>
        <div class="cal-days"><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span>Sun</span></div>
        <div class="cal" style="grid-template-columns:repeat(${weeks.length},1fr)">${cells}</div>
      </div>
      ${scale('Less', 'More')}
    </section>`;
}

// Weekday × hour-of-day heatmap: when the tracked time actually happens.
function rhythm(st) {
  const max = Math.max(0, ...st.hours.flat());
  if (!max) return '';
  const head = Array.from({ length: 8 }, (_, i) => `<span class="hm-h" style="grid-column:span 3">${String(i * 3).padStart(2, '0')}</span>`).join('');
  const rows = st.hours.map((row, w) => {
    const n = st.weekdayCount[w];
    const cells = row.map((ms, h) => {
      const tip = { head: `${WEEKDAYS[w]} · ${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`, total: ms, note: n > 1 && ms ? `avg ${fmtDur(ms / n)} per ${WEEKDAYS[w]}` : '' };
      return `<span class="hm-cell l${level(ms, max)}" tabindex="0" ${tipAttr(tip)} aria-label="${tip.head}: ${ms ? fmtDur(ms) : 'nothing'}"></span>`;
    }).join('');
    const sum = row.reduce((a, b) => a + b, 0);
    return `<span class="hm-d ${w === st.busiest ? 'busiest' : ''}">${WEEKDAYS[w].slice(0, 3)}</span>${cells}<span class="hm-t">${sum ? fmtDur(n > 1 ? sum / n : sum) : ''}</span>`;
  }).join('');
  const multi = st.weekdayCount.some(n => n > 1);
  const notes = [
    st.peak ? `Peak: ${WEEKDAYS[st.peak.wd]}s around ${String(st.peak.hour).padStart(2, '0')}:00` : '',
    st.busiest != null ? `Most active day: ${WEEKDAYS[st.busiest]}${multi ? ` (avg ${fmtDur(st.weekdayAvg[st.busiest])})` : ''}` : '',
  ].filter(Boolean).join(' · ');
  return `
    <section class="card hm-card">
      <div class="card-head"><h2>Rhythm</h2><span class="muted small">${multi ? 'average per weekday and hour' : 'by weekday and hour'}</span></div>
      <div class="hm"><span></span>${head}<span class="hm-t"></span>${rows}</div>
      <div class="hm-foot"><span class="muted small">${notes}</span>${scale('Less', 'More')}</div>
    </section>`;
}

function scale(lo, hi) {
  return `<div class="scale"><span>${lo}</span>${[1, 2, 3, 4, 5].map(l => `<i class="l${l}"></i>`).join('')}<span>${hi}</span></div>`;
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

// The period before this one, for the deltas.
export function previousAnchor(kind, anchor) {
  return shiftPeriod(kind, anchor, -1);
}
