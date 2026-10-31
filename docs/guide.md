# SessionGraph guide

**Explore & visualize all your LLM sessions**

A local-first galaxy of your LLM sessions. Import **OpenCode, Claude Code, Codex, Cursor, Gemini CLI, Qwen Code, Pi, GitHub Copilot CLI, Cline, Roo Code, Kilo Code, and Continue**, explore relationships and changed files, search conversations, and fly through their timeline. Source-specific coverage is listed below.

## Open SessionGraph

### Desktop

The Tauri 2 app uses the operating system's WebView and bundles its local Node runtime. Installed apps need neither Node nor a running development server.

Build on your machine (Node 24+, pnpm, Rust, and [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)):

```sh
pnpm install
pnpm desktop:build
```

Installers appear in `src-tauri/target/release/bundle/`. On macOS, open `macos/SessionGraph.app` or install using the DMG. `pnpm desktop:dev` builds and runs the native shell locally. The Rust toolchain is pinned in `rust-toolchain.toml`.

### npm launcher

Install and open the public npm launcher with Node 24+:

```sh
npx sessiongraph
# Or use your browser with a local backend:
npx sessiongraph --browser
```

The default command opens the native desktop app from your matching OS/architecture package. `--browser` instead starts a local authenticated server and opens the explorer in your default browser; keep the terminal open and press Ctrl+C to stop it. Both modes share the same saved SQLite library.

### Desktop updates

The desktop app checks GitHub Releases in the background. An unobtrusive **Update** pill appears in the lower-left corner when a newer version is available. Clicking it downloads and verifies the signed package; **Restart** installs it and relaunches the app. Failed downloads or installs can be retried. Offline checks stay quiet. Browser mode is updated by installing a newer launcher package.

To test installation before publishing:

```sh
pnpm package:desktop
# macOS Apple Silicon example:
npx --package ./release/sessiongraph-1.0.0.tgz \
    --package ./release/sessiongraph-app-darwin-arm64-1.0.0.tgz sessiongraph
```

The launcher requires Node 24+. Platform packages are optional dependencies selected by OS/architecture. The browser build is bundled into the launcher package. `scripts/package-desktop.mjs` builds both tarballs. Pushes to `main` build platform installers, create a version tag and GitHub release, and publish public npm packages. See [Releases](releases.md) for the workflow. macOS builds are ad-hoc signed but not notarized.

### Browser development

```sh
pnpm install
portless sessiongraph pnpm dev
# or: pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

`pnpm start` opens the built app with an authenticated, loopback-only server. A static `dist/` deployment alone cannot access local session history.

## Import and update

On first launch, choose the apps to import. Change that selection in **Settings → Sources** or **Manage sources** next to the source filter, then click **Import selected sources** / **Import updates**. The compact options show each app's icon, detection status, and saved count; hover for source details. **Refresh sessions** imports updates from your selected sources.

**Auto-import sessions** is on by default in **Settings → Sources**. It checks previously selected sources on startup, when returning to the app, and every minute while the app is visible. Checks pause while hidden or a dialog is open, share a 30-second cooldown with recent imports, and never overlap an active import. Unchanged libraries do not rebuild the graph. Both manual and automatic refresh preserve your camera, zoom, playback, and selection. Existing layout positions stay stable as new history arrives; **Fit view (F)** recalculates the overview when you want to reframe it. Automatic imports do not select new sources for you.

The auto-import choice is saved in the local SQLite library, so it survives desktop restarts and is shared by browser and desktop instances using that library. Turning it off stops future automatic checks; an import already running can finish. Manual Refresh remains available. There is no background service after the app closes. OpenCode's local service must still be running to import its new history.

Time presets and custom date ranges, source/project/directory filters, the archived and child-session toggles, 2D/3D mode, and the other Settings preferences are also saved in the library. They are restored before the first graph is shown, including when the desktop app starts on a different local port. Existing browser appearance preferences migrate to the library on first use.

Onboarding closes automatically after a successful import and library refresh. Import failures remain visible with retry controls.

- Source/native session IDs are the stable identity: importing the same session again updates its existing record. Duplicate source files and repeated message IDs do not create extra sessions/messages.
- Unchanged source revisions skip history reads. Changed sessions are reread and their normalized messages, timeline events, file evidence, and index version are replaced in one SQLite transaction.
- Failed or interrupted updates retain the previous saved history. Re-import retries unfinished sessions. Import status reports counts, failures, and coverage limitations.
- Forks and children remain distinct even if their text overlaps. Different harnesses' sessions are not merged based on matching titles, timestamps, or similar text.
- Deselecting a source stops future imports; saved sessions remain browsable offline. Missing source files are not treated as a request to erase SessionGraph's local copy.
- Imported data contains normalized conversation text, structured tool calls/results, recorded reasoning or summaries, lifecycle events, and file evidence. This is not a byte-for-byte backup: binary content, encrypted reasoning, and shortened payloads are disclosed. Unfamiliar event types retain their native type in a generic event envelope where available.

### Source coverage

| Source | Read-only interface | Relationships and limitations |
| --- | --- | --- |
| OpenCode | Official authenticated local service discovery and V2 GET API | Explicit forks and child IDs; authoritative snapshot paths where available. OpenCode must be running for an import, but not to browse saved data. Remote endpoints are rejected. |
| Claude Code | SDK `listSessions`, `getSessionMessages`, `getSubagentMessages`; local transcript metadata | All local projects, worktrees, and subagent transcripts. SDK-visible conversation chain can omit pre-compaction text. No inferred fork ancestry. File evidence requires a successful matching edit-tool result. |
| Codex | Bounded streaming reads of active and archived local JSONL rollouts | Explicit recorded fork/parent fields; completed file-change events. Mirrored event text is not imported twice. Store-only/cloud-only history and ordinary ChatGPT desktop/web chats are not imported. No agent process is started. |
| Cursor | IDE JSONL transcripts in `~/.cursor/projects/*/agent-transcripts/`, CLI `~/.cursor/chats/` and ACP `~/.cursor/acp-sessions/` stores | Explicit subagent directories; one representation per native ID, preferring the committed store conversation. No inferred forks or successful edits. Legacy Composer databases, older `.txt` transcripts, cloud-only and SDK-only history are excluded. |
| Gemini CLI | `~/.gemini/tmp/*/chats/` JSON/JSONL; sandbox cache equivalent | Reconstructs append-only patches and rewinds. Explicit subagent directories form parent links. Workspace identity comes from `.project_root`; unknown directories stay unknown. |
| Qwen Code | `~/.qwen/projects/*/chats/*.jsonl` | Recorded forks and parent sessions remain distinct. Tool results retain call IDs and recorded execution status. Daemon-only histories are excluded. |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | Imports all recorded branches, reasoning, tools, and compaction entries. Entry parent IDs describe the in-file tree; parent-session file paths are not guessed into fork/child relationships. |
| GitHub Copilot CLI | `~/.copilot/session-state/**/events.jsonl` | Final persisted messages replace streaming mirrors. Explicit spawning-parent IDs form child links. Only committed `fileEdits` records establish changed files, including recorded partial-success edits. Cloud-only sessions are excluded. |
| Cline | Extension `tasks/*/api_conversation_history.json`; `~/.cline/data/sessions/*/*.messages.json` | Matching task metadata or `session.json` supplies workspace and lineage. Database-only metadata remains unknown. Extension snapshots can omit UI-only and pre-compaction messages. |
| Roo Code | Extension `tasks/*/api_conversation_history.json` and `history_item.json` | Recorded task parents; partial API-conversation snapshots. XML tool requests alone do not establish successful edits. |
| Kilo Code | Legacy extension task JSON | Legacy extension histories only. Current Kilo CLI and migrated database histories are excluded. Same snapshot limitations as Roo Code. |
| Continue | `~/.continue/sessions/*.json` and session index | IDE/CLI conversation snapshots and recorded tool messages. No inferred relationships or edit evidence. Missing message times stay unknown; attachments and transient tool UI state are omitted. |

Source roots respect `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. `SESSIONGRAPH_SERVICE_FILE` selects a local OpenCode service registration. Adapters never read authentication files or execute source configuration, hooks, or agents. Source formats can evolve: unsupported history is disclosed rather than fabricated.

### Additional source locations

- Gemini respects `GEMINI_CLI_HOME` as a replacement home directory. `SESSIONGRAPH_GEMINI_HOME` selects a `.gemini`-style directory containing `tmp/`.
- Qwen respects `QWEN_RUNTIME_DIR`, then `QWEN_HOME`. `SESSIONGRAPH_QWEN_HOME` overrides both and contains `projects/`.
- Pi respects `PI_CODING_AGENT_DIR`; `SESSIONGRAPH_PI_SESSIONS_DIR` directly selects the sessions directory.
- `SESSIONGRAPH_COPILOT_HOME` selects a `.copilot`-style directory containing `session-state/`.
- Cline, Roo, and legacy Kilo discovery covers standard VS Code, Insiders, VSCodium, Cursor, Windsurf, and local VS Code Server extension storage. `SESSIONGRAPH_CLINE_HOME`, `SESSIONGRAPH_ROO_HOME`, and `SESSIONGRAPH_KILO_HOME` select storage directories containing `tasks/`. Cline's override can also contain `data/sessions/`; its normal CLI discovery respects `CLINE_DIR`, `CLINE_DATA_DIR`, and `CLINE_SESSION_DATA_DIR`.
- Continue respects `CONTINUE_GLOBAL_DIR`; `SESSIONGRAPH_CONTINUE_HOME` overrides it and contains `sessions/`.

These file adapters read stable snapshots bounded to 32 MB combined, 50,000 records/messages, 20,000 histories/directories, 100,000 directory entries, and six levels of nested directories. Symlink history files are skipped. Changing, unreadable, or oversized sources retain their saved imports. Missing message times remain unknown; session creation falls back to recorded metadata, the first recorded message, or file time. File snapshots are unavailable for these sources; successful matching edit results supply evidence where supported. Binary attachments and unsupported blocks are disclosed as omitted.

### Cursor details

- Select **Cursor** in **Manage sources**, then import. Cursor need not be running. This is a local-format adapter, not a supported Cursor history-export API; the [Cursor SDK](https://cursor.com/docs/sdk/typescript) documents its own local agent store.
- IDE exports are marked partial because tool results and pre-compaction context may be absent. Recorded message IDs are preserved; otherwise stable byte offsets or ordered blob occurrences retain repeated identical turns. Images and unsupported content are disclosed as omitted. A broken primary store never downgrades saved history to a shorter transcript export.
- Only recorded message timestamps and Cursor's leading timezone-qualified timestamp envelope place message dots. Missing timestamps remain unknown. When session creation is unavailable, placement uses the first recorded message or the file timestamp, with a coverage note.
- Working directories come from recorded metadata or an unambiguous forward match against Cursor's workspace folder metadata. Encoded project names are never reverse-decoded into guessed paths. Choose a folder in the launcher when the original directory is unknown.
- Store reads copy the database and its WAL into a temporary private directory, verify that the source stayed stable, and open only the copy with read-only SQLite. Temporary copies are removed after reading. Limits: 20,000 histories, 256 MB per database/WAL, 2 MB per blob, and 64 MB / 50,000 nodes / 16 million text characters per store conversation. Changing or unsupported stores preserve previously saved history.
- Override discovery with `SESSIONGRAPH_CURSOR_HOME` (the `.cursor` directory) and `SESSIONGRAPH_CURSOR_USER_DATA_DIR` (Cursor's application data directory, containing `User/workspaceStorage`). These are SessionGraph settings. Custom-root histories use saved-context continuation.

## Local storage and privacy

**Your session content stays on this computer during import, search, and exploration.** No account. No cloud sync. No telemetry. See [Privacy and local data](../PRIVACY.md) for the full network disclosure and ways to verify the behavior.

SessionGraph's own SQLite database stores source selection, the auto-import preference, session metadata, normalized messages and timeline events, file evidence, import revisions, and bounded search checkpoints. New installations use:

- macOS: `~/Library/Application Support/SessionGraph/sessiongraph.sqlite`
- Linux: `$XDG_DATA_HOME/sessiongraph/sessiongraph.sqlite` (default `~/.local/share/sessiongraph/sessiongraph.sqlite`)
- Windows: `%LOCALAPPDATA%/SessionGraph/sessiongraph.sqlite`
- Override with `SESSIONGRAPH_DATA_DIR`.

Existing installations reuse `Session Atlas/session-atlas.sqlite` or `Atlas/atlas.sqlite` in place (lowercase directory names on Linux), including saved sessions, source selection, search checkpoints, WAL files, and import locks. A current `sessiongraph.sqlite` library takes precedence if one already exists. Explicit data-directory overrides search only that directory. The previous `SESSION_ATLAS_*` settings and original `ATLAS_DATA_DIR` / `ATLAS_SERVICE_FILE` remain supported as aliases; `SESSIONGRAPH_*` settings take precedence. Browser preferences and the last launch target also accept their previous storage keys when using the same origin.

All parsing, deduplication, indexing, and visualization run on this computer. No telemetry, embeddings service, model inference, uploads, or remote fonts are used. Source histories are read-only. OpenCode uses its authenticated API; Cursor databases are parsed only from temporary private copies. The native app binds its backend to `127.0.0.1` on a random port with an ephemeral authentication cookie; imports from other origins are rejected. Source credentials stay in the backend.

The database is a local plaintext copy of imported conversation text, protected by filesystem permissions. It uses WAL journaling, versioned migrations, atomic session replacement, and a cross-process import lock. App bundles and npm tarballs contain only application assets, never your database. Opening a session in a destination app is a separate, explicit action; that app controls its own network behavior.

Desktop update checks and downloads contact GitHub without session content; npm installation contacts its registry. Those services receive ordinary connection metadata, including your public IP address. SessionGraph does not encrypt stored history, search text, or saved-context handoff files. Your device permissions, disk encryption, and backups affect confidentiality.

## Explore

- Full-viewport, antialiased Three.js map with floating, draggable, dismissible cards. **H** hides/restores cards; **F** fits the view.
- Source badges distinguish harnesses in the list, inspector, tooltips, and search. Filter by source, project, directory/worktree, date, or children. The default window is **All time**; archived sessions are hidden unless enabled in **Settings → Interface → Show archived sessions**. Previously saved choices remain honored.
- Selecting a session dims surrounding nodes, halos, and trails. Click or tap empty map space to clear selection and restore the full map brightness without moving the camera. Drags and right-clicks keep the selection; **Settings → Graphics → Focus dimming** controls the dimming effect.
- Time runs left to right. Each session orb appears at creation, travels with the playback frontier, and leaves its trail behind. It rests at the latest saved message timestamp. Missing message timestamps leave the orb at creation; metadata update times are not substituted. Directory colors group sessions; only distinct fork and child edges represent ancestry. Date filters use session creation; the list and histogram follow session endpoints.
- Click a session to center its orb and recent message trail together in the map area between your panels. Message dots match the session color; small, dim icons distinguish user and assistant messages. Icons are collision-culled and bounded to 64; all plotted dots remain interactive. The latest message uses the session sphere instead of an overlapping dot and remains readable in the explorer. Markers load lazily, capped at the latest 2,000 timed conversation messages within the lifetime, plus a selected older message. Counts disclose untimed and out-of-lifetime messages.
- Hover a marker to preview its message. Click to focus that marker and open message details below the session card, keeping the map interactive. **Previous / Next** and **← / → / ↑ / ↓** step through user and assistant messages and focus their recorded positions. Untimed messages remain readable without inventing a map location. Escape closes message details first; arrow keys on session cards or the map navigate sessions when message details are closed. Form controls and panel-drag handles retain their own arrow-key behavior.
- **Browse messages** opens 60-message pages of the conversation. Details include message text, recorded time, and source provenance. Tool calls, reasoning, and other detailed events are excluded from the dots and message browser. Underlying imported history and file evidence remain saved. Source order is preserved even without timestamps. Nearby markers can overlap; step through them with the navigation controls.
- Older libraries migrate to schema v4 using their existing saved messages. Reconstructed events are labeled partial; **Refresh sessions** enriches them with structured source events. The explorer asks you to reload if an import changes its snapshot while browsing.
- Click a session for changed-file satellites and source evidence. File details load in 120-message batches; the map displays at most 80 files. Evidence describes historical edits, not today's Git diff.
- **Play** follows newly appearing clusters with a half-turn around the graph and a closing pullback (30 seconds at 1×). Dragging, zooming, scrubbing, fitting, or opening a dialog pauses playback. 2D pans without orbiting; reduced motion keeps the camera still.
- The timeline's calendar offers a styled range picker with presets, month/year navigation, typed ISO dates, and keyboard navigation. Date boundaries are inclusive in your local timezone. Select menus share keyboard/typeahead behavior and styling across filters, settings, search, and the launcher.
- **Open session** lets you choose one of eight CLI destinations and a working directory. See cross-harness continuation below.
- Unknown model/cost/token fields stay unknown. Session selection is encoded in a local permalink.

### Sound and appearance

Open **Settings** using the gear button. Changes apply live and persist on this device:

- **Interface:** 2D/3D, system/on/off motion, list density, archived-session visibility, panel transparency, and reset panel positions.
- **Sound:** procedural interaction tones, volume, chime preview, and mute. Only control interactions produce sound; there is no ambient audio. The speaker button mutes feedback quickly; no audio is downloaded.
- **Graphics:** performance/balanced/high rendering, glow, node size, stars, labels, and focus dimming.
- **Trails & playback:** all/selected/hidden lifetime trails, brightness, decorative flow and speed, relationship links, message dots, and 0.25×–3× playback. Flow respects reduced motion and never changes message timestamps or saved trail endpoints.

**Restore defaults** resets these preferences; they are saved in the local library, with an appearance cache in browser/WebView local storage.

## Continue in another harness

Select a session, click **Open session**, and choose **Open in → OpenCode / Claude Code / Codex / Cursor Agent / Gemini CLI / Qwen Code / Pi / GitHub Copilot CLI**. The original working folder is prefilled; choose an existing folder if it has moved.

- The same harness resumes the native session (`opencode --session`, `claude --resume`, `codex resume`). OpenCode also offers its local browser route. Claude subagent histories use a fresh context handoff because they cannot be resumed independently.
- Cursor CLI sessions from the default store can resume with [`cursor-agent --resume`](https://cursor.com/docs/cli/reference/parameters) in their verified original folder. Cursor IDE, ACP, subagent, custom-root, and relocated histories start a new Cursor Agent session with saved context. Install the Cursor Agent CLI to use this destination.
- Gemini, Qwen, and Copilot use `--resume <native ID>`; Pi uses `--session <native ID>`. Eligible local histories resume in their original working directory. SessionGraph-specific custom-root overrides, relocated directories, and child sessions use saved-context handoffs. Gemini sandbox-cache histories also use handoffs. No source agent installation is needed just to read its saved files.
- A different harness starts a **new session with saved context**. It reads a local Markdown handoff, recaps where the conversation left off, and asks what to do next. Preparing or copying the command does not start an agent. Saved context works even when the original source app is offline.
- Handoffs preserve the initial user request and up to 200 recent messages in conversation order, bounded to roughly 166,000 text characters. Long messages/tool outputs are shortened. The chooser displays coverage and the context file path. Files, credentials, tool state, and native session identities are not migrated.
- Context files live in `handoffs/` beside SessionGraph's database, with private filesystem permissions. Identical saved context reuses the same file. They stay on disk so a copied command can be used later; remove them when no longer needed.
- Installed CLIs are detected locally, including Codex's macOS app-bundled CLI. **Open in …** opens macOS Terminal, Windows PowerShell, or an available Linux terminal. **Copy command** is available when automatic opening is unavailable; install a missing target CLI before running it. Windows commands use PowerShell syntax.

## Search

Press **/** or **⌘/Ctrl+K**. MiniSearch runs in a worker with fuzzy, accent-insensitive, prefix matching and title-first ranking. Results are virtualized; search pauses map rendering and playback.

- **↑/↓**, **Page Up/Down**, **Enter**, **Esc** navigate, explore, and close.
- **All history / Current view** changes scope (**Alt+S**).
- Filters: `source:codex`, `source:claude-code`, `project:app`, `dir:worktree`, `model:claude`, `is:fork|child|root|archived`, `after:2026-09-01`, `before:2026-10-31`.
- Fields: `in:title`, `in:files`, `in:messages`, `in:tools`; quoted phrases require adjacent words.
- Search documents and pagination checkpoints are saved incrementally in **SQLite**, shared by the browser and desktop builds. Reloading restores them locally and resumes unfinished indexing. Previous IndexedDB caches are retired after SQLite is reachable.
- **Conversations** pauses/resumes indexing. **Filters → Clear saved index** clears only search checkpoints, preserving imported sessions; enabling Conversations rebuilds from SQLite without rereading the source apps.
- Indexing is bounded: 24 million characters overall, at most 48,000 per session, up to eight 60-message pages. Preview pages cap text at 64,000 characters and individual strings at 8,000. Coverage indicators disclose sampling and partial histories. The imported SQLite messages can contain more history than the searchable sample.
- Imports are capped at 50,000 normalized messages, 16 million text/payload characters, or 2,000 pages per session. Structured event payloads are additionally bounded to 128,000 characters per message, and the timeline table to 200,000 items / 32 MB per session. Claude SDK reads are limited to 128 MB transcript files; Codex streams bounded lines. Limits are disclosed in history coverage.

## Architecture / adding sources

```text
server/adapters/types.ts   SessionAdapter, Candidate, HistoryPage, ImportedMessage
server/adapters/index.ts   Source registry
server/adapters/*.ts       Source discovery, revisions, normalization, evidence
server/importer.ts        Selected-source import queue, deduplication, progress
server/store.ts           SessionGraph SQLite schema, migrations, atomic replacement
server/activity.ts        Saved-message timing and human-turn classification
server/events.ts          Harness-neutral event normalization and payload bounds
server/event-store.ts     Ordered event storage, coverage, snapshot-safe pagination
server/handoff.ts         Bounded saved-context documents and local persistence
server/launch.ts          Native resume and cross-harness terminal launches
server/middleware.ts      Same-origin local library/import/index endpoints
server/standalone.ts      Authenticated loopback server + bundled web assets
src/imports.ts            Onboarding and source management
src/search/               Worker search and SQLite checkpoint bridge
src/layout.ts, scene.ts   Source-agnostic graph and cinematic visualization
src/timeline.ts           Shared message/tool/event envelope and presentation types
src/event-explorer.ts     Lazy user/assistant message browsing and details
src/event-hover.ts        Bounded, cancellable message previews on marker hover
src/preferences.ts        Validated, versioned local appearance/audio settings
src/settings.ts, audio.ts Settings dialog and offline procedural audio lifecycle
src-tauri/                Native WebView shell, owned backend lifecycle
bin/sessiongraph.mjs      npm desktop/browser launcher
scripts/                 Bundling and platform npm package staging
```

To add a harness, implement `SessionAdapter`: detection, metadata discovery, stable source-native identity, revision calculation, capabilities, and bounded history pages. Register it once; imports, SQLite persistence, source filters, and the graph consume the common model. Provide explicit parent/fork IDs only when the source records them. New launch destinations can be added separately in `src/launch-links.ts` and `server/launch.ts`.

Populate `ImportedMessage.events` with ordered `TimelineEvent` envelopes (`message`, `tool_call`, `tool_result`, `reasoning`, `compaction`, `file_change`, `error`, or `event`). Preserve native IDs/types, role, nullable time and provenance, explicit tool correlation/parent references, status, and bounded text/input/output. Use `kind: 'event'` for unfamiliar source events. `undefined` events means a legacy flattened import; `[]` explicitly records no events. File evidence is normalized separately from requested edits. SQLite event IDs are scoped to a session and derived from native message/event identity; timestamp ties do not collapse items. Refreshing a snapshot replaces messages, events, coverage, and search invalidation atomically.

Tests cover identities, incremental imports, rollback/recovery, SQLite migrations/index invalidation, message timing, trail alignment, handoff coverage, command escaping, local API boundaries, file evidence, relationships, and search. Real-history diagnostics and screenshots stay in ignored `tmp/`.
