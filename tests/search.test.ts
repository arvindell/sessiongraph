import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionSearchIndex, parseQuery } from '../src/search/engine';
import { extractContent } from '../server/search';
import type { Session } from '../src/types';

const session = (id: string, title: string, extra: Partial<Session> = {}): Session => ({ id, title, projectID: 'p', directory: '/work/app', model: 'claude', provider: 'test', agent: 'build', tokens: 0, cost: 0, archived: false, created: Date.parse('2026-09-15'), updated: Date.parse('2026-09-15'), ...extra });
const projects = [{ id: 'p', name: 'Payments', directory: '/work/app', worktrees: [] }];

test('search ranks exact titles above transcript hits, handles typos, accents, and conjunctive terms', () => {
  const index = new SessionSearchIndex();
  index.setData([session('title', 'GitLab pipeline optimization'), session('body', 'Investigating deployment'), session('accent', 'Corregir depósito duplicado'), session('unrelated', 'GitLab settings')], projects);
  index.addContent('body', [{ kind: 'You', time: 1, text: 'GitLab pipeline optimization failed during deployment.' }]);
  assert.equal(index.search('gitlab pipeline').hits[0].id, 'title');
  assert.equal(index.search('gitlab pipelne').hits[0].id, 'title');
  assert.deepEqual(index.search('deposito duplicado').hits.map((h) => h.id), ['accent']);
  assert.equal(index.search('gitlab pipeline').hits.some((h) => h.id === 'unrelated'), false);
  assert.equal(index.search('deployment in:messages').hits[0].source, 'Message');
});

test('field filters, quotes, ancestry, dates and view scope do not leak other results', () => {
  const index = new SessionSearchIndex();
  index.setData([session('root', 'Payment webhook retry'), session('fork', 'Webhook payment retry', { forkID: 'root', parentID: 'root' }), session('child', 'Payment webhook audit', { parentID: 'root' })], projects);
  index.addContent('root', [{ kind: 'File', time: 1, text: 'src/billing/invoice-handler.ts' }]);
  assert.deepEqual(index.search('is:fork').hits.map((h) => h.id), ['fork']);
  assert.deepEqual(index.search('is:child').hits.map((h) => h.id), ['child']);
  assert.deepEqual(index.search('"payment webhook" in:title').hits.map((h) => h.id).sort(), ['child', 'root']);
  assert.deepEqual(index.search('in:files invoice-handler').hits.map((h) => h.id), ['root']);
  assert.equal(index.search('invoice in:title').total, 0);
  assert.equal(index.search('project:other').total, 0);
  assert.equal(index.search('after:2026-10-01').total, 0);
  index.setScope(['child']);
  assert.deepEqual(index.search('payment', true).hits.map((h) => h.id), ['child']);
  assert.ok(parseQuery('in:unknown').error);
  assert.ok(parseQuery('after:nope').error);
  assert.ok(parseQuery('after:2026-02-30').error);
  assert.equal(parseQuery('after:2024-02-29').error, undefined);
});

test('refresh invalidates changed/deleted transcript evidence while keeping unchanged entries', () => {
  const index = new SessionSearchIndex();
  const a = session('a', 'First'), b = session('b', 'Second');
  index.setData([a, b], projects);
  index.addContent('a', [{ kind: 'You', time: 1, text: 'orion unique passage' }]);
  index.addContent('b', [{ kind: 'You', time: 1, text: 'nebula retained passage' }]);
  index.setData([{ ...a, updated: a.updated + 1 }, b], projects);
  assert.equal(index.search('orion').total, 0);
  assert.equal(index.search('nebula').total, 1);
  index.setData([a], projects);
  assert.equal(index.search('nebula').total, 0);
});

test('unchanged search documents still refresh filter metadata and changed titles or project names', () => {
  const index = new SessionSearchIndex(), original = session('kept', 'Original title');
  index.setData([original], projects);
  index.addContent(original.id, [{ kind: 'You', time: 1, text: 'nebula retained passage' }]);
  assert.equal(index.search('is:archived').total, 0);
  index.setData([{ ...original, archived: true }], projects);
  assert.equal(index.search('is:archived nebula').total, 1);
  index.setData([{ ...original, title: 'Updated title' }], [{ ...projects[0], name: 'Accounting' }]);
  assert.equal(index.search('original in:title').total, 0);
  assert.equal(index.search('updated in:title').total, 1);
  assert.equal(index.search('project:accounting nebula').total, 1);
});

test('content extraction includes conversation, files and tools with bounded output', () => {
  const result = extractContent([
    { type: 'user', time: { created: 1 }, text: 'Investigate payments', files: [{ name: 'invoice.csv' }] },
    { type: 'assistant', time: { created: 2 }, snapshot: { files: ['src/invoice.ts'] }, content: [{ type: 'text', text: 'Found the retry issue' }, { type: 'tool', name: 'read', state: { input: { filePath: 'src/retry.ts', secret: 'do-not-index' }, content: [{ type: 'text', text: 'webhook handler' }] } }] },
    { type: 'shell', time: { created: 3 }, output: 'x'.repeat(100_000) },
  ]);
  assert.ok(result.fragments.some((f) => f.kind === 'You' && f.text.includes('payments')));
  assert.ok(result.fragments.some((f) => f.kind === 'File' && f.text === 'src/retry.ts'));
  assert.ok(result.fragments.some((f) => f.kind === 'Tool' && f.text === 'webhook handler'));
  assert.ok(!result.fragments.some((f) => f.text.includes('do-not-index')));
  assert.ok(result.fragments.reduce((n, f) => n + f.text.length, 0) <= 64_000);
  assert.equal(result.truncated, true);
});

test('content extraction discloses omitted nested and long-array tool data', () => {
  const tool = (input: unknown) => [{ type: 'assistant', content: [{ type: 'tool', name: 'inspect', state: { input } }] }];
  const deep = extractContent(tool({ a: { b: { c: { d: { e: { f: 'omitted' } } } } } }));
  assert.equal(deep.truncated, true);
  const array = extractContent(tool(Array.from({ length: 101 }, (_, i) => `entry ${i}`)));
  assert.equal(array.truncated, true);
  assert.ok(!array.fragments.some((f) => f.text === 'entry 100'));
  assert.equal(extractContent(tool({ path: 'src/app.ts', query: 'hello' })).truncated, false);
});
