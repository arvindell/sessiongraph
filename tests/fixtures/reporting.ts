import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { blankMessage, blankSession, project } from '../../server/adapters/common';
import { SessionGraphStore } from '../../server/store';
import type { Session } from '@sessiongraph/core/types';

/** Isolated saved library for query tests and blind OpenCode evaluations. */
export function reportingFixture(root: string) {
  const main = join(root, 'team-a', 'lantern'), other = join(root, 'team-b', 'lantern'), branch = join(root, 'feature');
  for (const path of [main, other]) {
    mkdirSync(path, { recursive: true });
    execFileSync('git', ['init', '-q', path]);
  }
  execFileSync('git', ['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture']);
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '--detach', branch]);
  const store = new SessionGraphStore(join(root, 'library', 'sessiongraph.sqlite'));
  const time = (day: number) => Date.UTC(2026, 4, day, 12);
  function add(source: string, name: string, path: string, day: number, messages: number[], extra: Partial<Session> = {}) {
    const session = { ...blankSession(source, name, path), title: name, created: time(day), updated: time(31), ...extra };
    const p = project(source, path);
    store.db.prepare('INSERT OR IGNORE INTO projects VALUES (?,?,?)').run(p.id, source, JSON.stringify(p));
    const c = { session, revision: '1', locator: {} };
    store.upsert(c);
    store.replace(c, messages.map((d, i) => ({ ...blankMessage(String(i), time(d), 'user'), fragments: [{ kind: 'You' as const, time: time(d), text: 'Review the draft.' }] })), false);
  }
  try {
    add('codex', 'Design review', main, 10, [10, 16]);
    add('opencode', 'Cache review', branch, 11, [11, 13, 16]);
    add('codex', 'Retry pipeline', main, 12, [12, 13]);
    add('codex', 'Nightly bot roadmap', main, 13, [13]);
    add('hermes', 'Morning checks', other, 13, [13], { origin: 'automated' });
    add('codex', 'Worker notes', branch, 13, [13], { origin: 'automated', parentID: 'codex:Retry pipeline' });
    add('opencode', 'Alternative design', branch, 13, [14], { forkID: 'opencode:Cache review' });
    add('claude-code', 'Release notes', other, 14, [14]);
  } finally { store.close(); }
}
