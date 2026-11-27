import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeGraph } from '@sessiongraph/core/layout';
import { normalizePreferences } from '@sessiongraph/core/preferences';
import { blankSession } from '../server/adapters/common';
import { annotateGitCheckouts } from '../server/git-checkouts';
import { shareGraph } from '../src/share-graph';

test('repository grouping combines checkouts; worktree grouping combines subdirectories only', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'sessiongraph-grouping-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const main = join(root, 'main'), feature = join(root, 'feature'), other = join(root, 'clone');
  await mkdir(main);
  await mkdir(other);
  git(main, 'init', '-q');
  git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Initial', '--allow-empty');
  git(main, 'worktree', 'add', '-q', '--detach', feature);
  const src = join(main, 'src');
  await mkdir(src);
  git(other, 'init', '-q');
  const unresolved = join(root, 'missing');
  const input = [src, main, feature, other, unresolved].map((directory, i) => ({ ...blankSession('codex', String(i), directory), created: 1000 + i }));
  input[2].forkID = input[0].id;
  const local = await annotateGitCheckouts(input.slice(0, 3));
  assert.equal(local[0].checkout?.repository, local[2].checkout?.repository);
  assert.notEqual(local[0].checkout?.worktree, local[2].checkout?.worktree);
  // Use fresh paths for the remote lookup so no cached local identity is reused.
  const remoteDir = join(feature, 'tests');
  await mkdir(remoteDir);
  git(main, 'remote', 'add', 'origin', 'git@github.com:Org/Example.git');
  git(other, 'remote', 'add', 'origin', 'https://github.com/org/example');
  const remote = await annotateGitCheckouts([{ ...input[2], directory: remoteDir }, input[3], input[4]]);
  assert.equal(remote[0].checkout?.repository, remote[1].checkout?.repository);
  assert.equal(remote[0].checkout?.repositoryLabel, 'example');
  assert.equal(remote[2].checkout, undefined);
  const sessions = [...local, remote[2]];
  const repos = makeGraph(sessions, [], undefined, 'repository');
  const trees = makeGraph(sessions, [], undefined, 'worktree');
  assert.deepEqual(repos.lanes.map(l => l.nodes.length), [3, 1]);
  assert.deepEqual(trees.lanes.map(l => l.nodes.length), [2, 1, 1]);
  assert.deepEqual(trees.edges, repos.edges);
  assert.deepEqual(trees.nodes.map(n => n.position[0]).sort(), repos.nodes.map(n => n.position[0]).sort());
  assert.ok(shareGraph(trees).lanes.every(lane => /^Project /.test(lane.label)));
  assert.equal(normalizePreferences({ grouping: 'worktree' }).grouping, 'worktree');
  assert.equal(normalizePreferences(undefined).grouping, 'worktree');
  assert.equal(normalizePreferences({ grouping: 'directory' }).grouping, 'worktree');
  assert.equal(normalizePreferences({ grouping: 'repository' }).grouping, 'repository');
});

test('both Git clustering modes fall back to the full directory before the unknown lane', () => {
  const sessions = ['/one/app', '/one/app/', '/two/app', '', ''].map((directory, i) => blankSession('codex', String(i), directory));
  for (const [mode, unknownLabel] of [['worktree', 'Unknown worktree'], ['repository', 'Unknown repository']] as const) {
    const { lanes } = makeGraph(sessions, [], undefined, mode);
    assert.equal(lanes.length, 3);
    assert.deepEqual(lanes.find(lane => lane.label === unknownLabel)?.nodes.map(node => node.session.id), [sessions[3].id, sessions[4].id]);
    const folders = lanes.filter(lane => lane.kind === 'directory' && lane.label === 'app');
    assert.deepEqual(folders.map(lane => lane.nodes.map(node => node.session.id)), [[sessions[0].id, sessions[1].id], [sessions[2].id]]);
  }
});
