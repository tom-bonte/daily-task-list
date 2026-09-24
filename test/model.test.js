// Tests for the pure logic in public/js/model.js. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/js/model.js';

// The Family preset is not one of the defaults, so add it where it matters.
const CATS = [...M.DEFAULT_CATEGORIES, { id: 'family', name: 'Family', emoji: '👪', slot: 9, keywords: M.presetKeywordsFor({ id: 'family' }) }];

const at = (key, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return M.parseKey(key).getTime() + (h * 60 + m) * 60000;
};

test('normText strips times and durations so a task groups across days', () => {
  assert.equal(M.normText('AM 1hr Read Outlander'), 'read outlander');
  assert.equal(M.normText('5:45-6:45 Read Outlander'), 'read outlander');
  assert.equal(M.normText('Read Outlander'), 'read outlander');
  assert.equal(M.normText('2hr Shopify'), 'shopify');
});

test('parseTarget reads planned minutes from the text', () => {
  assert.equal(M.parseTarget('2hr Shopify'), 120);
  assert.equal(M.parseTarget('5:45-6:45 Study'), 60);
  assert.equal(M.parseTarget('1h 30m Gym'), 90);
  assert.equal(M.parseTarget('1h30m Gym'), 30); // no space: only the minutes are read
  assert.equal(M.parseTarget('1,5 uur lezen'), 90);
  assert.equal(M.parseTarget('Evening routine'), null);
  assert.equal(M.parseTarget('23:30-00:30 Night shift'), null); // wraps midnight: no target
});

test('guessCategory prefers memory, then the earliest keyword, then the longest', () => {
  assert.equal(M.guessCategory('Ma bellen', {}, CATS), 'family'); // "ma" first, not the "bellen" errand
  assert.equal(M.guessCategory('2hr Shopify'), 'business');
  assert.equal(M.guessCategory('Iets onbekends'), 'general');
  assert.equal(M.guessCategory('Bellen met de bank', {}, CATS), 'home');
  assert.equal(M.guessCategory('Read Outlander', { 'read outlander': 'study' }), 'study');
  // A remembered category that no longer exists falls back to the keywords.
  assert.equal(M.guessCategory('Read Outlander', { 'read outlander': 'gone' }), 'reading');
  assert.equal(M.explainGuess('Ma bellen', CATS).kw, 'ma');
  assert.equal(M.explainGuess('Iets onbekends').kw, null);
});

test('keywords match whole words, and a trailing * matches any ending', () => {
  assert.equal(M.guessCategory('Zwembadonderhoud'), 'general'); // not "bad" inside a word
  assert.equal(M.guessCategory('Swimming'), 'sport');           // swim*
  assert.equal(M.guessCategory('Factura Movistar'), 'work');    // factura*
});

test('learnableWord skips numbers, times and filler', () => {
  assert.equal(M.learnableWord('2hr Make plan tomorrow'), 'plan');
  assert.equal(M.learnableWord('5:45-6:45 Padel'), 'padel');
  assert.equal(M.learnableWord('1hr'), null);
});

test('tidySessions drops misclicks, merges close blocks and keeps a run last', () => {
  const d = '2026-09-18';
  const out = M.tidySessions([
    { s: at(d, '09:00'), e: at(d, '09:30') },
    { s: at(d, '09:31'), e: at(d, '10:00') }, // 1 min gap: merged
    { s: at(d, '11:00'), e: at(d, '11:00') + 30000 }, // 30s: dropped
    { s: at(d, '12:00'), e: null },
  ]);
  assert.deepEqual(out, [
    { s: at(d, '09:00'), e: at(d, '10:00') },
    { s: at(d, '12:00'), e: null },
  ]);
  assert.equal(M.isRunning({ sessions: out }), true);
});

test('taskMs sums blocks plus the manual adjustment', () => {
  const d = '2026-09-18';
  const task = { sessions: [{ s: at(d, '09:00'), e: at(d, '10:00') }, { s: at(d, '11:00'), e: null }], adjust: 5 * 60000 };
  assert.equal(M.taskMs(task, at(d, '11:30')), 95 * 60000);
  assert.equal(M.fmtDur(M.taskMs(task, at(d, '11:30'))), '1h 35m');
  assert.equal(M.taskMs({ sessions: [], adjust: -60000 }), 0); // never negative
});

test('overlapMs reports double-counted time only', () => {
  const d = '2026-09-18';
  const apart = [{ sessions: [{ s: at(d, '09:00'), e: at(d, '10:00') }] }, { sessions: [{ s: at(d, '10:00'), e: at(d, '11:00') }] }];
  assert.equal(M.overlapMs(apart, at(d, '12:00')), 0);
  const over = [{ sessions: [{ s: at(d, '09:00'), e: at(d, '10:00') }] }, { sessions: [{ s: at(d, '09:30'), e: null }] }];
  assert.equal(M.overlapMs(over, at(d, '10:00')), 30 * 60000);
});

test('carryOver copies only the repeating tasks, reset', () => {
  const done = { id: 'a', text: 'AM run', cat: 'sport', done: true, repeat: true, sessions: [{ s: 1, e: 2 }], adjust: 9 };
  const once = { id: 'b', text: 'Call the bank', cat: 'home', done: false, repeat: false, sessions: [], adjust: 0 };
  const [next, ...rest] = M.carryOver([done, once]);
  assert.equal(rest.length, 0);
  assert.equal(next.text, 'AM run');
  assert.notEqual(next.id, 'a');
  assert.deepEqual([next.done, next.sessions, next.adjust], [false, [], 0]);
});

test('copyForDay keeps the plan and drops the logged time', () => {
  const t = { id: 'a', text: '1hr Read Outlander', cat: 'reading', done: true, repeat: true, target: 60, sessions: [{ s: 1, e: 2 }], adjust: 5 };
  const copy = M.copyForDay(t);
  assert.notEqual(copy.id, 'a');
  assert.deepEqual(
    { text: copy.text, cat: copy.cat, target: copy.target, repeat: copy.repeat },
    { text: t.text, cat: t.cat, target: 60, repeat: true });
  assert.deepEqual([copy.done, copy.sessions, copy.adjust], [false, [], 0]);
  // A running task is not copied as running.
  assert.equal(M.isRunning(M.copyForDay({ ...t, sessions: [{ s: 1, e: null }] })), false);
  assert.deepEqual(t.sessions, [{ s: 1, e: 2 }], 'the original is untouched');
});

test('normHHMM accepts the shapes people type', () => {
  assert.equal(M.normHHMM('930'), '09:30');
  assert.equal(M.normHHMM('9:30'), '09:30');
  assert.equal(M.normHHMM('09.30'), '09:30');
  assert.equal(M.normHHMM('9'), '09:00');
  assert.equal(M.normHHMM('24:00'), null);
  assert.equal(M.normHHMM('9:60'), null);
  assert.equal(M.normHHMM(''), null);
});

test('blockFromTimes builds a block, wrapping past midnight', () => {
  const d = '2026-09-18';
  assert.deepEqual(M.blockFromTimes(d, '930', '10:00'), { s: at(d, '09:30'), e: at(d, '10:00') });
  assert.deepEqual(M.blockFromTimes(d, '23:30', '00:30'), { s: at(d, '23:30'), e: at(d, '23:30') + 3600000 });
  assert.equal(M.blockFromTimes(d, '09:00', '09:00'), null);
  assert.equal(M.blockFromTimes(d, 'nope', '10:00'), null);
});

test('dates: keys are local, and periods run Monday to Sunday', () => {
  assert.equal(M.dateKey(new Date(2026, 8, 18, 23, 30)), '2026-09-18');
  assert.equal(M.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(M.addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(M.periodRange('week', '2026-09-18'), { from: '2026-09-14', to: '2026-09-20' }); // Fri → Mon..Sun
  assert.deepEqual(M.periodRange('week', '2026-09-20'), { from: '2026-09-14', to: '2026-09-20' }); // Sunday is the end
  assert.deepEqual(M.periodRange('month', '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(M.periodRange('year', '2026-02-10'), { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(M.shiftPeriod('month', '2026-01-15', -1), '2025-12-01');
});

test('withDefaults migrates old settings and keeps running a list', () => {
  const s = M.withDefaults(null);
  assert.equal(s.v, M.SETTINGS_VERSION);
  assert.deepEqual(s.running, []);
  assert.ok(s.categories.some(c => c.id === M.FALLBACK_CAT));

  // v1 had no Work category, no keywords, and a single running timer.
  const old = M.withDefaults({ v: 1, categories: [{ id: 'general', name: 'General', slot: 0 }, { id: 'sport', name: 'Sport', slot: 1 }], running: { id: 'x', date: '2026-09-18' } });
  assert.ok(old.categories.some(c => c.id === 'work'), 'Work is added');
  assert.ok(old.categories.every(c => Array.isArray(c.keywords)), 'every category gets keywords');
  assert.deepEqual(old.running, [{ id: 'x', date: '2026-09-18' }]);
  const slots = old.categories.map(c => c.slot).filter(x => x !== 0);
  assert.equal(new Set(slots).size, slots.length, 'colors stay unique');
});

test('freeSlot picks the first unused colour', () => {
  assert.equal(M.freeSlot([{ slot: 0 }, { slot: 1 }, { slot: 3 }]), 2);
  assert.equal(M.freeSlot(Array.from({ length: M.MAX_SLOT }, (_, i) => ({ slot: i + 1 }))), 0);
});

test('parseBackup rejects files that are not an export', () => {
  assert.match(M.parseBackup(null).error, /not a Habits Rabbits export/);
  assert.match(M.parseBackup([1, 2]).error, /not a Habits Rabbits export/);
  assert.match(M.parseBackup({ hello: 'world' }).error, /no days and no settings/);
});

test('parseBackup keeps good days, repairs sessions and skips junk', () => {
  const d = '2026-09-18';
  const exported = new Date(at(d, '20:00')).toISOString();
  const b = M.parseBackup({
    exported,
    settings: { v: 3, categories: [{ id: 'general', name: 'General', slot: 0, keywords: [] }], memory: { shopify: 'business' }, running: [{ id: 'x' }] },
    days: [
      { date: '2026-09-19', tasks: [{ id: 'a', text: '2hr Shopify', cat: 'business', done: true, sessions: [{ s: at(d, '09:00'), e: at(d, '10:00') }], adjust: 60000 }] },
      { date: d, tasks: [
        { text: 'Running timer', sessions: [{ s: at(d, '19:00'), e: null }] },
        { text: 'Broken blocks', sessions: [{ s: 'oops', e: 1 }, { s: 5, e: 4 }, 'nope'] },
        { text: '   ' },      // no text: skipped
        { id: 'z' },          // no text: skipped
      ] },
      { date: '2026-02-31', tasks: [] }, // not a real date: skipped
      { date: 'yesterday', tasks: [] },  // skipped
      { tasks: [] },                     // skipped
    ],
  });

  assert.equal(b.error, null);
  assert.deepEqual(b.days.map(x => x.date), [d, '2026-09-19'], 'days come back sorted');
  assert.equal(b.skippedDays, 3);
  assert.equal(b.skippedTasks, 2);
  assert.equal(b.droppedBlocks, 3);

  const kept = b.days[1].tasks[0];
  assert.deepEqual(kept, { id: 'a', text: '2hr Shopify', cat: 'business', done: true, repeat: false, target: 120, sessions: [{ s: at(d, '09:00'), e: at(d, '10:00') }], adjust: 60000 });

  // A timer still running in the file stops at the export time, not now.
  assert.equal(b.closedRuns, 1);
  assert.deepEqual(b.days[0].tasks[0].sessions, [{ s: at(d, '19:00'), e: at(d, '20:00') }]);
  assert.deepEqual(b.days[0].tasks[1].sessions, []);
  assert.ok(b.days[0].tasks.every(t => t.id), 'a task without an id gets one');

  // Settings come back migrated, with nothing running.
  assert.equal(b.settings.v, M.SETTINGS_VERSION);
  assert.deepEqual(b.settings.running, []);
  assert.deepEqual(b.settings.memory, { shopify: 'business' });
});

test('parseBackup drops open sessions when the file has no export time', () => {
  const b = M.parseBackup({ days: [{ date: '2026-09-18', tasks: [{ text: 'Running', sessions: [{ s: 1, e: null }] }] }] });
  assert.deepEqual(b.days[0].tasks[0].sessions, []);
  assert.equal(b.closedRuns, 0);
  assert.equal(b.droppedBlocks, 1);
  assert.equal(b.settings, null);
});

test('parseBackup keeps the last copy of a repeated date', () => {
  const b = M.parseBackup({ days: [
    { date: '2026-09-18', tasks: [{ text: 'First' }] },
    { date: '2026-09-18', tasks: [{ text: 'Second' }] },
  ] });
  assert.equal(b.days.length, 1);
  assert.equal(b.days[0].tasks[0].text, 'Second');
});

test('an export round-trips through parseBackup', () => {
  const day = { date: '2026-09-18', tasks: [M.newTask('2hr Shopify', 'business'), M.newTask('AM run', 'sport')] };
  const file = JSON.parse(JSON.stringify({ exported: new Date().toISOString(), settings: M.withDefaults(null), days: [day] }));
  const b = M.parseBackup(file);
  assert.equal(b.error, null);
  assert.deepEqual(b.days, [day]);
  assert.deepEqual(b.settings, M.withDefaults(file.settings));
});
