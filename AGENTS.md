# Session Atlas

Search & visualize all your LLM sessions. Local-first desktop and browser explorer for multiple harnesses.

- Use pnpm. `pnpm typecheck` verifies the TypeScript frontend and backend.
- Prefer `portless session-atlas pnpm dev` for local development. Rust is pinned by `rust-toolchain.toml`.
- OpenCode access is read-only through its authenticated API, using the official client's service discovery. Never mutate or directly open the user's session database.
- Imported sessions and search checkpoints belong in Session Atlas's own local SQLite database, outside the repository. Never put session data in Git, application bundles, or npm artifacts. Put temporary diagnostics in `tmp/`.
- Add sources through `server/adapters/types.ts` and the adapter registry. Discovery and history reads must be local and read-only; never run inference, resume a session, or upload data during import.
- Deduplicate by source/native session identity and native message IDs. Replace changed session snapshots atomically; preserve forks and unavailable saved history. Unknown metadata is not zero.
- Preserve the distinction between a fork, a child/subagent session, chronological proximity, and a directory/worktree association. Do not infer causal edges from timestamps alone.
- File details are lazy-loaded, bounded, and must disclose partial history or absent snapshot coverage.
