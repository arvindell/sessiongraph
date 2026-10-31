import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackTokens, sumRecordedTokens } from '../src/playback-tokens';
import { blankSession } from '../server/adapters/common';

const session = (id: string, tokens: number | null, end: number | null, source = 'opencode') => ({
  ...blankSession(source, id), created: 10, tokens,
  activity: { firstMessageAt: 10, lastMessageAt: end, userMessages: 1, untimedUserMessages: 0 },
});

test('playback totals follow saved endpoints and reverse scrubbing, with no prorating or unsupported usage', () => {
  const index = playbackTokens([session('long', 900, 90), session('short', 100, 20), session('simultaneous', 50, 20, 'continue'), session('unknown', null, 25), session('unsupported', 500, 15, 'codex'), session('zero', 0, 30)]);
  assert.deepEqual(index.at(10), { tokens: 0, sessions: 0 });
  assert.deepEqual(index.at(20), { tokens: 150, sessions: 2 });
  assert.deepEqual(index.at(80), { tokens: 150, sessions: 3 });
  assert.deepEqual(index.at(90), { tokens: 1050, sessions: 4 });
  assert.deepEqual(index.at(19), { tokens: 0, sessions: 0 });
  assert.equal(index.recorded, 4); assert.equal(index.missing, 2);
  assert.deepEqual(playbackTokens([session('updated', 200, 40)]).at(35), { tokens: 0, sessions: 0 });
});

test('unknown token values stay unknown and untimed totals enter only at playback completion', () => {
  for (const values of [[], [undefined, 1], [null, 1], [NaN, 1], [Infinity], [-1], [1.5], [Number.MAX_SAFE_INTEGER, 1]]) assert.equal(sumRecordedTokens(values), null);
  assert.equal(sumRecordedTokens([0, 0, 0, 0]), 0);
  assert.equal(sumRecordedTokens([100, 20, 50, 10]), 180);
  const index = playbackTokens([session('untimed', 600, null), session('invalid', -1, 20), session('invalid2', Infinity, 20)]);
  assert.equal(index.recorded, 1); assert.equal(index.untimed, 1);
  assert.deepEqual(index.at(100), { tokens: 0, sessions: 0 });
  assert.deepEqual(index.at(100, true), { tokens: 600, sessions: 1 });
  assert.equal(playbackTokens([]).recorded, 0);
});
