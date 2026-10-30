# Session Atlas guide

**Search & visualize all your LLM sessions**

A local-first galaxy of your LLM sessions. Import **OpenCode, Claude Code, and Codex**, explore relationships and changed files, search conversations, and fly through their timeline.

## Open Session Atlas

### Desktop

The Tauri 2 app uses the operating system's WebView and bundles its local Node runtime. Installed apps need neither Node nor a running development server.

Build on your machine (Node 24+, pnpm, Rust, and [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)):

```sh
pnpm install
pnpm desktop:build
```

Installers appear in `src-tauri/target/release/bundle/`. On macOS, open `macos/Session Atlas.app` or install using the DMG. `pnpm desktop:dev` builds and runs the native shell locally. The Rust toolchain is pinned in `rust-toolchain.toml`.

### npm launcher

The launcher and platform packages use the private `@arvindell` npm scope. Sign in with an account that has access:

```sh
npx @arvindell/session-atlas
# Or use your browser with a local backend:
npx @arvindell/session-atlas --browser
```

To test installation before publishing:

```sh
pnpm package:desktop
# macOS Apple Silicon example:
npx --package ./release/arvindell-session-atlas-0.1.0.tgz \
    --package ./release/arvindell-session-atlas-app-darwin-arm64-0.1.0.tgz session-atlas
```

The launcher requires Node 24+. Platform packages are optional dependencies selected by OS/architecture. The browser build is bundled into the launcher package. `scripts/package-desktop.mjs` builds both tarballs. Pushes to `main` build platform installers, create a version tag and GitHub release, and publish restricted npm packages. See [Releases](releases.md) for the workflow and credentials. macOS builds are currently unsigned/unnotarized.

### Browser development

```sh
pnpm install
portless session-atlas pnpm dev
# or: pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

`pnpm start` opens the built app with an authenticated, loopback-only server. A static `dist/` deployment alone cannot access local session history.

## Import and update

On first launch, choose the apps to import. Reopen **Manage sources** next to the source filter to change that selection. **Refresh sessions** imports updates from your selected sources.

- Source/native session IDs are the stable identity: importing the same session again updates its existing record. Duplicate source files and repeated message IDs do not create extra sessions/messages.
- Unchanged source revisions skip history reads. Changed sessions are reread and their normalized messages, file evidence, and index version are replaced in one SQLite transaction.
- Failed or interrupted updates retain the previous saved history. Re-import retries unfinished sessions. Import status reports counts, failures, and coverage limitations.
- Forks and children remain distinct even if their text overlaps. Different harnesses' sessions are not merged based on matching titles, timestamps, or similar text.
- Deselecting a source stops future imports; saved sessions remain browsable offline. Missing source files are not treated as a request to erase Session Atlas's local copy.
- Imported data contains normalized user/assistant text, supported tool text, and recorded file evidence. This is not a byte-for-byte backup of every source artifact; images, encrypted reasoning, unsupported event types, and truncated content are excluded.

### Source coverage

| Source | Read-only interface | Relationships and limitations |
| --- | --- | --- |
| OpenCode | Official authenticated local service discovery and V2 GET API | Explicit forks and child IDs; authoritative snapshot paths where available. OpenCode must be running for an import, but not to browse saved data. Remote endpoints are rejected. |
| Claude Code | SDK `listSessions`, `getSessionMessages`, `getSubagentMessages`; local transcript metadata | All local projects, worktrees, and subagent transcripts. SDK-visible conversation chain can omit pre-compaction text. No inferred fork ancestry. File evidence requires a successful matching edit-tool result. |
| Codex | Bounded streaming reads of active and archived local JSONL rollouts | Explicit recorded fork/parent fields; completed file-change events. Mirrored event text is not imported twice. Store-only/cloud-only history and ordinary ChatGPT desktop/web chats are not imported. No agent process is started. |

Source roots respect `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. `SESSION_ATLAS_SERVICE_FILE` selects a local OpenCode service registration. Adapters never read authentication files or execute source configuration, hooks, or agents. Source formats can evolve: unsupported history is disclosed rather than fabricated.

## Local storage and privacy

Session Atlas's own SQLite database stores source preferences, session metadata, normalized messages, file evidence, import revisions, and bounded search checkpoints:

- macOS: `~/Library/Application Support/Session Atlas/session-atlas.sqlite`
- Linux: `$XDG_DATA_HOME/session-atlas/session-atlas.sqlite` (default `~/.local/share/session-atlas/session-atlas.sqlite`)
- Windows: `%LOCALAPPDATA%/Session Atlas/session-atlas.sqlite`
- Override with `SESSION_ATLAS_DATA_DIR`.

Existing installations automatically reuse their previous `Atlas/atlas.sqlite` library (or `atlas/atlas.sqlite` on Linux), including imported sessions and search checkpoints. The old `ATLAS_DATA_DIR` and `ATLAS_SERVICE_FILE` environment variables remain supported as aliases.

All parsing, deduplication, indexing, and visualization run on this computer. No telemetry, embeddings service, model inference, uploads, or remote fonts are used. Source histories are read-only; Session Atlas never opens or modifies another app's database. The native app binds its backend to `127.0.0.1` on a random port with an ephemeral authentication cookie; imports from other origins are rejected. Source credentials stay in the backend.

The database is a local plaintext copy of imported conversation text, protected by filesystem permissions. It uses WAL journaling, versioned migrations, atomic session replacement, and a cross-process import lock. App bundles and npm tarballs contain only application assets, never your database. Opening a session in its original app is a separate, explicit action; that app controls its own network behavior.

## Explore

- Full-viewport, antialiased Three.js map with floating, draggable, dismissible cards. **H** hides/restores cards; **F** fits the view.
- Source badges distinguish harnesses in the list, inspector, tooltips, and search. Filter by source, project, directory/worktree, date, archived status, or children. The default window is 90 days.
- Creation time runs left to right. Directory streams express chronology, not ancestry. Forks and child sessions use distinct explicit edges. Unavailable ancestors are not invented.
- Click a session for changed-file satellites and source evidence. File details load in 120-message batches; the map displays at most 80 files. Evidence describes historical edits, not today's Git diff.
- **Play** follows newly appearing clusters with a gentle 30-second orbital pass and a closing pullback. Dragging, zooming, scrubbing, or fitting the view pauses playback. 2D pans without orbiting; reduced motion keeps the camera still.
- **Open session** offers source-specific CLI commands (`opencode --session`, `codex resume`, `claude --resume`) and OpenCode's local web route where available. macOS can open Terminal; other platforms can copy the command. Subagents without independent launch support direct you to their parent.
- Unknown model/cost/token fields stay unknown. Session selection is encoded in a local permalink.

## Search

Press **/** or **⌘/Ctrl+K**. MiniSearch runs in a worker with fuzzy, accent-insensitive, prefix matching and title-first ranking. Results are virtualized; search pauses map rendering and playback.

- **↑/↓**, **Page Up/Down**, **Enter**, **Esc** navigate, explore, and close.
- **All history / Current view** changes scope (**Alt+S**).
- Filters: `source:codex`, `source:claude-code`, `project:app`, `dir:worktree`, `model:claude`, `is:fork|child|root|archived`, `after:2026-09-01`, `before:2026-10-31`.
- Fields: `in:title`, `in:files`, `in:messages`, `in:tools`; quoted phrases require adjacent words.
- Search documents and pagination checkpoints are saved incrementally in **SQLite**, shared by the browser and desktop builds. Reloading restores them locally and resumes unfinished indexing. Previous IndexedDB caches are retired after SQLite is reachable.
- **Conversations** pauses/resumes indexing. **Filters → Clear saved index** clears only search checkpoints, preserving imported sessions; enabling Conversations rebuilds from SQLite without rereading the source apps.
- Indexing is bounded: 24 million characters overall, at most 48,000 per session, up to eight 60-message pages. Preview pages cap text at 64,000 characters and individual strings at 8,000. Coverage indicators disclose sampling and partial histories. The imported SQLite messages can contain more history than the searchable sample.
- Imports are capped at 50,000 normalized messages, 16 million text characters, or 2,000 pages per session. Claude SDK reads are limited to 128 MB transcript files; Codex streams bounded lines. Limits are disclosed in the session's history notes.

## Architecture / adding sources

```text
server/adapters/types.ts   SessionAdapter, Candidate, HistoryPage, ImportedMessage
server/adapters/index.ts   Source registry
server/adapters/*.ts       Source discovery, revisions, normalization, evidence
server/importer.ts        Selected-source import queue, deduplication, progress
server/store.ts           Session Atlas SQLite schema, migrations, atomic replacement
server/middleware.ts      Same-origin local library/import/index endpoints
server/standalone.ts      Authenticated loopback server + bundled web assets
src/imports.ts            Onboarding and source management
src/search/               Worker search and SQLite checkpoint bridge
src/layout.ts, scene.ts   Source-agnostic graph and cinematic visualization
src-tauri/                Native WebView shell, owned backend lifecycle
bin/session-atlas.mjs     npm desktop/browser launcher
scripts/                 Bundling and platform npm package staging
```

To add a harness, implement `SessionAdapter`: detection, metadata discovery, stable source-native identity, revision calculation, capabilities, and bounded history pages. Register it once; imports, SQLite persistence, source filters, and the graph consume the common model. Provide explicit parent/fork IDs only when the source records them. New launch destinations can be added separately in `src/launch-links.ts` and `server/launch.ts`.

Tests cover identities, incremental imports, rollback/recovery, SQLite persistence/index invalidation, cursor bounds, file evidence, relationship semantics, and search behavior. Real-history diagnostics and screenshots stay in ignored `tmp/`.
