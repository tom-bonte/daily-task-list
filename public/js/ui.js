// Small shared UI helpers.
import { parseKey, fmtDur, fmtTime, FALLBACK_CAT } from './model.js';

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

// Zoomed view of a day: one hour per row, overlapping timers side by side.
export function renderDayZoom(date, tasks, categories, now = Date.now()) {
  const sessions = daySessions(date, tasks, categories, now);
  if (!sessions.length) return '<p class="muted-note">No timer sessions on this day yet.</p>';
  const dayStart = parseKey(date).getTime();
  const hour = ms => (ms - dayStart) / 3600000;
  const from = Math.floor(Math.min(...sessions.map(s => hour(s.a))));
  const to = Math.ceil(Math.max(...sessions.map(s => hour(s.b))));
  const span = Math.max(2, to - from);
  const ROW = 58; // px per hour

  // Lane packing: a session moves right only when it overlaps one already placed.
  const lanes = [];
  for (const s of sessions) {
    let lane = lanes.findIndex(end => end <= s.a);
    if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = s.b;
    s.lane = lane;
  }
  const cols = lanes.length;

  const hours = [];
  for (let h = from; h <= to; h++) hours.push(h);

  return `
    <div class="zoom" style="height:${span * ROW}px">
      <div class="zoom-grid">
        ${hours.map(h => `<div class="zoom-hour" style="top:${(h - from) * ROW}px"><span>${String(h % 24).padStart(2, '0')}:00</span></div>`).join('')}
      </div>
      <div class="zoom-blocks">
        ${sessions.map(s => {
          const top = (hour(s.a) - from) * ROW;
          const height = Math.max(18, (hour(s.b) - hour(s.a)) * ROW);
          const width = 100 / cols;
          return `
            <button class="zoom-block ${s.live ? 'live' : ''}" style="${catVars(s.cat)};top:${top}px;height:${height}px;left:${s.lane * width}%;width:calc(${width}% - 4px)"
              data-action="edit" data-id="${esc(s.taskId)}" title="${esc(s.text)} · ${fmtTime(s.a)}–${s.live ? 'now' : fmtTime(s.b)}">
              <span class="zoom-text">${esc(s.text)}</span>
              <span class="zoom-meta">${fmtTime(s.a)}–${s.live ? 'now' : fmtTime(s.b)} · ${fmtDur(s.b - s.a)}</span>
            </button>`;
        }).join('')}
      </div>
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
