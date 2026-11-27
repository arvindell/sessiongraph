import assert from 'node:assert/strict';
import test from 'node:test';
import { timeX } from '@sessiongraph/core/layout';
import { monthTicks } from '@sessiongraph/core/month-ticks';

test('month labels use local boundaries on the preserved graph time scale', () => {
  const start = +new Date(2025, 11, 15), end = +new Date(2026, 2, 5);
  const range = { start, end, timeFrame: { start: +new Date(2025, 10, 1), end } };
  const ticks = monthTicks(range);
  assert.deepEqual(ticks.map(tick => tick.label), ['Jan 2026', 'Feb 2026', 'Mar 2026']);
  assert.deepEqual(ticks.map(tick => tick.x), [0, 1, 2].map(month => timeX(+new Date(2026, month, 1), range)));
});

test('short views retain their month label and anonymous time has no calendar labels', () => {
  const range = { start: +new Date(2026, 10, 20), end: +new Date(2026, 10, 27) };
  assert.deepEqual(monthTicks(range), [{ x: -150, label: 'Nov 2026' }]);
  assert.deepEqual(monthTicks({ ...range, calendarTime: false }), []);
  assert.ok(monthTicks({ start: +new Date(2000, 0, 1), end: +new Date(2026, 11, 31) }).length <= 24);
});
