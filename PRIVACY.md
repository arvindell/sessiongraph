# Privacy and local data

**Your session content stays on your computer while you import, search, and explore it in SessionGraph.** No SessionGraph account is required for these actions. SessionGraph has no automatic cloud sync and sends no analytics or crash reports. Optional public profiles upload only a snapshot you explicitly preview and confirm.

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
| Sign in or manage an account/organization | GitHub and `sessiongraph.ai` | None; GitHub identity and account actions only |
| Preview a public graph | Local authenticated backend | None; preview is prepared locally |
| Publish or update a public graph | `sessiongraph.ai` | Only the configured metadata snapshot shown in the confirmed preview |
| View a public profile | `sessiongraph.ai` | Normal web request metadata; the selected snapshot is publicly readable |
| Open an external link | Your browser opens the destination you choose | The destination's normal browser/privacy behavior applies |
| Continue a session in another harness | An explicit launch opens the selected harness | The harness may send saved context to its model provider under its own settings |

The desktop app checks for updates automatically. GitHub and npm receive ordinary request metadata, such as your public IP address, when contacted. Update requests do not include your conversations, search terms, file paths, or session identifiers. SessionGraph therefore does not promise zero internet connections.

Preparing a cross-harness continuation may write a local Markdown handoff containing saved conversation context. Preparing or copying the command does not start an agent. Running it allows the destination harness to read that context; that harness's privacy policy and configuration apply.

## Optional public profiles

Publishing requires GitHub sign-in and explicit confirmation in **Publish and account**. The preview covers the current filtered selection and uses the same graph renderer as the website. You can inspect the exact JSON before publishing. Importing, signing in, or changing publication settings does not upload history. Each update requires a fresh confirmed preview; published snapshots do not track subsequent imports.

- **Always excluded:** project/session names, conversation text, tool content, code, paths, native identifiers, and costs. Anonymous numeric groups and recorded parent/fork links within the selection remain visible.
- **Configurable:** token counts, session timestamps, message counts, message timestamps, model, and harness. Disabled fields are omitted entirely. Message timestamps require session timestamps and message counts. Only recognized public model identifiers are retained; custom aliases are hidden.
- **Limits:** 10,000 sessions, 2 MB of public JSON, at most 2,000 message timestamps per session and 100,000 overall, and a compressed stored snapshot under 1 MB. Message metadata covers user/assistant messages. Partial history, unknown values, and limited timestamp coverage are disclosed.
- **Public identity:** the profile at `/@<github_username>` is attributable to that GitHub account. Anonymous session labels do not make the profile anonymous. Timing, activity, grouping, and usage may still reveal working patterns.
- **Removal:** unpublish from the desktop or website to remove the hosted graph. Signing out leaves it published. Copies already downloaded by other people are outside SessionGraph's control.

The hosted service stores the GitHub numeric ID and current username, the latest published snapshot, organization names/slugs, memberships, invitations, and hashed login tokens. GitHub repository access is not requested; the temporary provider token is discarded after login. Browser sessions use secure HttpOnly cookies. Desktop sign-in requires browser approval and a one-time verifier exchange. Login sessions expire after 30 days, device approvals after two minutes, and invitations after seven days. Expired records are rejected immediately and removed by scheduled cleanup.

Account and public-profile requests pass through Vercel; hosted records are stored in AWS. Providers receive ordinary connection metadata such as IP addresses. The application stores short-lived hashed request buckets for rate limiting. Organization membership does not share local sessions or publish a graph.

## Where data is stored

New installations use:

- **macOS:** `~/Library/Application Support/SessionGraph/sessiongraph.sqlite`
- **Windows:** `%LOCALAPPDATA%/SessionGraph/sessiongraph.sqlite`
- **Linux:** `$XDG_DATA_HOME/sessiongraph/sessiongraph.sqlite`, defaulting to `~/.local/share/sessiongraph/sessiongraph.sqlite`

`SESSIONGRAPH_DATA_DIR` overrides the location. Existing Session Atlas or Atlas libraries can be reused in place; see [storage resolution](docs/guide.md#local-storage-and-privacy). SQLite may also create `-wal` and `-shm` companion files. Saved-context Markdown files live in the library directory's `handoffs/` folder.

Optional desktop login credentials live in `account.json` beside the library. The backend writes this file with owner-only permissions where supported and never returns its bearer token to the UI. The file is not encrypted; protect it like other local credentials. Signing out revokes the token remotely and removes the file; if revocation fails, the app keeps it so you can retry. Publishing field preferences are saved in the local library.

**SessionGraph does not encrypt its database, search text, or handoff files.** Local filesystem permissions protect access where supported. Your OS account, disk encryption, device security, and backup/sync configuration affect confidentiality. SessionGraph does not control backups or the original harnesses' storage and cloud services.

Application bundles and npm packages contain application assets, not your imported library. The repository's demo images and video use synthetic sessions.

## How to verify the behavior

- Inspect the [source adapters](server/adapters/), [local API](server/standalone.ts), [search worker](src/search/worker.ts), and [desktop updater](src/updater.ts).
- After importing a library, disconnect from the internet and browse/search it. OpenCode imports additionally require its local service, but browsing saved history does not.
- Use an OS-level network monitor or firewall to inspect both the native app and its bundled Node backend. Browser developer tools alone do not show native updater traffic. Distinguish update checks from actions that explicitly open another application.
- Compare downloaded artifacts with the release's `SHA256SUMS`. The desktop updater verifies version-bound signatures before installation. These establish artifact integrity and authenticity; they are not a privacy audit.

These statements describe SessionGraph's implemented behavior. They are not a claim of an independent security audit or protection against other software with access to your device.
