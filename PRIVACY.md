# Privacy and local data

**Your session content stays on your computer while you import, search, and explore it in SessionGraph.** No SessionGraph account is required. SessionGraph has no cloud sync and sends no analytics or crash reports.

## What happens locally

- Imports read only the sources you select. Source histories are not modified, and importing does not start an agent, resume a conversation, or invoke a model.
- Auto-import is enabled by default after source selection. It checks on startup, when returning to the app, and every minute while visible. Disable it in **Settings → Sources → Auto-import sessions**; this choice is saved in the local library and survives desktop restarts. Disabling it stops future automatic checks; an import already running can finish.
- Parsing, indexing, search, and visualization run on your computer. Search does not use a remote embeddings or model service.
- Imported conversations, metadata, timeline events, file-change evidence, and search checkpoints are saved in SessionGraph's local SQLite library.
- View filters, time ranges, and appearance preferences are saved in the local SQLite library. Appearance preferences are also cached in browser/WebView local storage. Fonts and application assets are bundled.
- Saved history remains available when a source is offline. Deselecting a source stops future imports; it does not delete previously imported history. Clearing the search index preserves imported history.

## Network access

| Action | Connection | Session content sent externally by SessionGraph |
| --- | --- | --- |
| Browse, search, and visualize saved history | Authenticated backend on `127.0.0.1` | None |
| Import OpenCode history | OpenCode's authenticated loopback API; OpenCode must be running locally | None |
| Import Claude Code, Codex, Cursor, Gemini CLI, Qwen Code, Pi, GitHub Copilot CLI, Cline, Roo Code, Kilo Code, or Continue history | Local history reads within the [documented source coverage](docs/guide.md#source-coverage) | None |
| Check for or download desktop updates | GitHub Releases and its download infrastructure | None |
| Install or update through npm | npm registry and its download infrastructure | None |
| Open an external link | Your browser opens the destination you choose | The destination's normal browser/privacy behavior applies |
| Continue a session in another harness | An explicit launch opens the selected harness | The harness may send saved context to its model provider under its own settings |

The desktop app checks for updates automatically. GitHub and npm receive ordinary request metadata, such as your public IP address, when contacted. Update requests do not include your conversations, search terms, file paths, or session identifiers. SessionGraph therefore does not promise zero internet connections.

Preparing a cross-harness continuation may write a local Markdown handoff containing saved conversation context. Preparing or copying the command does not start an agent. Running it allows the destination harness to read that context; that harness's privacy policy and configuration apply.

## Where data is stored

New installations use:

- **macOS:** `~/Library/Application Support/SessionGraph/sessiongraph.sqlite`
- **Windows:** `%LOCALAPPDATA%/SessionGraph/sessiongraph.sqlite`
- **Linux:** `$XDG_DATA_HOME/sessiongraph/sessiongraph.sqlite`, defaulting to `~/.local/share/sessiongraph/sessiongraph.sqlite`

`SESSIONGRAPH_DATA_DIR` overrides the location. Existing Session Atlas or Atlas libraries can be reused in place; see [storage resolution](docs/guide.md#local-storage-and-privacy). SQLite may also create `-wal` and `-shm` companion files. Saved-context Markdown files live in the library directory's `handoffs/` folder.

**SessionGraph does not encrypt its database, search text, or handoff files.** Local filesystem permissions protect access where supported. Your OS account, disk encryption, device security, and backup/sync configuration affect confidentiality. SessionGraph does not control backups or the original harnesses' storage and cloud services.

Application bundles and npm packages contain application assets, not your imported library. The repository's demo images and video use synthetic sessions.

## How to verify the behavior

- Inspect the [source adapters](server/adapters/), [local API](server/standalone.ts), [search worker](src/search/worker.ts), and [desktop updater](src/updater.ts).
- After importing a library, disconnect from the internet and browse/search it. OpenCode imports additionally require its local service, but browsing saved history does not.
- Use an OS-level network monitor or firewall to inspect both the native app and its bundled Node backend. Browser developer tools alone do not show native updater traffic. Distinguish update checks from actions that explicitly open another application.
- Compare downloaded artifacts with the release's `SHA256SUMS`. The desktop updater verifies version-bound signatures before installation. These establish artifact integrity and authenticity; they are not a privacy audit.

These statements describe SessionGraph's implemented behavior. They are not a claim of an independent security audit or protection against other software with access to your device.
