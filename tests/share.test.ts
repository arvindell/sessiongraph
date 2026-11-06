import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph } from '@sessiongraph/core/layout';
import { projectAliases, shareGraph } from '../src/share-graph';
import { playbackTokens } from '../src/playback-tokens';
import { PLAYBACK_DURATION, PLAYBACK_ORBIT_DURATION, PLAYBACK_END_HOLD, PLAYBACK_FRAMES, SHARE_FRAMES, SHARE_FPS, overviewTurn, playbackSessions, shareFrameProgress, shareFrameOutro } from '@sessiongraph/core/playback';
import { SHARE_FORMATS } from '../src/share-files';
import { switchShareMode } from '../src/share-modes';
import type { Session } from '@sessiongraph/core/types';

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

test('video is MP4-only and covers the full timeline, overview orbit, and ending hold', () => {
  assert.deepEqual(Object.keys(SHARE_FORMATS), ['mp4']);
  assert.equal(SHARE_FORMATS.mp4.mime, 'video/mp4');
  assert.equal(SHARE_FORMATS.mp4.filename, 'sessiongraph-playback.mp4');
  const duration = SHARE_FRAMES / SHARE_FPS * 1000;
  assert.equal(SHARE_FRAMES, 630); assert.equal(duration, 21_000); assert.equal(duration, PLAYBACK_DURATION + PLAYBACK_ORBIT_DURATION + PLAYBACK_END_HOLD);
  assert.equal(shareFrameProgress(0), 0);
  assert.ok(shareFrameProgress(PLAYBACK_FRAMES - 2) < 1);
  assert.equal(shareFrameProgress(PLAYBACK_FRAMES - 1), 1);
  assert.equal(shareFrameProgress(SHARE_FRAMES - 1), 1);
  assert.equal(shareFrameOutro(449), null);
  assert.equal(shareFrameOutro(450), 1 / 150);
  assert.equal(shareFrameOutro(599), 1);
  assert.equal(shareFrameOutro(629), 1);
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

test('switching share modes finishes queued dialog cleanup before opening the next view', async () => {
  const events: string[] = [];
  class TestDialog extends EventTarget {
    open = true;
    close() { this.open = false; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
  }
  const dialog = new TestDialog();
  dialog.addEventListener('close', () => events.push('cleanup'));
  const select = (mode: string) => events.push(mode);
  switchShareMode(dialog as unknown as HTMLDialogElement, 'video', select);
  switchShareMode(dialog as unknown as HTMLDialogElement, 'video', select);
  assert.deepEqual(events, []);
  await Promise.resolve();
  assert.deepEqual(events, ['cleanup', 'video']);
  dialog.dispatchEvent(new Event('close'));
  assert.deepEqual(events, ['cleanup', 'video', 'cleanup']);
});
