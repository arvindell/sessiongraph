import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionAtlasStore } from '../server/store';
import { blankMessage, blankSession } from '../server/adapters/common';
import { handoffDocument, saveHandoff } from '../server/handoff';
import { prepareLaunch } from '../server/launch';
import { HARNESSES, type HarnessID } from '../src/launch-links';

const messages = (length: number) => Array.from({ length }, (_, i) => ({ ...blankMessage(`m${i}`, 1_000 + i, i % 2 ? 'assistant' : 'user'), fragments: [{ kind: i % 2 ? 'Assistant' as const : 'You' as const, text: `turn-${i}-end`, time: 1_000 + i }] }));

test('handoffs preserve the original request and latest chronological context with honest coverage', () => {
  const store = new SessionAtlasStore(':memory:');
  const c = { session: blankSession('opencode', 'ses_test'), revision: 'r1', locator: {} };
  try {
    store.upsert(c); store.replace(c, messages(250), false);
    const snapshot = store.handoff(c.session.id);
    assert.equal(snapshot.messages.length, 200); assert.equal(snapshot.messages[0].id, 'm50');
    const doc = handoffDocument(snapshot);
    assert.equal(doc.messages, 201); assert.equal(doc.totalMessages, 250); assert.equal(doc.partial, true);
    assert.ok(doc.text.indexOf('turn-0-end') < doc.text.indexOf('turn-50-end'));
    assert.ok(doc.text.indexOf('turn-50-end') < doc.text.indexOf('turn-249-end'));
    assert.ok(!doc.text.includes('turn-1-end'));
    store.replace(c, messages(2), false);
    assert.equal(handoffDocument(store.handoff(c.session.id)).partial, false);
    const long = messages(20); long.forEach((m) => { m.fragments[0].text = 'prefix-' + 'x'.repeat(30_000) + '-suffix'; });
    store.replace(c, long, true, 'Interrupted history');
    const bounded = handoffDocument(store.handoff(c.session.id));
    assert.ok(bounded.text.length < 170_000); assert.ok(bounded.text.includes('prefix-')); assert.ok(bounded.text.includes('-suffix'));
    assert.equal(bounded.partial, true); assert.match(bounded.note, /shortened/); assert.match(bounded.note, /Interrupted history/);
    store.replace(c, [], false);
    assert.throws(() => handoffDocument(store.handoff(c.session.id)), /Import this session/);
  } finally { store.close(); }
});

test('handoff files are private, atomic, stable and saved outside the working project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-atlas-handoff-'));
  const snapshot = { session: { ...blankSession('test', 'id'), coverage: { history: 'complete' as const } }, messages: messages(3), firstUser: undefined, totalMessages: 3 };
  try {
    const [a, b] = await Promise.all([saveHandoff(snapshot, dir), saveHandoff(snapshot, dir)]);
    assert.equal(a.path, b.path); assert.equal(await readFile(a.path, 'utf8'), handoffDocument(snapshot).text);
    assert.equal((await readdir(join(dir, 'handoffs'))).length, 1);
    if (process.platform !== 'win32') { assert.equal((await stat(a.path)).mode & 0o777, 0o600); assert.equal((await stat(join(dir, 'handoffs'))).mode & 0o777, 0o700); }
  } finally { await rm(dir, { recursive: true }); }
});

test('all harness pairs prepare native resumes or saved-context launches without executing agents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-atlas-prepare-'));
  const store = new SessionAtlasStore(join(dir, 'library.sqlite'));
  try {
    for (const source of HARNESSES) {
      const c = { session: { ...blankSession(source.id, source.id === 'opencode' ? 'ses_native' : 'native-id', dir), nativeResume: true }, revision: 'r1', locator: {} };
      store.upsert(c); store.replace(c, messages(3), false);
      for (const target of HARNESSES) {
        const prepared = await prepareLaunch(store, c.session, target.id);
        assert.equal(prepared.mode, source.id === target.id ? 'resume' : 'handoff');
        assert.equal(prepared.directory, dir);
        if (source.id === target.id) { assert.equal(prepared.context, undefined); assert.match(prepared.command, /native/); }
        else { assert.ok(prepared.context); assert.ok(prepared.context.path.startsWith(join(dir, 'handoffs'))); assert.equal(prepared.context.messages, 3); assert.match(prepared.command, /saved conversation/); }
      }
    }
    const child = { ...blankSession('claude-code', 'parent/agent/child', dir), parentID: 'claude-code:parent' };
    const c = { session: child, revision: 'r1', locator: {} }; store.upsert(c); store.replace(c, messages(1), false);
    assert.equal((await prepareLaunch(store, child, 'claude-code')).mode, 'handoff');
    await assert.rejects(prepareLaunch(store, child, 'invalid' as HarnessID), /supported destination/);
    await assert.rejects(prepareLaunch(store, child, 'codex', 'relative'), /absolute working directory/);
    await assert.rejects(prepareLaunch(store, child, 'codex', join(dir, 'missing')), /unavailable/);
    await assert.rejects(prepareLaunch(store, { ...child, nativeID: '--help', parentID: undefined }, 'claude-code'), /cannot be resumed/);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});
