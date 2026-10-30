import test from 'node:test';
import assert from 'node:assert/strict';
import { contentVersion, validRecord, type CachedContent } from '../src/search/persistence';
import { SessionSearchIndex } from '../src/search/engine';
import { blankSession } from '../server/adapters/common';

const session = blankSession('test', 'a');
const record = (extra: Partial<CachedContent> = {}): CachedContent => ({ id: session.id, version: contentVersion(session), fragments: [{ kind: 'You', text: 'nebula passage', time: 1 }], characters: 14, pages: 1, partial: true, complete: false, capped: false, cursor: '60', ...extra });
test('saved SQLite search documents restore searchable text and preserve partial progress', () => {
  const saved = record(); assert.equal(validRecord(saved, session), true);
  const index = new SessionSearchIndex(); index.setData([session], []); index.addContent(saved.id, saved.fragments);
  assert.equal(index.search('nebula in:messages source:test').hits[0].id, session.id);
  assert.equal(saved.cursor, '60'); assert.equal(saved.partial, true);
  assert.equal(validRecord(record({ fragments: [], characters: 0, partial: false, complete: true, cursor: undefined }), session), true);
});
test('changed revisions, invalid coverage and oversized records cannot restore into the index', () => {
  assert.equal(validRecord(record(), { ...session, revision: 'new' }), false);
  assert.equal(validRecord(record({ characters: 48_001 }), session), false);
  assert.equal(validRecord(record({ cursor: 'bad cursor' }), session), false);
  assert.equal(validRecord(record({ complete: true }), session), false);
  assert.equal(validRecord(record({ characters: 1 }), session), false);
  assert.equal(validRecord(record(), undefined), false);
});
