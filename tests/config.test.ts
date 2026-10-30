import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { databasePath, serviceFile } from '../server/config';
import { SessionGraphStore } from '../server/store';
import { blankSession } from '../server/adapters/common';

test('renamed app reopens existing libraries on every platform and respects explicit data directories', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessiongraph-config-'));
  try {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const base = platform === 'darwin' ? join(home, 'Library', 'Application Support') : platform === 'linux' ? join(home, '.local', 'share') : home;
      const current = join(base, platform === 'linux' ? 'sessiongraph' : 'SessionGraph', 'sessiongraph.sqlite');
      const previous = join(base, platform === 'linux' ? 'session-atlas' : 'Session Atlas', 'session-atlas.sqlite');
      const original = join(base, platform === 'linux' ? 'atlas' : 'Atlas', 'atlas.sqlite');
      assert.equal(databasePath({}, platform, home), current);
      for (const legacy of [original, previous]) {
        const writer = new SessionGraphStore(legacy);
        const candidate = { session: blankSession('test', platform), revision: legacy, locator: {} };
        writer.upsert(candidate); writer.replace(candidate, [], false); writer.setting('selected', ['test']);
        try {
          assert.equal(databasePath({}, platform, home), legacy);
          const reader = new SessionGraphStore(databasePath({}, platform, home));
          try {
            assert.equal(reader.getSession(candidate.session.id)?.revision, legacy);
            assert.deepEqual(reader.selected(), ['test']);
          } finally { reader.close(); }
        } finally { writer.close(); }
      }
      const store = new SessionGraphStore(current); store.close();
      assert.equal(databasePath({}, platform, home), current);
    }
    const override = join(home, 'override');
    assert.equal(databasePath({ SESSIONGRAPH_DATA_DIR: override, SESSION_ATLAS_DATA_DIR: home, ATLAS_DATA_DIR: home }, 'linux', home), join(override, 'sessiongraph.sqlite'));
    for (const file of ['atlas.sqlite', 'session-atlas.sqlite', 'sessiongraph.sqlite']) {
      const path = join(override, file), store = new SessionGraphStore(path); store.close();
      for (const key of ['SESSIONGRAPH_DATA_DIR', 'SESSION_ATLAS_DATA_DIR', 'ATLAS_DATA_DIR']) {
        assert.equal(databasePath({ [key]: override }, 'linux', home), path);
      }
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('service registration accepts old environment names and prefers SessionGraph overrides', () => {
  assert.equal(serviceFile({ ATLAS_SERVICE_FILE: 'original' }), 'original');
  assert.equal(serviceFile({ ATLAS_SERVICE_FILE: 'original', SESSION_ATLAS_SERVICE_FILE: 'previous' }), 'previous');
  assert.equal(serviceFile({ ATLAS_SERVICE_FILE: 'original', SESSION_ATLAS_SERVICE_FILE: 'previous', SESSIONGRAPH_SERVICE_FILE: 'current' }), 'current');
});
