# SessionGraph

## Commands and runtime

- Use Node.js 24+ (the backend uses `node:sqlite`) and pnpm pinned by `package.json`. `pnpm-workspace.yaml` intentionally skips `sessiongraph-app-*` optional dependencies: these are release outputs, not source packages.
- Prefer `portless sessiongraph pnpm dev`; `pnpm dev` also works. Vite serves the local API in the same process; no separate backend command is needed.
- CI runs `pnpm typecheck && pnpm test && pnpm build`. Typecheck covers `src/`, `server/`, `tests/`, and `vite.config.ts`.
- Tests use `node:test` via tsx. One file: `pnpm exec tsx --test tests/import.test.ts`. One case: insert `--test-name-pattern='SQLite imports'` before the filename. Fixtures use temporary or in-memory stores; live harnesses are not required.
- `pnpm build && pnpm start` runs the built browser app with its local backend. Serving `dist/` statically cannot access session history.
- Both `pnpm desktop:dev` and `pnpm desktop:build` first build and run `scripts/prepare-desktop.mjs`, which copies web assets, backend, and the current Node executable into generated `src-tauri/resources/`. Desktop dev uses bundled assets, not Vite HMR. Rust is pinned in `rust-toolchain.toml`.

## Wiring

- Browser and desktop share the vanilla TypeScript/Three.js frontend in `src/main.ts` and API in `server/middleware.ts`. Tauri starts `server/standalone.ts` as a bundled Node child and opens its authenticated loopback URL; preserve backend lifecycle ownership and origin checks.
- Add sources via `server/adapters/types.ts` and `server/adapters/index.ts`. `server/importer.ts` coordinates reads; `server/store.ts` owns SQLite migrations and snapshot replacement. Shared models live in `src/types.ts` and `src/timeline.ts`.
- Search runs in `src/search/worker.ts`; persisted checkpoints use SQLite through `src/search/sqlite-cache.ts`, not IndexedDB. Clearing the search index must preserve imported history.
- Storage resolution in `server/config.ts` honors `SESSIONGRAPH_DATA_DIR` and reuses legacy Session Atlas/Atlas libraries in place. Preserve legacy environment aliases and database precedence. See `docs/guide.md` for source-specific coverage and storage details.

## History invariants

- Discovery and import must stay local and read-only: never run inference, resume sessions, or upload data. Launching a destination harness is a separate explicit user action.
- OpenCode reads use the official client's authenticated service discovery and loopback GET API (`server/opencode.ts`). Never directly open or mutate OpenCode's database; keep source credentials in the backend.
- Imported history and search checkpoints belong in SessionGraph's own SQLite database outside the repository. Never put session data in Git, bundles, or npm artifacts. Keep temporary diagnostics and screenshots in ignored `tmp/`.
- Deduplicate by source/native session identity and native message IDs. Replace messages, events, coverage, and search invalidation atomically; retain saved history when sources disappear, are deselected, or fail to import.
- Forks, child/subagent links, directory/worktree associations, and chronological proximity are distinct. Never infer ancestry from timestamps or merge sessions by similar text. Unknown metadata is not zero.
- Graph endpoints use the latest saved message time, falling back to session creation, not metadata `updated`. Preserve untimed events without inventing marker positions. `ImportedMessage.events: undefined` means legacy flattened history; `[]` means explicitly no source events.
- File details are lazy-loaded and bounded. Prefer authoritative snapshots; fallback edit evidence requires successful tool results, not requests or reads. Disclose partial history and absent snapshot coverage.

## Commits and releases

- Use Conventional Commits, such as `feat(updater): add signed desktop updates`.
- Every push to `main` triggers native builds, a GitHub release, and npm publication. CI derives versions from stable tags and stamps npm/Cargo/Tauri versions during builds; routine changes do not need a manual version bump. See `docs/releases.md` and `.github/workflows/release.yml` before changing release behavior.
