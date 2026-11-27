import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SessionGraphStore } from '../server/store';
import { preparePublicGraph } from '../server/publishing';
import { blankSession } from '../server/adapters/common';
import { DEFAULT_PUBLISHING } from '@sessiongraph/core/public-graph';
import { build } from 'esbuild';

// Invented metadata and payloads only; never reads a real session library.
const store = new SessionGraphStore(':memory:');
let prepare = preparePublicGraph;
if (process.env.PERF_BASELINE) {
  const source = execFileSync('git', ['show', `${process.env.PERF_BASELINE}:server/publishing.ts`], { encoding: 'utf8' });
  const bundle = await build({ stdin: { contents: source, resolveDir: resolve('server'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
  prepare = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)).preparePublicGraph;
  // The measured baseline predates this additive index. No saved library is used.
  store.db.exec('DROP INDEX IF EXISTS timeline_messages_time');
}
const count = Number(process.env.PERF_SESSIONS || 1200), events = Number(process.env.PERF_EVENTS || 250);
const ids: string[] = [], created = Date.UTC(2026, 10, 1);
const payload = JSON.stringify({ text: 'Synthetic benchmark content. '.repeat(75) });
try {
  store.db.exec('BEGIN');
  const sessionInsert = store.db.prepare('INSERT INTO sessions(id,source,native_id,metadata,locator) VALUES (?,?,?,?,?)');
  const coverage = store.db.prepare('INSERT INTO timeline_coverage VALUES (?,0,NULL,?)');
  const item = store.db.prepare('INSERT INTO timeline_items VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < count; i++) {
    const session = { ...blankSession('opencode', `benchmark-${i}`), created: created + i * 1000, model: 'gpt-6-astra', directory: `/synthetic/project-${i % 6}`, coverage: { history: 'complete' }, activity: { firstMessageAt: created, lastMessageAt: created + events * 1000 + i * 1000, userMessages: 20, untimedUserMessages: 0 } };
    ids.push(session.id);
    sessionInsert.run(session.id, 'opencode', `benchmark-${i}`, JSON.stringify(session), '{}');
    coverage.run(session.id, 'benchmark');
    for (let j = 0; j < events; j++) item.run(session.id, String(j), String(j), j, j % 4 < 2 ? 'message' : 'tool_call', j % 2 ? 'assistant' : 'user', j % 17 ? session.created + j * 1000 : null, null, 'Synthetic', 'Synthetic preview', payload);
  }
  store.db.exec('COMMIT');
  const samples: number[] = [];
  for (let i = 0; i < 8; i++) {
    const start = performance.now();
    const graph = prepare(store, ids, DEFAULT_PUBLISHING);
    const elapsed = performance.now() - start;
    if (i) samples.push(elapsed);
    console.log(`Preview ${i ? i : 'warmup'}: ${elapsed.toFixed(1)} ms; ${graph.sessions.length} sessions`);
  }
  const sorted = samples.toSorted((a, b) => a - b);
  const plans = [
    "SELECT count(*) AS count, count(*) FILTER (WHERE time IS NULL) AS untimed FROM timeline_items WHERE session_id=? AND kind='message' AND role IN ('user','assistant')",
    "SELECT time FROM timeline_items WHERE session_id=? AND kind='message' AND role IN ('user','assistant') AND time IS NOT NULL ORDER BY time,ordinal LIMIT 2000",
  ].map(sql => store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(ids[0]));
  const result = { source: process.env.PERF_BASELINE ? 'git' : 'working-tree', revision: execFileSync('git', ['rev-parse', process.env.PERF_BASELINE || 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, sessions: count, events: count * events, payloadBytes: Buffer.byteLength(payload), medianMs: sorted[3], p95Ms: sorted[6], samples, plans };
  const output = resolve(process.argv[2] || 'tmp/performance/publishing.json');
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { store.close(); }
