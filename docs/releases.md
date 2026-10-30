# Releases

Every push to `main` runs `.github/workflows/release.yml`:

1. Typecheck and test.
2. Select the next patch version (starting at `package.json`'s version).
3. Build macOS ARM64/Intel, Windows x64, and Linux x64/ARM64 in parallel.
4. Create `v<version>`, a GitHub release, native installers, npm tarballs, and SHA-256 checksums.
5. Publish all native packages, then `@arvindell/session-atlas`, to npm with **restricted** access.

The repository and its releases are private. npm packages live under `@arvindell`; installing them requires an authorized npm account. Publishing private packages requires npm Pro or a paid organization.

## Credentials

Set the repository secret `NPM_TOKEN` to an npm granular write token that can publish all six packages under `@arvindell`. For unattended publishing it needs npm's **bypass 2FA** permission. Rotate it before its expiry. The GitHub release uses the workflow's built-in `GITHUB_TOKEN`.

Build jobs do not receive the npm token. `publishConfig` and the publish command both require restricted access; the publisher verifies private visibility and rejects missing packages or mismatched commit/version metadata.

## Versions and retries

Release jobs are serialized. A new commit receives the next patch after the newest stable `v*` tag, or a higher version from `package.json`. The build stamps the same version into npm, Cargo, and Tauri without making a bot commit.

Rerunning a tagged commit reuses its version. Already-published packages are skipped only if they are private and identify that same commit. GitHub assets can be replaced on a rerun. Never force-move release tags; npm versions cannot be overwritten.

Use **Actions → Release → Run workflow** on `main` to retry manually. Pull requests run checks without publishing.

## Platforms

| Target | Installers | Build host |
| --- | --- | --- |
| macOS ARM64 / x64 | `.dmg` | macOS 14 / 15 Intel |
| Windows x64 | NSIS `.exe`, `.msi` | Windows Server 2022 |
| Linux x64 | `.deb`, `.rpm`, `.AppImage` | Ubuntu 22.04 |
| Linux ARM64 | `.deb`, `.rpm`, `.AppImage` | Ubuntu 24.04 ARM |

macOS signing/notarization and Windows signing are not configured yet. Linux compatibility follows the build host's glibc and WebKit requirements.
