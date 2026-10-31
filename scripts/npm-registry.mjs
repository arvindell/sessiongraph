/** An unauthenticated registry read verifies public access without an npm token. */
export async function getPublicVersion(name, version, request = fetch) {
  const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Public registry lookup failed for ${name}@${version}: HTTP ${response.status}.`);
  return response.json();
}

export function verifyPublicVersion(value, name, version, commit) {
  if (!value || value.name !== name || value.version !== version || value.sessionGraphCommit !== commit) {
    throw new Error(`Could not verify public release ${name}@${version} from commit ${commit}.`);
  }
}

/** npm can accept a publish before its public registry finishes processing it. */
export async function waitForPublicVersion(name, version, commit, { request = fetch, delay = pause, attempts = 61, interval = 10_000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await getPublicVersion(name, version, request);
    if (value !== undefined) {
      verifyPublicVersion(value, name, version, commit);
      return value;
    }
    if (attempt + 1 < attempts) await delay(interval);
  }
  throw new Error(`npm accepted ${name}@${version}, but it is not public yet. Publication verification timed out; check npm processing before retrying.`);
}
import { setTimeout as pause } from 'node:timers/promises';
