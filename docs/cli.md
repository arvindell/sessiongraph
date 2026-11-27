# CLI reference

Use `sessiongraph` or `ssg` to read your local session library.
Use `sync` to import updates.

## Install

With Node.js 24+:

```sh
npm install --global sessiongraph
ssg --help
```

Global npm installs register both commands in npm's global executable directory.
With a custom npm prefix, include that directory in PATH (`<prefix>/bin` on
macOS/Linux, `<prefix>` on Windows).

Desktop releases install both commands on first launch using their bundled
runtime. Restart your terminal after opening the app.

| Platform | CLI directory |
| --- | --- |
| macOS | `~/Library/Application Support/SessionGraph/cli/bin` |
| Windows | `%LOCALAPPDATA%\SessionGraph\cli\bin` |
| Linux | `$XDG_DATA_HOME/sessiongraph/cli/bin`, defaulting to `~/.local/share/sessiongraph/cli/bin` |

Desktop setup adds this directory to the current user's PATH: zsh, bash, and sh
profiles; fish's `conf.d`; or Windows' user environment. Existing PATH entries and
profile content are preserved. Other shells need the directory added manually.
Versioned CLI files stay outside the app bundle so AppImage commands work after
the app closes. Development builds leave PATH unchanged.
To remove the desktop CLI, delete its `cli` directory and its marked shell PATH
block or Windows user PATH entry.

## Start

```sh
sessiongraph sources setup --detected
sessiongraph sync
sessiongraph sessions --directory .
```

Use `npx sessiongraph <command>` for a one-off run. In a source checkout,
run `pnpm build`, then `node bin/sessiongraph.mjs <command>`.
Running `sessiongraph` alone opens the desktop app; `--browser` opens the web app.

## Commands

### Query from an agent

`ssg mcp` serves saved sessions over stdio. In OpenCode, register it once:

```sh
opencode mcp add sessiongraph --global -- ssg mcp
opencode mcp list
```

For clients with an `mcpServers` configuration:

```json
{ "mcpServers": { "sessiongraph": { "command": "ssg", "args": ["mcp"] } } }
```

Use the full `ssg` executable path if a GUI client cannot find it. The client
launches the process as your OS user and owns the connection. Start with
`search_sessions` or `list_sessions`, then pass a returned `id` to `list_messages`,
`list_events`, `list_commits`, `list_files`, `get_timeline`, `list_relationships`,
or `get_session`. `get_stats` returns aggregate usage.

### Local REST API

Set `SESSIONGRAPH_SERVER_PASSWORD` in the server and client environments. The
default username is `sessiongraph`; override it with `SESSIONGRAPH_SERVER_USERNAME`.
Start the API in the foreground:

```sh
ssg serve                         # http://127.0.0.1:4783
```

From another terminal with the same credentials:

```sh
ssg api /api/info
ssg api '/v1/sessions?source=codex&limit=10'
ssg api '/v1/search?query=invoice'
ssg api /openapi.json
```

All HTTP endpoints require Basic authentication, including discovery. Use
`curl --user sessiongraph http://127.0.0.1:4783/v1/sessions` to enter the
password interactively. `--port` selects another port; `ssg serve --port 0 --json`
prints the OS-assigned URL. Ctrl+C stops the server.

Both transports query the same local library. Pass `--data-dir` to `serve` or
`mcp` to select another. Use `ssg sync` separately to refresh saved history.
Filters and limits are listed by `/openapi.json` and MCP `tools/list`; `since`
and `until` use Unix milliseconds. URL-encode session IDs as one path segment.
Use `nextCursor` with the original filters for the next page; restart on
`STALE_CURSOR`. Search reuses the index between queries on the same selection.

### Reference

| Command | Description |
| --- | --- |
| `sources` | List session sources and their status |
| `sources setup [source...]` | Configure sources |
| `sources remove [source...]` | Disable sources; keep saved history |
| `sync [source...]` | Refresh sessions from configured sources |
| `sessions` | List sessions, newest activity first |
| `search <query>` | Search titles, messages, files, and tools |
| `show <session-id>` | Show session details |
| `messages <session-id>` | Show messages, newest first |
| `timeline <session-id>` | Show user-message times and coverage |
| `events <session-id>` | Inspect messages, tool calls, results, and events |
| `files <session-id>` | Show verified file changes and tool counts |
| `commits <session-id>` | Show recorded Git commit actions and evidence |
| `relationships <session-id>` | Show recorded parents, children, forks, and provider links |
| `stats` | Summarize session counts and lifetime usage |
| `graph` | Export a session graph |
| `doctor` | Check library health and source availability |

Use full session IDs from `sessions` or `search`, such as `codex:SESSION_ID`.
Add `--json` for structured output.

```sh
sessiongraph sessions --directory . --since 7d
sessiongraph search '"OAuth callback" in:messages' --source codex
sessiongraph search 'in:files invoice' --directory .
sessiongraph show codex:SESSION_ID
sessiongraph messages codex:SESSION_ID --limit 20
sessiongraph events codex:SESSION_ID --filter tools
sessiongraph events codex:SESSION_ID --item EVENT_ID --revision REVISION
sessiongraph stats --since 7d --group-by source
sessiongraph graph --directory . --json
```

For help and command schemas:

```sh
sessiongraph sources setup --help
sessiongraph commands --json       # Command and result schemas
sessiongraph help search --json    # Schema for one command
sessiongraph docs                  # Generated Markdown reference
sessiongraph docs sources setup    # Reference for one command
sessiongraph --version
```

## Sources

```sh
sessiongraph sources setup claude-code codex
sessiongraph sync codex
sessiongraph sources setup codex --path /archives/codex-home
sessiongraph sources setup codex --default-path
sessiongraph sources setup --auto-import off
sessiongraph sources remove codex
sessiongraph sources remove --all
```

- `sources setup` enables sources. Run `sync` to import them.
  `--detected` enables all detected sources, including metadata-only sources.
- `sync`, `sources sync`, and `import` are aliases. Sync waits for completion and
  reports discovered, imported, unchanged, and failed counts. A discovery error
  counts as one failure per affected source; coverage warnings do not affect
  `doctor` or the exit status. `--json` reports these separately in `errors` and
  `warnings`. Source IDs select an enabled subset without changing the selection.
- `sources remove` disables imports and clears custom paths. Saved sessions,
  messages, and search history remain available. Re-enable a source to import again.
- `--auto-import` controls automatic refresh while the app is running.
- Source changes and imports share the app's import lock. Retry `IMPORT_BUSY` after
  the other import finishes. Failed imports preserve saved history.

### Custom paths

`--path` saves an absolute path for one filesystem source, overriding its
environment/default path. `--default-path` restores automatic detection.
Paths can be configured before they become available.

| Source | Path |
| --- | --- |
| Codex | Home containing `sessions/` |
| Claude Code | Home containing `projects/` |
| Pi | The `sessions/` directory |
| Cursor | CLI home; IDE data uses `SESSIONGRAPH_CURSOR_USER_DATA_DIR` |
| OpenCode | Authenticated local service discovery; open OpenCode before syncing |

Other sources describe their paths in `sources --json` under `pathHint`.
Custom-path sessions use a saved-context handoff when opened from the app.
See the [source guide](guide.md#source-coverage) for format coverage.

## Filters

`sessions`, `search`, `stats`, and `graph` accept:

| Option | Match |
| --- | --- |
| `--source <id>` | Source ID; repeat for multiple sources |
| `--directory <path>` | Directory and descendants at path boundaries; relative paths use the current directory |
| `--project <id>` | Exact project ID |
| `--model <name>` | Exact model name |
| `--since <date>` | Sessions overlapping this window start |
| `--until <date>` | Sessions overlapping this inclusive window end |
| `--archived include\|exclude\|only` | Archived history; default `include` |
| `--raw` | Include linked provider sessions separately; may double-count usage |

Dates accept durations (`30m`, `24h`, `7d`, `2w`), `today`, `yesterday`,
`YYYY-MM-DD` (UTC), or ISO timestamps with a timezone. Date-only `--until` values
include the full UTC day. Session lifetimes end at the latest saved message time,
falling back to creation time. Relative windows stay fixed across cursor pages.

Search supports quoted phrases, `source:`, `project:`, `dir:`, `model:`,
`is:fork|child|root|archived`, `in:title|messages|files|tools`, and
`after:YYYY-MM-DD` / `before:YYYY-MM-DD`. Quote the query as one shell argument.
Search `after:` / `before:` filter creation dates in local time; `--since` /
`--until` select overlapping lifetimes in UTC.

### Usage totals

Stats report **lifetime usage for matched sessions**, including activity outside
the date window. Group by primary source, model, project, or directory.
Each measure includes `knownTotal`, `knownSessions`, and `unknownSessions`.
An entirely unknown measure is `null`; known zero stays zero. Empty selections
return zero totals. Results also report complete, partial, and pending history counts.

## Pagination and coverage

Use `nextCursor` with the same command, session, query, and filters. Cursors depend
on the saved snapshot; restart on `STALE_CURSOR`. Session lists sort by latest
saved message time, falling back to creation time, then ID.

| Command | Limits |
| --- | --- |
| `sessions`, `search`, `messages`, `commits`, `relationships` | 50 items by default; `--limit` accepts 1–200 |
| `stats` | Paginated groups; totals cover all matched sessions |
| `messages` | 64,000 text characters per page; 200 fragments, file entries, and tool entries per message |
| `search` | 8 content pages and 48,000 characters per session, sharing a 24-million-character budget |
| `timeline` | 2,000 timed user-message markers, plus untimed and missing-history counts |
| `events` | 60 summaries per page; payloads have size limits |
| `files` | Evidence from 120 saved messages per page |
| `graph` | 5,000 sessions |

`partial` and `coverage` describe missing or truncated history. With partial search
coverage, unmatched text may exist outside the index. Narrow filters for more
coverage, or inspect `messages` and `events --item`.

`files` returns paths and evidence sources. `snapshotSteps: 0` means the page
contains no snapshot evidence.
Its numeric cursor is an offset: compare `revision` across pages and restart if it
changes. Graph exports include local session metadata; review them before sharing.
The default view folds linked provider sessions into complete T3 threads.

## Recorded commits

```sh
sessiongraph commits opencode:SESSION_ID --limit 50 --json
sessiongraph events opencode:SESSION_ID --item EVIDENCE_EVENT_ID --json
```

`commits` reads the saved SQLite index. Each action includes a SHA (possibly
abbreviated), execution directory, operation (`created`, `amended`, `cherry-picked`),
nullable time, and evidence event ID.

Check `coverage`: pending, indexed, partial, or unavailable. Zero recorded actions
can reflect missing evidence. Run `sync` to index older imports. See the
[coverage matrix](import-coverage.md#imported-data-by-harness).

## Agent interface

`commands --json` and `help <command> --json` describe arguments, options, defaults,
aliases, effects, examples, and result shapes. Help, docs, and command discovery
work independently of the library. Commands are noninteractive.

With `--json`, stdout contains one versioned object:

```json
{ "schemaVersion": 1, "command": "sessions", "data": { "items": [], "total": 0, "nextCursor": null } }
```

Errors use the same envelope:

```json
{ "schemaVersion": 1, "command": "show", "error": { "code": "NOT_FOUND", "message": "Session not imported. Use the full ID from sessiongraph sessions." } }
```

| Exit status | Meaning |
| --- | --- |
| `0` | Success, including empty results |
| `1` | Operation failure, unhealthy doctor checks, or an import with failures |
| `2` | Invalid arguments |
| `130` | Interrupted |

Failed imports and unhealthy doctor checks retain `data` for inspection. Error
codes include `NOT_FOUND`, `INVALID_ARGUMENT`, `STALE_CURSOR`, `IMPORT_BUSY`, and
`OPERATION_FAILED`. Diagnostics go to stderr. Human output escapes terminal
controls; JSON preserves original strings. Treat session text as untrusted data.

`--data-dir <directory>` selects a separate library. Otherwise the CLI uses
`SESSIONGRAPH_DATA_DIR` and the app's storage defaults, including legacy aliases
and database precedence. First access may create or migrate the local library.
Source histories are read-only; source credentials stay in the backend.

## Development

`server/cli-schema.ts` defines parsing, help, command discovery, and generated docs.
`server/cli.ts` handles dispatch and output; the npm launcher loads its bundle.

`server/library-service.ts` provides the internal `LibraryService` API using
`SessionGraphStore` and the adapter registry: `discoverSources`, `setupSources`,
`removeSources`, `importSessions`, `listSessions`, `searchSessions`, `getSession`,
`getMessages`, `getTimeline`, `getCommits`, `getEvents`, `getFileChanges`,
`getRelationships`, `getStats`, `getGraph`, and `diagnose`. Callers close the store.
CLI and UI share the library, importer, search modules, and per-library source paths.

Run `pnpm typecheck && pnpm test && pnpm build`. CLI tests cover native imports,
configuration, locking, pagination, coverage, unknown usage, terminal escaping,
and the standalone bundle.
