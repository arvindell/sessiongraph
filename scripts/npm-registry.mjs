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
