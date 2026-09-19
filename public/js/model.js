// Pure data logic: categories, task shape, time math, dates. No DOM, no Firebase.

// Presets derived from the 2026 Apple Notes list. `slot` picks the chart color
// (1-8 = categorical palette, 0 = neutral gray). Array order = display order.
export const DEFAULT_CATEGORIES = [
  { id: 'general',     name: 'General',        emoji: '📌', slot: 0 },
  { id: 'programming', name: 'Programming',    emoji: '💻', slot: 1 },
  { id: 'study',       name: 'Study',          emoji: '🎓', slot: 2 },
  { id: 'reading',     name: 'Reading',        emoji: '📖', slot: 3 },
  { id: 'business',    name: 'Business',       emoji: '💰', slot: 4 },
  { id: 'writing',     name: 'Writing',        emoji: '✍️', slot: 7 },
  { id: 'sport',       name: 'Sport',          emoji: '🏃', slot: 6 },
  { id: 'home',        name: 'Home & errands', emoji: '🏠', slot: 8 },
  { id: 'fun',         name: 'Fun',            emoji: '🎬', slot: 5 },
];
export const FALLBACK_CAT = 'general';

export const DEFAULT_BACKLOG = [
  { id: uid(), text: 'Boek West-Vlaamse etymologie', cat: 'writing' },
  { id: uid(), text: 'Shopify store (pet products)', cat: 'business' },
];

// Keyword rules, checked in order; first match wins. Mixed EN / NL / ES because
// that's how tasks get written. Learned choices (settings.memory) override these.
const RULES = [
  ['general',     /\b(plan (for )?tomorrow|make .*plan|evening routine|morning routine|shave|cut nails|uitslapen)\b/i],
  ['sport',       /\b(run|running|workout|pushups?|push-ups|gym|swim\w*|bike|fietsen|correr|walk|caminar|\d+\s*km)\b/i],
  ['reading',     /\b(read|reading|lezen|bahamontes|odyssey|spqr|outlander)\b/i],
  ['study',       /\b(study|studies|studying|studeren|course|curso|accounting|estudiar)\b/i],
  ['programming', /\b(apps?|code|coding|programming|fuera|mangamar|azohia|visor|deploy)\b/i],
  ['writing',     /\b(writ(e|ing)|schrijven|etymolog\w*|leven op de rails|boek)\b/i],
  ['business',    /\b(shopify|tiktok|sponsor|invest\w*|factura|geld|deposit|whop)\b/i],
  ['fun',         /\b(youtube|tv|netflix|film|movie|watch|planckaerts|vuelta|tour de france|roubaix|feria|puzzle|blind gekocht)\b/i],
  ['home',        /\b(laundry|lavar|ropa|clean\w*|sweep|cook|lightbulb|sheets|wardrobe|doblar|dolbar|fold|cortina|pintar|paint|mold|fan|supermar\w*|kitchen|call|bellen|cita|taller|bank|banco|email|passport|itv|peluquer\w*|buy|kopen|bestellen|order|radiograf\w*|nori|appointment)\b/i],
];

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// Strip times/durations so "AM 1hr Read Outlander" and "Read Outlander" group together.
export function normText(text) {
  return text.toLowerCase()
    .replace(/\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2}/g, ' ')
    .replace(/\d{1,2}[:.]\d{2}\s*(am|pm)?/g, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*(hours?|hrs?|h|uur|minutes?|mins?|m|minuten)\b/g, ' ')
    .replace(/\b(am|pm)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function guessCategory(text, memory = {}, categories = DEFAULT_CATEGORIES) {
  const known = new Set(categories.map(c => c.id));
  const remembered = memory[normText(text)];
  if (remembered && known.has(remembered)) return remembered;
  for (const [cat, re] of RULES) if (known.has(cat) && re.test(text)) return cat;
  return known.has(FALLBACK_CAT) ? FALLBACK_CAT : categories[0].id;
}

// Planned minutes from the task text: "2hr Shopify" → 120, "5:45-6:45 Study" → 60.
export function parseTarget(text) {
  const t = text.toLowerCase();
  const range = t.match(/(\d{1,2})[:.](\d{2})\s*[-–]\s*(\d{1,2})[:.](\d{2})/);
  if (range) {
    const d = (+range[3] * 60 + +range[4]) - (+range[1] * 60 + +range[2]);
    if (d > 0) return d;
  }
  let mins = 0, found = false;
  for (const x of t.matchAll(/(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|h|uur)\b/g)) { mins += parseFloat(x[1].replace(',', '.')) * 60; found = true; }
  for (const x of t.matchAll(/(\d+)\s*(minutes?|mins?|m|minuten)\b/g)) { mins += +x[1]; found = true; }
  return found ? Math.round(mins) : null;
}

export function newTask(text, cat) {
  return { id: uid(), text, cat, done: false, repeat: false, target: parseTarget(text), sessions: [], adjust: 0 };
}

export function isRunning(task) {
  const last = task.sessions?.at(-1);
  return !!last && last.e == null;
}

export function taskMs(task, now = Date.now()) {
  let ms = task.adjust || 0;
  for (const s of task.sessions || []) ms += (s.e ?? now) - s.s;
  return Math.max(0, ms);
}

// Next day's plan: repeating tasks plus anything left unfinished, reset.
export function carryOver(tasks) {
  return tasks
    .filter(t => t.repeat || !t.done)
    .map(t => ({ ...t, id: uid(), done: false, sessions: [], adjust: 0 }));
}

// ---------- formatting ----------

export function fmtDur(ms) {
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`;
}

export function fmtMin(min) {
  return fmtDur(min * 60000);
}

export function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ---------- dates (keys are local YYYY-MM-DD) ----------

export function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function todayKey() { return dateKey(new Date()); }
export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}
export function dayLabel(key, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return parseKey(key).toLocaleDateString('en-GB', opts);
}
export function relativeLabel(key) {
  const diff = Math.round((parseKey(key) - parseKey(todayKey())) / 86400000);
  return { 0: 'Today', 1: 'Tomorrow', [-1]: 'Yesterday' }[diff] || '';
}

// Period containing `anchor`, weeks starting Monday.
export function periodRange(kind, anchor) {
  const d = parseKey(anchor);
  if (kind === 'day') return { from: anchor, to: anchor };
  if (kind === 'week') {
    const from = addDays(anchor, -((d.getDay() + 6) % 7));
    return { from, to: addDays(from, 6) };
  }
  if (kind === 'month') {
    return { from: dateKey(new Date(d.getFullYear(), d.getMonth(), 1)), to: dateKey(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
  }
  return { from: `${d.getFullYear()}-01-01`, to: `${d.getFullYear()}-12-31` };
}

export function shiftPeriod(kind, anchor, dir) {
  const d = parseKey(anchor);
  if (kind === 'day') return addDays(anchor, dir);
  if (kind === 'week') return addDays(anchor, 7 * dir);
  if (kind === 'month') return dateKey(new Date(d.getFullYear(), d.getMonth() + dir, 1));
  return dateKey(new Date(d.getFullYear() + dir, 0, 1));
}

export function periodLabel(kind, anchor) {
  const { from, to } = periodRange(kind, anchor);
  if (kind === 'day') return `${relativeLabel(anchor) || dayLabel(anchor, { weekday: 'long' })} · ${dayLabel(anchor, { day: 'numeric', month: 'short' })}`;
  if (kind === 'week') return `${dayLabel(from, { day: 'numeric', month: 'short' })} – ${dayLabel(to, { day: 'numeric', month: 'short' })}`;
  if (kind === 'month') return parseKey(anchor).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return String(parseKey(anchor).getFullYear());
}

export function withDefaults(s) {
  return {
    categories: s?.categories?.length ? s.categories : DEFAULT_CATEGORIES,
    backlog: s?.backlog ?? DEFAULT_BACKLOG,
    memory: s?.memory ?? {},
    running: s?.running ?? null,
  };
}
