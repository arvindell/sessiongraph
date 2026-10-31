import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, truncate, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeAdapter } from '../server/adapters/claude';
import { claudeRevision, claudeTranscript } from '../server/adapters/claude-transcripts';
import { Importer } from '../server/importer';
import { SessionGraphStore } from '../server/store';
import type { Candidate, ImportedMessage } from '../server/adapters/types';

const time = Date.parse('2026-10-20T10:00:00Z');
const cwd = 'C:\\Users\\Example User\\Code\\app';
const idePrompt = '<ide_opened_file>The user opened src/main.ts in the IDE.</ide_opened_file>\nFix the app 🌌';
function conversation(id: string, count = 2, prompt = idePrompt) {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: id, uuid: `${id}-${i}`, parentUuid: i ? `${id}-${i - 1}` : null,
    cwd, entrypoint: 'vscode', isSidechain: false, version: '2.1.300',
    type: i % 2 ? 'assistant' : 'user', timestamp: new Date(time + i * 60_000).toISOString(),
    message: { role: i % 2 ? 'assistant' : 'user', ...(i % 2 ? { model: 'synthetic-model' } : {}), content: i ? 'Repeated message' : prompt },
  }));
}
async function put(root: string, path: string, rows: unknown[]) {
  const file = join(root, 'projects', path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, rows.map(row => JSON.stringify(row)).join('\r\n') + '\r\n');
  return file;
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sessiongraph-claude-')), previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try { await run(root); }
  finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; await rm(root, { recursive: true, force: true }); }
}
async function read(candidate: Candidate) {
  const messages: ImportedMessage[] = []; let cursor: string | undefined;
  do { const page = await claudeAdapter.read(candidate, cursor); messages.push(...page.messages); cursor = page.cursor; } while (cursor);
  return messages;
}

test('Claude legacy transcripts work without a projects directory and defer to native project history', async () => fixture(async root => {
  const id = randomUUID(); await mkdir(join(root, 'transcripts'));
  await writeFile(join(root, 'transcripts', 'export.jsonl'), conversation(id).map(r => JSON.stringify(r)).join('\n'));
  assert.equal(await claudeAdapter.detect(), true);
  const found = await claudeAdapter.discover(); assert.equal(found.sessions.length, 1); assert.equal((await read(found.sessions[0])).length, 2);
  await put(root, `project/${id}.jsonl`, conversation(id, 4));
  const authoritative = await claudeAdapter.discover(); assert.equal(authoritative.sessions.length, 1); assert.equal((await read(authoritative.sessions[0])).length, 4);
}));

test('Claude imports VS Code IDE-prefixed prompts and Windows paths with recorded message times', async () => fixture(async root => {
  const id = randomUUID(), file = await put(root, `C--Users-Example-User-Code-app/${id}.jsonl`, conversation(id));
  const before = await readFile(file), store = new SessionGraphStore(':memory:');
  try {
    const importer = new Importer(store, [claudeAdapter]);
    importer.start(['claude-code']); await importer.settled();
    assert.equal(importer.status.imported, 1, JSON.stringify(importer.status));
    assert.equal(importer.status.failed, 0);
    const session = store.getSession(`claude-code:${id}`)!;
    assert.equal(session.title, 'Fix the app 🌌'); assert.equal(session.directory, cwd);
    assert.equal(session.created, time); assert.equal(session.model, 'synthetic-model');
    assert.equal(session.activity?.firstMessageAt, time); assert.equal(session.activity?.lastMessageAt, time + 60_000);
    assert.equal(store.content(session.id).messages, 2);
    assert.ok(store.content(session.id).fragments.some(f => f.text.includes('Fix the app 🌌')));
    importer.start(); await importer.settled(); assert.equal(importer.status.unchanged, 1);
    assert.deepEqual(await readFile(file), before);
  } finally { store.close(); }
}));

test('Claude reads the discovered snapshot when cwd differs and deduplicates copied native sessions', async () => fixture(async root => {
  const id = randomUUID();
  const old = await put(root, `original-folder/${id}.jsonl`, conversation(id, 2, 'Old copy'));
  const current = await put(root, `C--Moved-Workspace/${id}.jsonl`, conversation(id, 2, 'Latest copy'));
  await utimes(old, new Date(time), new Date(time)); await utimes(current, new Date(time + 1000), new Date(time + 1000));
  const discovery = await claudeAdapter.discover();
  assert.equal(discovery.sessions.length, 1);
  const candidate = discovery.sessions[0]; assert.equal(candidate.locator.path, current);
  assert.equal((await read(candidate))[0].fragments[0].text, 'Latest copy');
  assert.equal(candidate.session.parentID, undefined); assert.equal(candidate.session.forkID, undefined);
}));

test('Claude subagents preserve explicit parent metadata and unknown timestamps', async () => fixture(async root => {
  const id = randomUUID(), project = 'C--Code-app';
  await put(root, `${project}/${id}.jsonl`, conversation(id));
  const rows = conversation(id).map(row => ({ ...row, isSidechain: true, timestamp: undefined }));
  const child = await put(root, `${project}/${id}/subagents/agent-child.jsonl`, rows);
  await writeFile(child.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ parentAgentId: 'parent-agent', toolUseId: 'toolu_spawn' }));
  const discovery = await claudeAdapter.discover(); assert.equal(discovery.sessions.length, 2);
  const candidate = discovery.sessions.find(c => c.locator.agent === 'child')!;
  const messages = await read(candidate);
  assert.equal(messages.length, 2); assert.ok(messages.every(m => m.time === 0));
  assert.equal(candidate.session.parentID, `claude-code:${id}/agent/parent-agent`);
  assert.ok(messages.flatMap(m => m.events || []).every(event => event.parentID === 'toolu_spawn'));
  const before = candidate.revision;
  await writeFile(child.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ parentAgentId: 'another-parent', toolUseId: 'toolu_spawn' }));
  assert.notEqual(await claudeRevision(child), before);
  await assert.rejects(claudeAdapter.read(candidate), /changed during import/);
}));

test('Claude paginates repeated native messages and retains successful edits across page boundaries', async () => fixture(async root => {
  const id = randomUUID(), rows = conversation(id, 245, 'Many messages');
  rows[119].message.content = [{ type: 'tool_use', id: 'edit-call', name: 'Edit', input: { file_path: 'C:\\Code\\app\\main.ts' } }] as any;
  rows[120].message.content = [{ type: 'tool_result', tool_use_id: 'edit-call', content: 'Updated' }] as any;
  const file = await put(root, `C--Code-app/${id}.jsonl`, rows);
  const candidate = (await claudeAdapter.discover()).sessions[0];
  const messages = await read(candidate);
  assert.equal(messages.length, 245); assert.deepEqual(messages.map(m => m.id), rows.map(row => row.uuid));
  assert.deepEqual(messages[120].files.map(f => f.path), ['C:\\Code\\app\\main.ts']);
  assert.equal(messages.at(-1)?.time, time + 244 * 60_000);
  await assert.rejects(claudeAdapter.read(candidate, '-1'), /Invalid history cursor/);
  await writeFile(file, (await readFile(file, 'utf8')) + JSON.stringify({ type: 'summary', summary: 'Changed' }) + '\n');
  await assert.rejects(claudeAdapter.read(candidate, '120'), /changed during import/);
}));

test('Claude skips non-session files and sidechains, discloses malformed records, and bounds snapshots', async () => fixture(async root => {
  const id = randomUUID(), sideID = randomUUID(), wrongID = randomUUID();
  const file = await put(root, `C--Code-app/${id}.jsonl`, conversation(id));
  await writeFile(file, (await readFile(file, 'utf8')) + '{broken\r\n');
  await put(root, `C--Code-app/${sideID}.jsonl`, conversation(sideID).map(row => ({ ...row, isSidechain: true })));
  await put(root, `C--Code-app/${wrongID}.jsonl`, [{ type: 'file-history-snapshot', sessionId: wrongID }]);
  await put(root, `C--Code-app/${id}.orphaned-123-backup.jsonl`, conversation(id));
  const discovery = await claudeAdapter.discover(); assert.equal(discovery.sessions.length, 1);
  assert.equal((await claudeAdapter.read(discovery.sessions[0])).partial, true);
  const oversized = await put(root, `C--Code-app/${randomUUID()}.jsonl`, []);
  await truncate(oversized, 128_000_001);
  await assert.rejects(claudeTranscript(oversized, await claudeRevision(oversized)), /128 MB import limit/);
  if (process.platform !== 'win32') {
    const link = join(root, 'projects', 'C--Code-app', `${randomUUID()}.jsonl`);
    await symlink(file, link); await assert.rejects(claudeRevision(link), /regular file/);
  }
}));
