import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { databasePath } from '../server/config';
import { SessionAtlasStore } from '../server/store';
import { blankSession } from '../server/adapters/common';

test('renamed app reopens existing libraries on every platform and respects explicit data directories', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-atlas-config-'));
  try {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const base = platform === 'darwin' ? join(home, 'Library', 'Application Support') : platform === 'linux' ? join(home, '.local', 'share') : home;
      const current = join(base, platform === 'linux' ? 'session-atlas' : 'Session Atlas', 'session-atlas.sqlite');
      const legacy = join(base, platform === 'linux' ? 'atlas' : 'Atlas', 'atlas.sqlite');
      assert.equal(databasePath({}, platform, home), current);
      let store = new SessionAtlasStore(legacy);
      const candidate = { session: blankSession('test', platform), revision: 'saved', locator: {} };
      store.upsert(candidate); store.replace(candidate, [], false); store.setting('selected', ['test']); store.close();
      assert.equal(databasePath({}, platform, home), legacy);
      store = new SessionAtlasStore(databasePath({}, platform, home));
      assert.equal(store.getSession(candidate.session.id)?.revision, 'saved');
      assert.deepEqual(store.selected(), ['test']); store.close();
      store = new SessionAtlasStore(current); store.close();
      assert.equal(databasePath({}, platform, home), current);
    }
    const override = join(home, 'override');
    assert.equal(databasePath({ SESSION_ATLAS_DATA_DIR: override, ATLAS_DATA_DIR: home }, 'linux', home), join(override, 'session-atlas.sqlite'));
    const legacyOverride = join(override, 'atlas.sqlite');
    const store = new SessionAtlasStore(legacyOverride); store.close();
    assert.equal(databasePath({ SESSION_ATLAS_DATA_DIR: override }, 'linux', home), legacyOverride);
    assert.equal(databasePath({ ATLAS_DATA_DIR: override }, 'linux', home), legacyOverride);
  } finally { await rm(home, { recursive: true, force: true }); }
});
