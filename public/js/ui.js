// Small shared UI helpers.
import { parseKey, fmtDur, fmtTime, FALLBACK_CAT } from './model.js';

export const SLOT_NAMES = ['Gray', 'Blue', 'Orange', 'Aqua', 'Yellow', 'Pink', 'Green', 'Violet', 'Red'];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function catColor(cat) {
  return `var(--c${cat?.slot ?? 0})`;
}

// Horizontal strip of the day's timer sessions, plus the latest sessions as a list.
export function renderTimeline(date, tasks, categories, now = Date.now(), listMax = 6) {
  const catOf = id => categories.find(c => c.id === id) || categories.find(c => c.id === FALLBACK_CAT) || categories[0];
  const dayStart = parseKey(date).getTime();
  const dayEnd = dayStart + 86400000;
  const sessions = [];
  for (const t of tasks || []) {
    for (const s of t.sessions || []) {
      const a = Math.max(s.s, dayStart), b = Math.min(s.e ?? now, dayEnd);
      if (b > a) sessions.push({ a, b, live: s.e == null, text: t.text, cat: catOf(t.cat) });
    }
  }
  if (!sessions.length) return '<p class="muted-note">No timer sessions yet. Press ▶ on a task.</p>';
  sessions.sort((x, y) => x.a - y.a);

  const hour = ms => (ms - dayStart) / 3600000;
  const startH = Math.min(7, Math.floor(hour(sessions[0].a)));
  const endH = Math.max(22, Math.ceil(hour(Math.max(...sessions.map(s => s.b)))));
  const span = endH - startH;
  const pos = h => ((h - startH) / span) * 100;

  const ticks = [];
  for (let h = Math.ceil(startH / 3) * 3; h <= endH; h += 3) ticks.push(h);

  const blocks = sessions.map(s => {
    const label = `${s.text} · ${fmtTime(s.a)}–${s.live ? 'now' : fmtTime(s.b)} (${fmtDur(s.b - s.a)})`;
    return `<span class="tl-block ${s.live ? 'live' : ''}" style="left:${pos(hour(s.a))}%;width:${pos(hour(s.b)) - pos(hour(s.a))}%;background:${catColor(s.cat)}" title="${esc(label)}"></span>`;
  }).join('');

  const list = sessions.slice(-listMax).reverse().map(s => `
    <li style="--cc:${catColor(s.cat)}">
      <span class="dot"></span>
      <span class="tl-time">${fmtTime(s.a)}–${s.live ? 'now' : fmtTime(s.b)}</span>
      <span class="tl-text">${esc(s.text)}</span>
      <span class="tl-dur">${fmtDur(s.b - s.a)}</span>
    </li>`).join('');

  return `
    <div class="timeline" role="img" aria-label="${sessions.length} timer sessions">
      <div class="tl-track">${blocks}</div>
      <div class="tl-ticks">${ticks.map(h => `<span style="left:${pos(h)}%">${String(h % 24).padStart(2, '0')}:00</span>`).join('')}</div>
    </div>
    <ul class="tl-list">${list}</ul>`;
}
