// Pure data logic: categories, task shape, time math, dates. No DOM, no Firebase.

export const SETTINGS_VERSION = 2;
export const FALLBACK_CAT = 'general';
// 0 = gray, 1-8 = the validated palette hues, 9-16 = the same hues striped.
export const MAX_SLOT = 16;

// Auto-sort keywords per category, derived from the 2026 Apple Notes list.
// Mixed EN / NL / ES because that's how tasks get written. A trailing * matches
// any word ending ("swim*" → swimming). Users edit these in Settings.
export const PRESET_KEYWORDS = {
  general: ['plan tomorrow', 'make plan', 'plan', 'evening routine', 'morning routine', 'shave', 'cut nails', 'uitslapen'],
  programming: ['app', 'apps', 'code', 'coding', 'programming', 'programmeren', 'mangamar', 'azohia', 'deploy', 'website', 'github', 'bug*'],
  work: ['work', 'werk', 'trabajo', 'fuera', 'visor', 'factura*', 'invoice*', 'client*', 'klant*', 'meeting', 'vergadering', 'reunion', 'reunión'],
  study: ['study', 'studies', 'studying', 'studeren', 'estudiar', 'course', 'curso', 'investment course', 'accounting', 'les'],
  reading: ['read', 'reading', 'lezen', 'leer', 'bahamontes', 'odyssey', 'spqr', 'outlander'],
  business: ['shopify', 'tiktok', 'sponsor', 'invest*', 'geld', 'deposit', 'whop', 'dropshipping'],
  writing: ['write', 'writing', 'schrijven', 'etymolog*', 'leven op de rails', 'boek'],
  sport: ['run', 'running', 'trail', 'workout', 'pushups', 'push-ups', 'gym', 'swim*', 'bike', 'fietsen', 'correr', 'walk', 'caminar', 'padel', 'yoga'],
  home: ['laundry', 'lavar', 'ropa', 'clean*', 'sweep', 'cook', 'lightbulb', 'sheets', 'wardrobe', 'doblar', 'fold', 'cortina', 'pintar', 'paint', 'mold', 'fan', 'supermar*', 'kitchen', 'call', 'bellen', 'cita', 'taller', 'bank', 'banco', 'email', 'passport', 'itv', 'peluquer*', 'buy', 'kopen', 'bestellen', 'order', 'radiograf*', 'nori', 'appointment'],
  fun: ['youtube', 'tv', 'netflix', 'film', 'movie', 'watch', 'planckaerts', 'vuelta', 'tour de france', 'roubaix', 'feria', 'puzzle', 'blind gekocht'],
  family: ['family', 'familie', 'familia', 'thuisfront', 'ma', 'mama', 'papa', 'pa', 'mom', 'dad', 'oma', 'opa', 'broer', 'zus', 'hermano', 'hermana', 'madre', 'padre', 'abuela', 'abuelo', 'verjaardag', 'birthday', 'cumple*'],
};
// Category names (any language) that should get a preset's keywords.
const PRESET_ALIASES = { familie: 'family', familia: 'family', werk: 'work', trabajo: 'work', job: 'work' };

export function presetKeywordsFor(cat) {
  const key = PRESET_KEYWORDS[cat.id] ? cat.id : PRESET_ALIASES[cat.name?.trim().toLowerCase()] || cat.name?.trim().toLowerCase();
  return [...(PRESET_KEYWORDS[key] || [])];
}

// Array order = display order.
export const DEFAULT_CATEGORIES = [
  { id: 'general',     name: 'General',        emoji: '📌', slot: 0 },
  { id: 'work',        name: 'Work',           emoji: '💼', slot: 10 },
  { id: 'programming', name: 'Programming',    emoji: '💻', slot: 1 },
  { id: 'study',       name: 'Study',          emoji: '🎓', slot: 2 },
  { id: 'reading',     name: 'Reading',        emoji: '📖', slot: 3 },
  { id: 'business',    name: 'Business',       emoji: '💰', slot: 4 },
  { id: 'writing',     name: 'Writing',        emoji: '✍️', slot: 7 },
  { id: 'sport',       name: 'Sport',          emoji: '🏃', slot: 6 },
  { id: 'home',        name: 'Home & errands', emoji: '🏠', slot: 8 },
  { id: 'fun',         name: 'Fun',            emoji: '🎬', slot: 5 },
].map(c => ({ ...c, keywords: presetKeywordsFor(c) }));

export const DEFAULT_BACKLOG = [
  { id: uid(), text: 'Boek West-Vlaamse etymologie', cat: 'writing' },
  { id: uid(), text: 'Shopify store (pet products)', cat: 'business' },
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

const reCache = new Map();
function keywordRe(kw) {
  if (!reCache.has(kw)) {
    const body = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*$/, '[\\p{L}\\p{N}]*').replace(/\s+/g, '\\s+');
    reCache.set(kw, new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu'));
  }
  return reCache.get(kw);
}

// Keywords a category matches on: its own list plus the words of its name.
function categoryKeywords(cat) {
  const fromName = (cat.name || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && w !== 'and');
  return [...(cat.keywords || []), ...fromName];
}

// Learned choice first; otherwise the keyword that appears earliest in the text
// wins ("Ma bellen" → family, not the "bellen" errand), then the longest keyword.
export function guessCategory(text, memory = {}, categories = DEFAULT_CATEGORIES) {
  const known = new Set(categories.map(c => c.id));
  const remembered = memory[normText(text)];
  if (remembered && known.has(remembered)) return remembered;
  return explainGuess(text, categories).cat;
}

// Keyword-only guess plus the keyword that decided it (null when nothing matched).
export function explainGuess(text, categories = DEFAULT_CATEGORIES) {
  const known = new Set(categories.map(c => c.id));
  let best = null;
  for (const cat of categories) {
    for (const kw of categoryKeywords(cat)) {
      const m = keywordRe(kw).exec(text);
      if (!m) continue;
      const len = kw.replace(/\*$/, '').length;
      if (!best || m.index < best.index || (m.index === best.index && len > best.len)) best = { index: m.index, len, cat: cat.id, kw };
    }
  }
  if (best) return { cat: best.cat, kw: best.kw };
  return { cat: known.has(FALLBACK_CAT) ? FALLBACK_CAT : categories[0].id, kw: null };
}

// First word worth learning as a keyword: no numbers, times or filler words.
const FILLER = new Set(['the', 'and', 'for', 'with', 'make', 'finish', 'start', 'van', 'het', 'een', 'met', 'voor', 'doen', 'maken', 'los', 'las', 'del', 'por', 'para', 'con', 'hacer']);
export function learnableWord(text) {
  return normText(text).split(/[^\p{L}]+/u).find(w => w.length >= 3 && !FILLER.has(w)) || null;
}

// Timer hygiene: drop runs under a minute (misclicks) and merge blocks of the
// same task separated by at most MERGE_GAP_MS. A running session stays last.
export const MIN_SESSION_MS = 60000;
export const MERGE_GAP_MS = 120000;
export function tidySessions(sessions) {
  const open = sessions.filter(s => s.e == null);
  const out = [];
  for (const s of sessions.filter(s => s.e != null && s.e - s.s >= MIN_SESSION_MS).sort((a, b) => a.s - b.s)) {
    const last = out.at(-1);
    if (last && s.s - last.e <= MERGE_GAP_MS) last.e = Math.max(last.e, s.e);
    else out.push({ s: s.s, e: s.e });
  }
  return [...out, ...open];
}

// One-time upgrades for settings saved by older versions of the app.
export function migrateCategories(categories, fromVersion) {
  const cats = structuredClone(categories);
  if (fromVersion < 2) {
    if (!cats.some(c => c.id === 'work' || ['work', 'werk', 'trabajo'].includes(c.name.trim().toLowerCase()))) {
      cats.splice(1, 0, structuredClone(DEFAULT_CATEGORIES.find(c => c.id === 'work')));
    }
    for (const c of cats) if (!Array.isArray(c.keywords)) c.keywords = presetKeywordsFor(c);
    // Give every category its own color: re-slot duplicates into free slots.
    const used = new Set();
    for (const c of cats) {
      if ((c.slot ?? 0) !== 0 && used.has(c.slot)) c.slot = freeSlot(cats, used);
      used.add(c.slot ?? 0);
    }
  }
  return cats;
}

// First color slot no category uses yet (solid hues before striped ones).
export function freeSlot(cats, used = new Set(cats.map(c => c.slot ?? 0))) {
  for (let s = 1; s <= MAX_SLOT; s++) if (!used.has(s)) return s;
  return 0;
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

// Next day's plan: only the repeating tasks, reset.
export function carryOver(tasks) {
  return tasks
    .filter(t => t.repeat)
    .map(t => ({ ...t, id: uid(), done: false, sessions: [], adjust: 0 }));
}

// A manually logged session from "HH:MM" inputs on a given day. An end before
// the start means it ran past midnight.
export function blockFromTimes(key, from, to) {
  if (!from || !to) return null;
  const base = parseKey(key).getTime();
  const at = hhmm => { const [h, m] = hhmm.split(':').map(Number); return base + (h * 60 + m) * 60000; };
  const s = at(from);
  let e = at(to);
  if (e === s) return null;
  if (e < s) e += 86400000;
  return { s, e };
}

// Default times for logging a block: ending now (rounded down to 5 min) on
// today, or 18:00 on other days; as long as the planned time (else 30 min).
export function suggestBlock(key, minutes) {
  const end = new Date(key === todayKey() ? Date.now() : parseKey(key).getTime() + 18 * 3600000);
  end.setMinutes(Math.floor(end.getMinutes() / 5) * 5, 0, 0);
  const start = new Date(end.getTime() - (minutes || 30) * 60000);
  if (dateKey(start) !== key) start.setTime(parseKey(key).getTime());
  return { from: hhmm(start), to: hhmm(end) };
}

export function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
  const v = s?.v ?? 1;
  return {
    v: SETTINGS_VERSION,
    categories: s?.categories?.length ? migrateCategories(s.categories, v) : structuredClone(DEFAULT_CATEGORIES),
    backlog: s?.backlog ?? DEFAULT_BACKLOG,
    memory: s?.memory ?? {},
    running: s?.running ?? null,
  };
}
