// Small shared UI helpers.
import { parseKey, fmtDur, fmtTime, todayKey, FALLBACK_CAT } from './model.js';

const HUES = ['Blue', 'Orange', 'Aqua', 'Yellow', 'Pink', 'Green', 'Violet', 'Red'];
// Slot 0 = gray, 1-8 = palette hues, 9-16 = the same hues striped, so no two
// categories share a look without going past the 8 colorblind-safe hues.
export const SLOT_NAMES = ['Gray', ...HUES, ...HUES.map(h => `${h} striped`)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function catColor(cat) {
  const s = cat?.slot ?? 0;
  return `var(--c${s > 8 ? ((s - 1) % 8) + 1 : s})`;
}

// Background for marks (dots, bars, segments): solid, or hatched for slots 9-16.
export function catFill(cat) {
  const c = catColor(cat);
  return (cat?.slot ?? 0) > 8
    ? `repeating-linear-gradient(135deg, ${c} 0 2.5px, color-mix(in srgb, ${c} 30%, var(--surface)) 2.5px 5px)`
    : c;
}

// Inline style vars: --cc (solid hue, for accents/borders) and --cf (mark fill).
export function catVars(cat) {
  return `--cc:${catColor(cat)};--cf:${catFill(cat)}`;
}

// Every session of a day, clipped to that day, oldest first.
export function daySessions(date, tasks, categories, now = Date.now()) {
  const catOf = id => categories.find(c => c.id === id) || categories.find(c => c.id === FALLBACK_CAT) || categories[0];
  const dayStart = parseKey(date).getTime();
  const dayEnd = dayStart + 86400000;
  const out = [];
  for (const t of tasks || []) {
    for (const s of t.sessions || []) {
      const a = Math.max(s.s, dayStart), b = Math.min(s.e ?? now, dayEnd);
      if (b > a) out.push({ a, b, live: s.e == null, text: t.text, cat: catOf(t.cat), taskId: t.id, start: s.s });
    }
  }
  return out.sort((x, y) => x.a - y.a);
}

// Zoomed view of a day. Quiet hours collapse into a small gap row, and only
// sessions that actually overlap share the width, so the day reads at a glance.
export function renderDayZoom(date, tasks, categories, now = Date.now()) {
  const sessions = daySessions(date, tasks, categories, now);
  if (!sessions.length) {
    return '<p class="zoom-empty">No timer sessions on this day yet. Press ▶ on a task and it shows up here.</p>';
  }
  const dayStart = parseKey(date).getTime();
  const hour = ms => (ms - dayStart) / 3600000;
  const HOUR = 62;  // px for an hour with activity
  const GAP = 34;   // px for a collapsed quiet stretch
  const from = Math.floor(hour(Math.min(...sessions.map(s => s.a))));
  const to = Math.ceil(hour(Math.max(...sessions.map(s => s.b))));

  // Rows: an hour that holds something, or a run of quiet hours collapsed into one.
  const busy = h => sessions.some(s => hour(s.a) < h + 1 && hour(s.b) > h);
  const rows = [];
  for (let h = from; h < Math.max(to, from + 1); h++) {
    if (busy(h) || h === from) { rows.push({ type: 'hour', h }); continue; }
    const last = rows.at(-1);
    if (last?.type === 'gap') last.hours.push(h);
    else rows.push({ type: 'gap', hours: [h] });
  }
  // A single quiet hour is not worth collapsing.
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === 'gap' && rows[i].hours.length === 1) rows[i] = { type: 'hour', h: rows[i].hours[0] };
  }

  let y = 0;
  for (const row of rows) {
    row.top = y;
    row.height = row.type === 'hour' ? HOUR : GAP;
    y += row.height;
  }
  const total = y;

  // Map a timestamp to a y position inside its row.
  const yOf = ms => {
    const h = hour(ms);
    const row = rows.find(r => (r.type === 'hour' ? r.h === Math.floor(h) : r.hours.includes(Math.floor(h))));
    if (!row) return h < (rows[0].h ?? from) ? 0 : total;
    return row.type === 'hour' ? row.top + (h - row.h) * HOUR : row.top + GAP / 2;
  };

  // Clusters of genuinely overlapping sessions; only those share the width.
  const clusters = [];
  for (const s of sessions) {
    const open = clusters.at(-1);
    if (open && s.a < open.end) { open.items.push(s); open.end = Math.max(open.end, s.b); }
    else clusters.push({ items: [s], end: s.b });
  }
  for (const cluster of clusters) {
    const lanes = [];
    for (const s of cluster.items) {
      let lane = lanes.findIndex(end => end <= s.a);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = s.b;
      s.lane = lane;
    }
    cluster.cols = lanes.length;
  }

  const nowLine = date === todayKey() && hour(now) >= from && hour(now) <= to
    ? `<div class="zoom-now" style="top:${yOf(now)}px"><span>${fmtTime(now)}</span></div>`
    : '';

  const grid = rows.map(row => row.type === 'hour'
    ? `<div class="zoom-row" style="top:${row.top}px;height:${row.height}px"><span class="zoom-label">${String(row.h % 24).padStart(2, '0')}:00</span></div>`
    : `<div class="zoom-row gap" style="top:${row.top}px;height:${row.height}px"><span class="zoom-label">${String(row.hours[0] % 24).padStart(2, '0')}:00</span><span class="zoom-gap-note">${row.hours.length}h quiet</span></div>`
  ).join('');

  const blocks = clusters.flatMap(cluster => cluster.items.map(s => {
    const top = yOf(s.a);
    const height = Math.max(20, yOf(s.b) - top);
    const width = 100 / cluster.cols;
    const label = `${fmtTime(s.a)}–${s.live ? 'now' : fmtTime(s.b)}`;
    return `
      <button class="zoom-block ${s.live ? 'live' : ''} ${height < 38 ? 'tight' : ''}" style="${catVars(s.cat)};top:${top}px;height:${height}px;left:${s.lane * width}%;width:calc(${width}% - 6px)"
        data-action="edit" data-id="${esc(s.taskId)}" title="${esc(s.text)} · ${label} · ${fmtDur(s.b - s.a)}">
        <span class="zoom-text">${esc(s.text)}</span>
        <span class="zoom-meta">${label} · ${fmtDur(s.b - s.a)}</span>
      </button>`;
  })).join('');

  return `
    <div class="zoom" style="--zoom-height:${total}px">
      <div class="zoom-grid">${grid}${nowLine}</div>
      <div class="zoom-blocks">${blocks}</div>
    </div>`;
}

// Horizontal strip of the day's timer sessions, plus the latest sessions as a list.
export function renderTimeline(date, tasks, categories, now = Date.now(), listMax = 6, deletable = false) {
  const catOf = id => categories.find(c => c.id === id) || categories.find(c => c.id === FALLBACK_CAT) || categories[0];
  const dayStart = parseKey(date).getTime();
  const dayEnd = dayStart + 86400000;
  const sessions = [];
  for (const t of tasks || []) {
    for (const s of t.sessions || []) {
      const a = Math.max(s.s, dayStart), b = Math.min(s.e ?? now, dayEnd);
      if (b > a) sessions.push({ a, b, live: s.e == null, text: t.text, cat: catOf(t.cat), taskId: t.id, start: s.s });
    }
  }
  if (!sessions.length) return '<p class="muted-note">No timer sessions yet. Press ▶ on a task.</p>';
  sessions.sort((x, y) => x.a - y.a);

  const hour = ms => (ms - dayStart) / 3600000;
  const startH = Math.min(7, Math.floor(hour(sessions[0].a)));
  const endH = Math.max(22, Math.ceil(hour(Math.max(...sessions.map(s => s.b)))));
  const span = endH - startH;
  const pos = h => ((h - startH) / span) * 100;

  // Keep labels apart: wider spans get a coarser step.
  const step = span > 16 ? 6 : span > 9 ? 3 : 2;
  const ticks = [];
  for (let h = Math.ceil(startH / step) * step; h <= endH; h += step) ticks.push(h);
  if (ticks[0] - startH > step / 2) ticks.unshift(startH);

  const blocks = sessions.map(s => {
    const label = `${s.text} · ${fmtTime(s.a)}–${s.live ? 'now' : fmtTime(s.b)} (${fmtDur(s.b - s.a)})`;
    return `<span class="tl-block ${s.live ? 'live' : ''}" style="left:${pos(hour(s.a))}%;width:${pos(hour(s.b)) - pos(hour(s.a))}%;background:${catFill(s.cat)}" title="${esc(label)}"></span>`;
  }).join('');

  const list = sessions.slice(-listMax).reverse().map(s => `
    <li style="${catVars(s.cat)}">
      <span class="dot"></span>
      <span class="tl-time">${fmtTime(s.a)}–${s.live ? 'now' : fmtTime(s.b)}</span>
      <span class="tl-text">${esc(s.text)}</span>
      <span class="tl-dur">${fmtDur(s.b - s.a)}</span>
      ${deletable ? (s.live ? '<span></span>' : `<button class="icon small tl-del" data-action="session-del" data-task="${esc(s.taskId)}" data-s="${s.start}" aria-label="Delete this time block" title="Delete">×</button>`) : ''}
    </li>`).join('');

  return `
    <div class="timeline" role="img" aria-label="${sessions.length} timer sessions">
      <div class="tl-track">${blocks}</div>
      <div class="tl-ticks">${ticks.map(h => {
        const at = pos(h);
        // Pull the end labels inside the strip so nothing is clipped.
        const shift = at < 6 ? 'translateX(0)' : at > 94 ? 'translateX(-100%)' : 'translateX(-50%)';
        return `<span style="left:${at}%;transform:${shift}">${String(h % 24).padStart(2, '0')}:00</span>`;
      }).join('')}</div>
    </div>
    <ul class="tl-list">${list}</ul>`;
}
