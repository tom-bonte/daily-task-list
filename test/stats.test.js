// Tests for the pure aggregation in public/js/stats.js. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, previousAnchor } from '../public/js/stats.js';
import { DEFAULT_CATEGORIES, parseKey, addDays } from '../public/js/model.js';

const at = (key, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return parseKey(key).getTime() + (h * 60 + m) * 60000;
};
const task = (text, cat, blocks, extra = {}) => ({ id: text, text, cat, done: true, repeat: false, target: null, adjust: 0, sessions: blocks, ...extra });

// A week in the past, so "today" never interferes: Mon 7 – Sun 13 Sep 2026.
const MON = '2026-09-07', TUE = '2026-09-08', WED = '2026-09-09', THU = '2026-09-10', FRI = '2026-09-11';
const days = [
  { date: MON, tasks: [task('Work', 'work', [{ s: at(MON, '09:00'), e: at(MON, '11:30') }]), task('AM run', 'sport', [{ s: at(MON, '07:15'), e: at(MON, '07:45') }])] },
  { date: TUE, tasks: [task('Work', 'work', [{ s: at(TUE, '09:30'), e: at(TUE, '10:30') }])] },
  // Wednesday: planned but nothing tracked, so it breaks the streak.
  { date: WED, tasks: [task('Work', 'work', [], { done: false })] },
  { date: THU, tasks: [task('Read Outlander', 'reading', [{ s: at(THU, '21:00'), e: at(THU, '22:00') }])] },
  { date: FRI, tasks: [task('Read Outlander', 'reading', [{ s: at(FRI, '21:10'), e: at(FRI, '21:40') }], { adjust: 10 * 60000 })] },
];
const now = at('2026-09-20', '12:00');

test('computeStats totals, buckets and per-task series for a week', () => {
  const st = computeStats(days, DEFAULT_CATEGORIES, 'week', WED, now);
  assert.equal(st.from, MON);
  assert.equal(st.to, '2026-09-13');
  assert.equal(st.total, (150 + 30 + 60 + 60 + 30 + 10) * 60000);
  assert.equal(st.activeDays, 4);
  assert.equal(st.daysSoFar, 7);
  assert.deepEqual([st.done, st.planned], [5, 6]);
  assert.equal(st.buckets.length, 7);
  assert.equal(st.buckets[0].total, 180 * 60000);
  assert.equal(st.buckets[2].total, 0);
  assert.deepEqual(st.catRows.map(r => r.cat.id), ['work', 'reading', 'sport']);

  const read = st.taskRows.find(t => t.text === 'Read Outlander');
  assert.equal(read.days.size, 2);
  assert.deepEqual(read.series.map(ms => ms / 60000), [0, 0, 0, 60, 40, 0, 0]);
});

test('computeStats finds streaks, the best day and the longest block', () => {
  const st = computeStats(days, DEFAULT_CATEGORIES, 'week', WED, now);
  assert.deepEqual(st.streak, { current: 0, best: 2 }); // Thu–Fri, then a quiet weekend
  assert.deepEqual(st.bestDay, { date: MON, ms: 180 * 60000 });
  assert.equal(st.longest.ms, 150 * 60000);
  assert.equal(st.longest.text, 'Work');
});

test('a quiet today keeps the current streak alive', () => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = k => `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const y1 = addDays(t(), -1), y2 = addDays(t(), -2);
  const recent = [y2, y1].map(k => ({ date: k, tasks: [task('Work', 'work', [{ s: at(k, '09:00'), e: at(k, '10:00') }])] }));
  const st = computeStats(recent, DEFAULT_CATEGORIES, 'month', t());
  assert.equal(st.streak.current, 2);
});

test('computeStats spreads blocks over the weekday × hour grid', () => {
  const st = computeStats(days, DEFAULT_CATEGORIES, 'week', WED, now);
  const mon = st.hours[0];
  assert.equal(mon[7], 30 * 60000);   // 07:15–07:45
  assert.equal(mon[9], 60 * 60000);   // 09:00–10:00 of the work block
  assert.equal(mon[11], 30 * 60000);  // 11:00–11:30
  assert.equal(mon[12], 0);
  assert.equal(st.hours[3][21], 60 * 60000); // Thursday reading
  assert.deepEqual(st.peak, { wd: 0, hour: 9, ms: 60 * 60000 });
  assert.equal(st.busiest, 0);        // Monday
  assert.equal(st.weekdayAvg[0], 180 * 60000);
});

test('year stats bucket by month and keep a per-day map for the calendar', () => {
  const st = computeStats(days, DEFAULT_CATEGORIES, 'year', WED, now);
  assert.equal(st.buckets.length, 12);
  assert.equal(st.buckets[8].total, st.total); // September
  assert.equal(st.perDay.size, 4);
  assert.deepEqual(st.perDay.get(MON).byCat, { work: 150 * 60000, sport: 30 * 60000 });
});

test('previousAnchor steps back one period', () => {
  assert.equal(previousAnchor('week', WED), '2026-09-02');
  assert.equal(previousAnchor('month', WED), '2026-08-01');
  assert.equal(previousAnchor('year', WED), '2025-01-01');
  assert.equal(previousAnchor('day', WED), TUE);
});
