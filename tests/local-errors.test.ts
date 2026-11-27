import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runCli } from '../server/cli';
import { storageFailure } from '../server/local-errors';
import { sessionGraphMiddleware } from '../server/middleware';
import { requestLocal } from '../src/local-api';

test('startup and CLI report a newer library version without migrating it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessiongraph-version-')), file = join(dir, 'sessiongraph.sqlite');
  const previous = process.env.SESSIONGRAPH_DATA_DIR;
  process.env.SESSIONGRAPH_DATA_DIR = dir;
  const server = createServer((req, res) => { void sessionGraphMiddleware(req, res, () => res.end()); });
  try {
    const fixture = new DatabaseSync(file);
    fixture.exec('PRAGMA user_version=99; CREATE TABLE saved(value); INSERT INTO saved VALUES (42);');
    fixture.close();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessiongraph`;
    const failure = { code: 'LIBRARY_VERSION', message: 'This library requires a newer version of SessionGraph.' };
    await assert.rejects(requestLocal(url, 'Could not load the library.'), { status: 409, ...failure });
    let output = '';
    assert.equal(await runCli(['sessions', '--data-dir', dir, '--json'], { stdout: text => { output += text; } }), 1);
    assert.deepEqual(JSON.parse(output).error, failure);
    const saved = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(saved.prepare('PRAGMA user_version').get()?.user_version, 99);
      assert.equal(saved.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
      assert.equal(saved.prepare('SELECT value FROM saved').get()?.value, 42);
    } finally { saved.close(); }
    await writeFile(file, 'not a database');
    await assert.rejects(requestLocal(url, 'Could not load the library.'), { status: 500, code: 'LIBRARY_CORRUPT', message: 'The library file is damaged or invalid.' });
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    if (previous === undefined) delete process.env.SESSIONGRAPH_DATA_DIR; else process.env.SESSIONGRAPH_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('storage errors use SQLite result codes and concise messages', () => {
  for (const [errcode, code] of [[261, 'LIBRARY_BUSY'], [262, 'LIBRARY_BUSY'], [1544, 'LIBRARY_PERMISSIONS'], [11, 'LIBRARY_CORRUPT'], [13, 'DISK_FULL'], [14, 'LIBRARY_OPEN_FAILED'], [266, 'LIBRARY_IO']] as const) {
    const result = storageFailure(Object.assign(new Error('private path and technical details'), { code: 'ERR_SQLITE_ERROR', errcode }));
    assert.equal(result?.code, code);
    assert.doesNotMatch(result!.message, /private path/);
  }
  assert.equal(storageFailure(Object.assign(new Error('private path'), { code: 'EACCES' }), true)?.code, 'LIBRARY_PERMISSIONS');
  assert.equal(storageFailure(Object.assign(new Error('private path'), { code: 'ERR_SQLITE_ERROR', errcode: 1 })), undefined);
});

test('local requests keep clear API errors and use a short fallback for transport failures', async () => {
  const read = (fetcher: typeof fetch, signal?: AbortSignal) => requestLocal('/api/sessiongraph', 'Could not load the library.', { signal }, fetcher);
  await assert.rejects(read(async () => Response.json({ code: 'IMPORT_BUSY', error: 'Another import is running.' }, { status: 409 })),
    { code: 'IMPORT_BUSY', status: 409, message: 'Another import is running.' });
  await assert.rejects(read(async () => new Response('bad JSON', { status: 502 })), { status: 502, message: 'Could not load the library.' });
  await assert.rejects(read(async () => Response.json({ code: 'OPERATION_FAILED', error: 'Local operation failed.' }, { status: 500 })),
    { status: 500, message: 'Could not load the library.' });
  await assert.rejects(read(async () => { throw new TypeError('internal network details'); }), { message: 'Could not load the library.' });
  const timeout = AbortSignal.abort(new DOMException('internal timeout', 'TimeoutError'));
  await assert.rejects(read(async () => { throw timeout.reason; }, timeout), { message: 'The request timed out.' });
  const abort = AbortSignal.abort();
  await assert.rejects(read(async () => { throw abort.reason; }, abort), error => error === abort.reason);
});
