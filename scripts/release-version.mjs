import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const validVersion = (value) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
export function chooseVersion(base, tags, currentTags) {
  if (!validVersion(base)) throw new Error('The base release version must be stable semver.');
  const versions = (values) => values.filter((v) => v.startsWith('v') && validVersion(v.slice(1))).map((v) => v.slice(1)).sort(compare);
  const existing = versions(currentTags).at(-1);
  if (existing) return existing;
  const latest = versions(tags).at(-1);
  if (!latest || compare(base, latest) > 0) return base;
  const [major, minor, patch] = latest.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim().split('\n');
  const base = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const version = chooseVersion(base, git('tag', '--list', 'v*'), git('tag', '--points-at', 'HEAD'));
  console.log(`version=${version}\ntag=v${version}`);
}
