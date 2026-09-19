// localStorage-backed store with the same interface as createFirestoreStore.
// Used by demo mode (?demo) to try the app without signing in.
const KEY = 'dtl-demo';

export function createLocalStore() {
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { settings: null, days: {} }; } catch { return { settings: null, days: {} }; } };
  const data = load();
  const listeners = new Set(); // { topic, fn }
  const persist = topic => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* storage unavailable: keep in memory */ }
    for (const l of listeners) if (l.topic === topic) l.fn();
  };
  const clone = v => (v == null ? null : structuredClone(v));
  const watch = (topic, read, cb) => {
    const l = { topic, fn: () => cb(clone(read())) };
    listeners.add(l);
    queueMicrotask(l.fn);
    return () => listeners.delete(l);
  };

  return {
    watchSettings: cb => watch('settings', () => data.settings, cb),
    saveSettings: async s => { data.settings = clone(s); persist('settings'); },
    watchDay: (key, cb) => watch(`day:${key}`, () => data.days[key], cb),
    getDay: async key => clone(data.days[key]),
    saveDay: async (key, d) => { data.days[key] = { ...clone(d), date: key }; persist(`day:${key}`); },
    getDaysRange: async (from, to) => Object.values(data.days).filter(d => d.date >= from && d.date <= to).map(clone),
    getLastDayBefore: async key => clone(Object.values(data.days).filter(d => d.date < key).sort((a, b) => b.date.localeCompare(a.date))[0]),
  };
}
