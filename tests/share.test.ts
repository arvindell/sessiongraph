import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph } from '../src/layout';
import { projectAliases, shareGraph } from '../src/share-graph';
import { playbackTokens } from '../src/playback-tokens';
import { PLAYBACK_DURATION, PLAYBACK_ORBIT_DURATION, PLAYBACK_END_HOLD, PLAYBACK_FRAMES, SHARE_FRAMES, gifFrameDelay, overviewTurn, playbackSessions, shareFrameProgress, shareFrameOutro } from '../src/playback';
import { createGifEncoder } from '../src/gif-encoder';
import type { Session } from '../src/types';

const session = (id: string, source: string, directory: string, extra: Partial<Session> = {}): Session => ({
  id, nativeID: 'private-native', source, title: 'Secret customer issue', directory, projectID: 'private-project',
  created: 1000, updated: 9000, activity: { firstMessageAt: 1000, lastMessageAt: 5000, userMessages: 4, untimedUserMessages: 0 },
  archived: false, model: 'private-model', provider: 'private-provider', agent: 'private-agent', cost: 5, tokens: 123, ...extra,
});

test('shared animation graph strips identifying text without mutating the library, merging streams, or losing ancestry and totals', () => {
  const original = makeGraph([
    session('secret-root', 'opencode', '/home/private/customer'),
    session('secret-fork', 'continue', '/home/private/customer', { created: 2000, forkID: 'secret-root' }),
    session('secret-child', 'claude-code', '/home/private/worktree', { created: 3000, parentID: 'secret-root' }),
    session('secret-fallback', 'continue', '', { activity: undefined }),
  ], [{ id: 'private-project', name: 'Secret business', directory: '/home/private/customer', worktrees: ['/home/private/worktree'] }]);
  const before = structuredClone(original), safe = shareGraph(original), text = JSON.stringify(safe);
  assert.doesNotMatch(text, /private|secret|customer|worktree|home/i);
  assert.deepEqual(original, before);
  assert.equal(safe.lanes.length, 3);
  assert.equal(new Set(safe.lanes.map(lane => lane.label)).size, 3);
  assert.ok(safe.lanes.every(lane => /^Project [A-Za-z]+ [A-Za-z]+$/.test(lane.label)));
  assert.deepEqual(safe.nodes.map(node => [node.position, node.startPosition, node.radius, node.color]), original.nodes.map(node => [node.position, node.startPosition, node.radius, node.color]));
  assert.deepEqual(safe.edges.map(edge => edge.kind), ['fork', 'child']);
  assert.ok(safe.edges.every(edge => safe.nodes.some(node => node.session.id === edge.from) && safe.nodes.some(node => node.session.id === edge.to)));
  for (const time of [1000, 3000, 5000, Infinity]) {
    assert.deepEqual(playbackTokens(safe.nodes.map(node => node.session)).at(time, time === Infinity), playbackTokens(original.nodes.map(node => node.session)).at(time, time === Infinity));
    assert.equal(playbackSessions(safe.nodes.map(node => node.session))(time), playbackSessions(original.nodes.map(node => node.session))(time));
  }
});

test('aliases stay unique with collisions and libraries larger than the word-pair pool', () => {
  const names = projectAliases(2100, () => 0);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every(name => /^Project [A-Za-z]+ [A-Za-z]+$/.test(name)));
  assert.notDeepEqual(projectAliases(20, () => 0), projectAliases(20, () => .5));
});

test('session counter follows creation and rewind, including unknown usage and all sources', () => {
  const sessions = [
    session('claude', 'claude-code', '', { created: 3000, tokens: null }),
    session('root', 'opencode', '', { created: 1000 }),
    session('untimed', 'continue', '', { created: 2000, tokens: null, activity: undefined }),
    session('fork', 'opencode', '', { created: 2000, forkID: 'root' }),
  ];
  const counter = playbackSessions(sessions);
  assert.deepEqual([0, 1000, 1999, 2000, 5000, 1000].map(time => counter(time)), [0, 1, 1, 3, 4, 1]);
  assert.equal(counter(0, true), 4);
  assert.equal(playbackSessions([])(5000), 0);
});

test('GIF encodes the timeline, full overview orbit, and ending hold with bounded centisecond rounding', () => {
  const encoder = createGifEncoder();
  const rgba = new Uint8Array(2 * 2 * 4).fill(255);
  for (let frame = 0; frame < SHARE_FRAMES; frame++) { rgba[0] = frame % 256; encoder.add(rgba, 2, 2); }
  const bytes = Buffer.from(encoder.finish());
  assert.equal(bytes.subarray(0, 6).toString(), 'GIF89a');
  let offset = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), frames = 0, duration = 0;
  const subblocks = () => { while (bytes[offset]) { offset += bytes[offset] + 1; } offset++; };
  while (bytes[offset] !== 0x3b) {
    const type = bytes[offset++];
    if (type === 0x21) {
      const extension = bytes[offset++];
      if (extension === 0xf9) { duration += bytes.readUInt16LE(offset + 2) * 10; }
      subblocks();
    } else {
      assert.equal(type, 0x2c); frames++;
      assert.equal(bytes.readUInt16LE(offset + 4), 2); assert.equal(bytes.readUInt16LE(offset + 6), 2);
      const packed = bytes[offset + 8]; offset += 9;
      if (packed & 128) offset += 3 * 2 ** ((packed & 7) + 1);
      offset++; subblocks();
    }
  }
  assert.equal(frames, 630); assert.equal(duration, 21_000); assert.equal(duration, PLAYBACK_DURATION + PLAYBACK_ORBIT_DURATION + PLAYBACK_END_HOLD);
  assert.equal(shareFrameProgress(0), 0);
  assert.ok(shareFrameProgress(PLAYBACK_FRAMES - 2) < 1);
  assert.equal(shareFrameProgress(PLAYBACK_FRAMES - 1), 1);
  assert.equal(shareFrameProgress(SHARE_FRAMES - 1), 1);
  assert.equal(shareFrameOutro(449), null);
  assert.equal(shareFrameOutro(450), 1 / 150);
  assert.equal(shareFrameOutro(599), 1);
  assert.equal(shareFrameOutro(629), 1);
  let elapsed = 0;
  for (let frame = 0; frame < SHARE_FRAMES; frame++) { elapsed += gifFrameDelay(frame); assert.ok(Math.abs(elapsed - (frame + 1) * 1000 / 30) < 5); }
});

test('overview makes a full turn with a prolonged smooth slowdown and no end drift', () => {
  assert.equal(overviewTurn(0), 0); assert.equal(overviewTurn(1), 1);
  assert.equal(overviewTurn(2), 1);
  const turns = Array.from({ length: 151 }, (_, frame) => overviewTurn(frame / 150));
  const steps = turns.slice(1).map((turn, index) => turn - turns[index]);
  assert.ok(steps.every(step => step > 0 && step * 30 * 360 < 95), 'No fast midpoint');
  assert.ok(steps[0] < steps[20]);
  for (let index = 100; index < steps.length - 1; index++) assert.ok(steps[index] > steps[index + 1], 'Slows smoothly over the final third');
  assert.ok(steps.at(-1)! < steps[50] / 1000, 'Settles at a near-zero velocity instead of snapping to a stop');
});
