# Releases

Every push to `main` runs `.github/workflows/release.yml`:

1. Typecheck and test.
2. Select the next patch version (starting at `package.json`'s version).
3. Build macOS ARM64/Intel, Windows x64, and Linux x64/ARM64 in parallel.
4. Validate every signed updater format, then create `v<version>`, a GitHub release, native installers, `latest.json`, demo video, npm tarballs, and SHA-256 checksums.
5. Publish all native packages, then `sessiongraph`, to npm with **public** access.

The repository and GitHub releases are public. The unscoped `sessiongraph` launcher and `sessiongraph-app-*` platform packages use npm Trusted Publishing from GitHub Actions. Native releases remain available independently of npm setup.

## Credentials

### npm Trusted Publishing

The npm job uses GitHub OIDC (`id-token: write`) and npm 12.2.1. It does not use `NPM_TOKEN` or `NODE_AUTH_TOKEN`. The GitHub release uses the workflow's built-in `GITHUB_TOKEN`.

For each of these six npm packages, open **Settings → Trusted Publisher → GitHub Actions**:

- `sessiongraph`
- `sessiongraph-app-darwin-arm64`
- `sessiongraph-app-darwin-x64`
- `sessiongraph-app-linux-arm64`
- `sessiongraph-app-linux-x64`
- `sessiongraph-app-win32-x64`

Use **Organization or user:** `arvindell`; **Repository:** `sessiongraph`; **Workflow filename:** `release.yml`; leave **Environment name** blank. Enable direct **npm publish** access (stage-only permission is insufficient for this workflow). Complete the first trusted publish within npm's two-day setup window.

The packages must exist before their trusted publisher can be configured. For the initial publication, sign in interactively with `npm login` and publish the verified release tarballs from a terminal; satisfy npm's interactive 2FA prompts. From the repository root:

```sh
npm login
tag=$(gh release view --repo arvindell/sessiongraph --json tagName --jq .tagName)
commit=$(gh api "repos/arvindell/sessiongraph/git/ref/tags/$tag" --jq .object.sha)
mkdir -p "tmp/npm-$tag"
gh release download "$tag" --repo arvindell/sessiongraph --pattern '*.tgz' --pattern SHA256SUMS --dir "tmp/npm-$tag"
(cd "tmp/npm-$tag" && awk '/\.tgz$/ { print }' SHA256SUMS | shasum -a 256 -c -) &&
RELEASE_VERSION="${tag#v}" GITHUB_SHA="$commit" node scripts/publish-release.mjs "tmp/npm-$tag"
```

After configuring all six trusted publishers, run the Release workflow on `main`. Once an OIDC publish succeeds, revoke the old npm CI token and remove the unused GitHub `NPM_TOKEN` secret. See [npm's Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers).

`publishConfig` and the publish command both require public access. The publisher verifies visibility with unauthenticated registry reads and rejects missing packages or mismatched commit/version metadata; it does not need token-only `npm access` commands.

### Desktop signing

Set `TAURI_SIGNING_PRIVATE_KEY` to the Tauri updater private key matching the public key in `src-tauri/tauri.conf.json`. The current key has an empty password. Keep a private backup outside the repository; replacing the key without a migration prevents existing apps from updating. Only the native build and artifact-signing steps receive it.

`tauri.release.conf.json` enables updater archives. `collect-release.mjs` signs macOS app archives, Windows installers, and Linux AppImage/DEB/RPM with the exact release version. `updater-manifest.mjs` rejects incomplete or stale signatures and maps both architecture and installed package format. URLs in the manifest are pinned to the release tag; installer filenames stay stable for README `/latest/download/` links. Runtime verification is enforced by the official Tauri updater with `requireSignedVersion`.

## Versions and retries

Release jobs are serialized. A new commit receives the next patch after the newest stable `v*` tag, or a higher version from `package.json`. The build stamps the same version into npm, Cargo, and Tauri without making a bot commit.

Rerunning a tagged commit reuses its version. Already-published packages are skipped only if they are public and identify that same commit. GitHub assets can be replaced on a rerun. Never force-move release tags; npm versions cannot be overwritten.

Use **Actions → Release → Run workflow** on `main` to retry manually. Pull requests run checks without publishing.

## Platforms

| Target | Installers | Build host |
| --- | --- | --- |
| macOS ARM64 / x64 | `.dmg` | macOS 15 ARM / Intel |
| Windows x64 | NSIS `.exe`, `.msi` | Windows Server 2022 |
| Linux x64 | `.deb`, `.rpm`, `.AppImage` | Ubuntu 22.04 |
| Linux ARM64 | `.deb`, `.rpm`, `.AppImage` | Ubuntu 24.04 ARM |

macOS bundles are ad-hoc signed, including the bundled runtime; Developer ID signing/notarization and Windows signing are not configured yet. Linux compatibility follows the build host's glibc and WebKit requirements.
