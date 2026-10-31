# Releases

Every push to `main` runs `.github/workflows/release.yml`:

1. Typecheck and test.
2. Select the next patch version (starting at `package.json`'s version).
3. Build macOS ARM64/Intel, Windows x64, and Linux x64/ARM64 in parallel.
4. Validate every signed updater format, then create `v<version>`, a GitHub release, native installers, `latest.json`, demo video, npm tarballs, and SHA-256 checksums.
5. Publish all native packages, then `sessiongraph`, to npm with **public** access.

The repository and GitHub releases are public. The unscoped `sessiongraph` launcher and `sessiongraph-app-*` platform packages are configured for public npm publication. Initial publication is currently blocked by the token's missing bypass-2FA permission; native releases remain available independently.

## Credentials

Set the repository secret `NPM_TOKEN` to an npm granular write token that can create/publish `sessiongraph` and all five `sessiongraph-app-*` packages. For unattended publishing it needs npm's **bypass 2FA** permission. Rotate it before its expiry. The GitHub release uses the workflow's built-in `GITHUB_TOKEN`.

Build jobs do not receive the npm token. `publishConfig` and the publish command both require public access; the publisher verifies public visibility and rejects missing packages or mismatched commit/version metadata.

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
