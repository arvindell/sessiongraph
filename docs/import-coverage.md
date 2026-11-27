# Extended import coverage

The comparison uses [Tokscale at `8d9b509`](https://github.com/junhoyeo/tokscale/tree/8d9b509c4d719f3385e3c2464b770dc5257cb354), especially its scanner and session parsers. Tokscale is a format reference, not a runtime dependency. Its usage inventory includes providers, account aggregates, and opaque metadata; those are not equivalent to conversation history.

The source picker includes harnesses that can provide session identities and dates, including explicitly disclosed inferred placement dates. **Metadata only** imports a session without conversation messages. Usage-only inputs that cannot establish a session list and dates are excluded. Other sources import the recognized conversation/event formats below; this is not a guarantee of every historical version or complete pre-compaction context. The existing core sources are documented in the [guide](guide.md#source-coverage).

## Imported data by harness

This table describes **the current importer**, not every capability of the harness. ✅ = explicitly decoded in the supported format; ⚠️ = conditional, partial, or representation-dependent; ❌ = not extracted from the supported inputs. Even ✅ does not guarantee that every session recorded the field. Missing data stays unknown. “Files” means confirmed recorded changes, not reads, mentions, or proposed edits. “Links” means explicit session forks/children, not Git branches or chronological proximity.

| Harness | Messages | Tool calls/results | Changed files | Commit index | Workspace directory | Session links |
| --- | --- | --- | --- | --- | --- | --- |
| OpenCode V2 | ✅ | ✅ | ✅ snapshots / edits | ⚠️ confirmed executions | ✅ + move events | ✅ forks / children |
| Claude Code | ⚠️ SDK-visible chain | ✅ | ⚠️ successful edits | ⚠️ executions / native Git result | ✅ recorded cwd | ⚠️ children |
| Codex | ✅ local rollouts | ✅ | ✅ completed patches | ⚠️ confirmed executions | ✅ header / turn cwd | ✅ forks / children |
| T3 Code | ⚠️ V2 activity; V1 text | ⚠️ V2 only | ⚠️ actual-path changes | ⚠️ V2 executions | ✅ thread/worktree; per-command cwd conditional | ✅ explicit links + provider bindings |
| Cursor | ⚠️ representation-dependent | ⚠️ missing results in exports | ❌ | ❌ | ⚠️ metadata / verified workspace | ⚠️ explicit native fields |
| Gemini CLI | ✅ | ✅ | ⚠️ successful edits | ❌ | ⚠️ project-root marker | ⚠️ children |
| Qwen Code | ✅ | ✅ | ⚠️ successful edits | ❌ | ⚠️ recorded cwd | ✅ forks / children |
| Pi | ✅ retained tree | ✅ | ⚠️ successful edits | ❌ | ✅ header cwd | ❌ |
| GitHub Copilot CLI | ✅ | ✅ | ✅ applied fileEdits | ❌ | ⚠️ session context | ⚠️ children |
| GitHub Copilot Chat | ⚠️ saved VS Code chat | ✅ saved invocations | ⚠️ accepted edits | ❌ | ⚠️ single-folder local workspace | ❌ |
| Cline | ⚠️ API snapshots | ⚠️ retained blocks | ⚠️ successful edits | ❌ | ⚠️ matching metadata | ⚠️ recorded task/CLI links |
| Roo Code | ⚠️ API snapshots | ⚠️ retained blocks | ⚠️ successful edits | ❌ | ⚠️ matching metadata | ⚠️ task parents |
| Kilo Code extension | ⚠️ API snapshots | ⚠️ retained blocks | ⚠️ successful edits | ❌ | ⚠️ matching metadata | ⚠️ task parents |
| Continue | ⚠️ conversation snapshots | ⚠️ retained blocks | ❌ | ❌ | ⚠️ workspaceDirectory | ❌ |
| Prime Agent | ✅ Pi format | ✅ Pi format | ⚠️ successful edits | ❌ | ⚠️ header cwd | ❌ |
| Oh My Pi | ✅ Pi format | ✅ Pi format | ⚠️ successful edits | ❌ | ⚠️ header cwd | ❌ |
| Senpi / OmO Native | ✅ Pi format | ✅ Pi format | ⚠️ successful edits | ❌ | ⚠️ header cwd | ❌ |
| Kimchi | ✅ Pi format | ✅ Pi format | ⚠️ successful edits | ❌ | ⚠️ header cwd | ❌ |
| Gajae-Code | ✅ Pi format | ✅ Pi format | ⚠️ successful edits | ❌ | ⚠️ header cwd | ❌ |
| OpenClaw | ⚠️ DB / Pi export | ⚠️ retained message events | ⚠️ Pi export only | ❌ | ⚠️ Pi header only | ❌ |
| Hermes Agent | ✅ saved rows / summaries | ⚠️ retained blocks | ❌ | ❌ | ✅ native cwd | ✅ explicit forks / subagents |
| Amp | ⚠️ local / exported messages | ⚠️ retained blocks | ❌ | ❌ | ⚠️ recorded cwd | ❌ |
| Factory Droid | ⚠️ envelopes | ⚠️ retained blocks | ❌ | ❌ | ⚠️ recorded cwd | ❌ |
| Codebuff | ⚠️ chat snapshots | ⚠️ retained blocks | ❌ | ❌ | ❌ | ❌ |
| Freebuff | ⚠️ chat snapshots | ⚠️ retained blocks | ❌ | ❌ | ❌ | ❌ |
| Kimi CLI / Code | ⚠️ retained context; untimed | ⚠️ context tool messages | ❌ | ❌ | ❌ | ❌ |
| Grok Build | ⚠️ ACP chunks | ⚠️ basic events, not full executions | ❌ | ❌ | ❌ | ❌ |
| Jcode | ⚠️ snapshot + journal | ⚠️ retained blocks | ❌ | ❌ | ⚠️ recorded metadata | ❌ |
| Cherry Studio (agent mode) | ⚠️ Claude envelopes | ⚠️ retained blocks | ❌ | ❌ | ⚠️ recorded cwd | ❌ |
| Command Code | ⚠️ envelopes | ⚠️ retained blocks | ❌ | ❌ | ⚠️ recorded cwd | ❌ |
| ZCode | ⚠️ legacy envelopes | ⚠️ retained blocks | ❌ | ❌ | ⚠️ recorded cwd | ❌ |
| CodeBuddy | ⚠️ envelopes | ⚠️ retained blocks | ❌ | ❌ | ⚠️ recorded cwd | ❌ |
| WorkBuddy | ⚠️ envelopes | ⚠️ retained blocks | ❌ | ❌ | ⚠️ recorded cwd | ❌ |
| Proma | ⚠️ Pi / legacy envelopes | ⚠️ retained blocks | ⚠️ Pi format only | ❌ | ⚠️ header / recorded cwd | ❌ |
| DeepSeek Harness | ⚠️ final saved messages | ⚠️ retained blocks | ❌ | ❌ | ⚠️ recorded metadata | ❌ |
| Aside | ⚠️ envelopes | ⚠️ retained blocks | ❌ | ❌ | ⚠️ recorded cwd | ❌ |
| Mistral Vibe | ⚠️ saved context | ⚠️ retained blocks | ❌ | ❌ | ⚠️ recorded metadata | ❌ |
| Goose | ⚠️ saved rows | ⚠️ content variants | ❌ | ❌ | ✅ working_dir | ⚠️ explicit subagents |
| Zed Agent | ⚠️ native threads; untimed | ⚠️ tool-use blocks | ❌ | ❌ | ⚠️ single folder | ❌ |
| Devin CLI | ⚠️ retained message nodes | ⚠️ retained blocks | ❌ | ❌ | ✅ working_directory | ❌ |
| Devin Desktop | ⚠️ ACP notifications | ⚠️ basic events | ❌ | ❌ | ❌ | ❌ |
| Crush | ⚠️ saved parts / summaries | ⚠️ retained blocks | ❌ | ❌ | ⚠️ project registry | ❌ |
| Octofriend | ⚠️ native IR | ⚠️ supported IR blocks | ❌ | ❌ | ✅ native cwd | ❌ |
| Kilo CLI | ⚠️ native parts | ✅ tool states | ❌ | ❌ | ✅ native directory | ❌ |
| MiMo Code | ⚠️ native parts | ✅ tool states | ❌ | ❌ | ✅ native directory | ❌ |
| Xiaomi MiMo AI desktop | ⚠️ native parts | ✅ tool states | ❌ | ❌ | ✅ native directory | ❌ |
| Unsloth Studio | ⚠️ saved content | ⚠️ supported blocks | ❌ | ❌ | ❌ | ⚠️ explicit forks |
| Kiro | ⚠️ CLI / IDE / SQLite | ⚠️ representation-dependent | ❌ | ❌ | ⚠️ recorded metadata | ❌ |
| Mux | ⚠️ archive + active chat | ⚠️ retained blocks | ❌ | ❌ | ❌ | ❌ |
| MiniMax Code | ⚠️ existing captured messages | ⚠️ captured blocks | ❌ | ❌ | ❌ | ❌ |
| Muse Code | ⚠️ recognized event bodies | ⚠️ recognized blocks | ❌ | ❌ | ✅ workspace_root | ❌ |
| Junie | ⚠️ basic events only | ❌ full executions | ❌ | ❌ | ❌ | ❌ |
| Augment Code | ⚠️ response text only | ❌ | ❌ | ❌ | ❌ | ❌ |
| OpenCodeReview | ⚠️ review responses only | ❌ | ❌ | ❌ | ⚠️ header cwd | ❌ |
| Fx | ❌ metadata only | ❌ | ❌ | ❌ | ✅ workspace_root | ❌ |
| Antigravity cache | ❌ metadata only | ❌ | ❌ | ❌ | ❌ | ❌ |
| Antigravity CLI | ❌ opaque conversations | ❌ | ❌ | ❌ | ⚠️ protobuf workspace | ❌ |
| Antigravity extension | ❌ opaque conversations | ❌ | ❌ | ❌ | ⚠️ protobuf workspace | ❌ |

Session identity, title, source, recorded creation/update dates, and available model/provider metadata accompany imported sessions. Message timestamps, usage, reasoning, and attachments are independently conditional; a readable conversation does not imply complete timing or token/cost totals. Unsupported/binary blocks remain disclosed omissions. Recorded native usage is never estimated from text.

### Native Git data versus the commit index

| Harness | Native evidence available | Current treatment |
| --- | --- | --- |
| OpenCode V2 | ✅ shell input/result, optional exit/truncation metadata and explicit workdir; ✅ location-switch events | Preserve execution metadata and index conservative confirmed Git operations. Directory moves remain generic events, not a normalized location history. |
| Claude Code | ✅ Bash calls/results and envelope cwd; ⚠️ SDK declares `gitOperation.commit`; ⚠️ recorded `gitBranch` | Correlate calls/results across the full import. Enrich the SDK-visible UUID chain from raw envelopes; accept validated native commit results when present. Native Git persistence is contract/fixture-tested, not confirmed by the small audited live sample. Branch observations are not indexed. |
| Codex | ✅ tool calls/results; ⚠️ turn cwd; ⚠️ header `git.commit_hash`, branch and repository URL | Preserve execution cwd and parse recognized result envelopes. Starting HEAD is never creation evidence; header Git observations are not indexed. |
| T3 Code | ✅ V2 command input/output/status; ⚠️ exit code/native call ID/per-call cwd; ✅ thread branch/worktree and separate checkpoint records | Preserve execution metadata. Commands need explicit execution context or absolute `cd` / `git -C`; the thread's latest directory is not substituted. Branch/checkpoint data remains outside this lean index. |
| Hermes | ✅ native cwd; ⚠️ mutable `git_branch` / `git_repo_root` | Import cwd; branch/repository observations and commit extraction are not implemented. |
| Other harnesses | ⚠️ tool-result formats may contain more Git evidence | No validated commit extraction yet. A ❌ in the index column is an importer limitation, not proof that the harness lacks Git data. |

The index stores only **created**, **amended**, and **cherry-picked** actions with saved execution evidence. Pushes, `git log`, starting HEADs, chat claims, and internal harness checkpoints are excluded. A commit creator need not be the author of every included change. The parser accepts a deliberately small shell grammar: direct Git operations, optional `cd` / `git -C`, and `&&` chains of add/commit/push. Scripts, substitutions, heredocs, pipelines, redirects, ambiguous output, and missing/truncated evidence remain partial. Full SHAs stay full; abbreviated SHAs stay abbreviated. No Git command, repository scan, or network enrichment runs during import or reads.

`session.commits` reports `pending`, `indexed`, `partial`, or `unavailable`, extraction version, recorded count (nullable), and explanatory coverage. `indexed` means the supported extraction completed on the available records—not a complete audit of all real-world commits. Upgraded libraries start pending and refresh even when source revisions are unchanged. Failed refreshes retain the previous index. T3 and linked provider histories keep separate attribution; they are not summed or silently merged. See [commit history](guide.md#recorded-commit-history) for the UI/API and [CLI reference](cli.md).

## Local conversation formats

Paths below use `~` for the user's home. XDG data/config locations respect their environment overrides. Application-data paths use Application Support on macOS, APPDATA on Windows, and XDG config on Linux unless noted.

| Source ID / display name | Default local input | Coverage |
| --- | --- | --- |
| `prime-agent` / Prime Agent | `~/.prime/agent/{sessions,session-artifacts}/` | Pi-format session/message entries; explicit native IDs; child artifact history without guessed ancestry. |
| `omp` / Oh My Pi | `~/.omp/agent/sessions/` | Pi-format entries, reasoning, tools, compaction and branch events. |
| `senpi` / Senpi / OmO Native | `~/.senpi/agent/sessions/`, `~/.omo/agent/sessions/` | Pi-format entries. Project-local task children need an explicit history directory override. |
| `kimchi` / Kimchi | `~/.config/kimchi/harness/sessions/` | Pi-format entries. |
| `gajae` / Gajae-Code | `~/.gjc/agent/sessions/`, XDG `gjc/sessions/` | Pi-format entries. |
| `openclaw` / OpenClaw | `~/.openclaw/agents/*/{sessions/,agent/openclaw-agent.sqlite}`; `.clawdbot`, `.moltbot`, `.moldbot` equivalents | SQLite transcript events take precedence over overlapping JSONL/zstd exports. Rollover and event-parent links do not imply ancestry. Non-message SQLite events are currently omitted. |
| `hermes` / Hermes Agent | `~/.hermes/state.db`, `profiles/*/state.db` | Native messages and retained summaries. Structured content uses Hermes's explicit NUL + `json:` marker; ordinary JSON-looking text stays text. Only `source=subagent` establishes a child link; `_branched_from` establishes a fork. Compression/reset parents are not ancestry. |
| `amp` / Amp | XDG `amp/threads/`, Tokscale `amp-cache/threads/` | Local/exported thread messages. No sync is invoked. Usage-ledger times are not assigned to prompts. |
| `droid` / Factory Droid | `~/.factory/sessions/` | Saved conversation envelopes; excludes usage apportionment. |
| `codebuff`, `freebuff` / Codebuff, Freebuff | XDG config `manicode`, `manicode-dev`, `manicode-staging` chat messages | A positive `base2-free` root-agent marker assigns Freebuff; shared storage is not imported into both sources. No text-based token estimates. |
| `kimi` / Kimi CLI / Code | `~/.kimi/sessions/`, `~/.kimi-code/sessions/` | `context.jsonl` and optional wire-log session date. Untimed context stays untimed; pre-compaction and wire-only content may be absent. Desktop Kimi Work discovery is not implemented. |
| `grok` / Grok Build | `~/.grok/sessions/**/updates.jsonl` | ACP text chunks and basic events. Adjacent chunks are grouped; complete turn/tool reconstruction is unavailable. |
| `jcode` / Jcode | `~/.jcode/sessions/session_*.json` with `.journal.jsonl` | Snapshots plus append-message journals, deduplicated by message ID. |
| `cherry-studio` / Cherry Studio | Application `CherryStudio/{Data/Agents/.claude,.claude}/projects/` | Agent/Claude-mode transcripts only. Built-in chat `ai_usage_record` ledgers lack conversation text. |
| `command-code` / Command Code | `~/.commandcode/projects/` | Claude-style conversation envelopes. |
| `zcode` / ZCode | `~/.zcode/projects/` | Legacy transcript envelopes; v2 usage database is not a conversation import. |
| `codebuddy` / CodeBuddy | `~/.codebuddy/projects/` | Transcript envelopes; extension log variants are not yet decoded. |
| `workbuddy` / WorkBuddy | `~/.workbuddy-ai/projects/`, `~/.workbuddy/projects/` | Transcript envelopes; SQLite fallback is not yet decoded. |
| `proma` / Proma | `~/.proma/{agent-sessions,sdk-config/sessions,sdk-config/projects}/` and `.proma-dev` equivalents | Native Pi and legacy Claude envelopes. Matching native session IDs deduplicate copies. UI-journal/native-index reconciliation is not implemented. |
| `deepseek-harness` / DeepSeek Harness | `~/.dsh/sessions/**/session[.vN].jsonl[.zstd]` | Final saved message records. Streaming attempts and billing-only records are not turns. |
| `aside` / Aside | `~/.aside/u/*/sessions/*/messages.jsonl` | Conversation envelopes, identity scoped by account and native session. |
| `vibe` / Mistral Vibe | `~/.vibe/logs/session/*/{meta.json,messages.jsonl}` and legacy JSON | Saved context and metadata; no spreading cumulative token totals over turns. |
| `goose` / Goose | XDG/application `goose/sessions/sessions.db`, legacy `Block/goose` equivalents | Saved conversation rows. Unsupported content variants remain partial. |
| `zed` / Zed Agent | XDG `zed/threads/threads.db`; macOS Application `Zed/threads/threads.db`; Windows LOCALAPPDATA equivalent | JSON/zstd native thread blobs and externally tagged messages. Message times are unavailable. Imported threads are excluded; external ACP stores are separate. |
| `devin` / Devin CLI | XDG `devin/cli/sessions.db` | Native message nodes including retained in-session branches; node-parent edges are not session ancestry. |
| `devin-desktop` / Devin Desktop | Application `Devin/User/acp-events/` | Saved ACP notifications. Titles never merge desktop and CLI sessions. |
| `crush` / Crush | XDG `crush/projects.json` → registered project `crush.db` | Saved message parts and recorded session cost; unreliable token totals stay unknown. No recursive project scan. |
| `octofriend` / Octofriend | `~/.local/share/octofriend/sqlite.db` | Native trees, nodes and `octo-llm-ir/v1` messages. Nested subagent trajectories and unfamiliar IR variants are partial. |
| `kilo-cli` / Kilo CLI | XDG `kilo/kilo.db` | Native session/message/part tables, separate from extension Kilo Code. |
| `mimo-code`, `mimo-desktop` / MiMo Code, Xiaomi MiMo AI | XDG `mimocode/mimocode.db` | Native session/message/part tables. `session.version` starting `desktop-` selects desktop; shared records count once. |
| `unsloth` / Unsloth Studio | `~/.unsloth/studio/studio.db` | Chat threads and content, including explicit thread forks. Content-free API usage and training metrics are excluded. |
| `kiro` / Kiro | `~/.kiro/sessions/`; application/XDG `kiro-cli/data.sqlite3` | CLI header/JSONL, IDE `sess_*/session.json` plus messages, and `conversations_v2` tagged turns. Legacy IDE execution/chat snapshots are not yet decoded. |
| `mux` / Mux | `~/.mux/sessions/*/{chat-archive.jsonl,chat.jsonl}` | Durable archive followed by active chat, deduplicated by message ID. In-flight partials and workspace ancestry are unavailable. |
| `minimax-code` / MiniMax Code | Tokscale `headless/mcode/*.jsonl` | Previously captured messages with one explicit session identity. Capture-only usage without message content is not imported. No harness command is executed. |

## Partial event and metadata formats

| Source | Input | Coverage |
| --- | --- | --- |
| `muse` / Muse Code | XDG `muse/sessions/**/session.jsonl` | Recorded runtime events and recognized message envelopes; microsecond clocks normalized. Unknown bodies remain partial. |
| `junie` / Junie | `~/.junie/sessions/*/events.jsonl` | Basic agent events; state snapshots and unknown bodies omitted. Events are not counted as user prompts. |
| `augment` / Augment Code | `~/.augment/sessions/*.json` | Exchange completion records and available response text; typed response nodes and absent prompts are not reconstructed. |
| `opencodereview` / OpenCodeReview | `~/.opencodereview/sessions/**/*.jsonl` | Saved review response events; usage-only payloads do not establish prompts. |
| `fx` / Fx | `~/.fx/sessions/*/{usage-v2.json,session.json}` | **Metadata only.** Native session identity/date/workspace; usage snapshots contain no conversation. |
| `antigravity` / Antigravity | Tokscale `antigravity-cache/sessions/*.jsonl` | **Metadata only.** Native session identity; earliest recorded usage date places it. No sync or local RPC. |
| `antigravity-cli`, `antigravity-extension` | `~/.gemini/{antigravity-cli,antigravity}/conversations/*.db` | **Metadata only.** Bounded protobuf trajectory creation/workspace metadata. Conversation protobufs remain opaque; unknown timestamps are not guessed. |

**Excluded usage-only inputs:** Reasonix statistics, Trae and Warp/Oz usage caches, LM Studio server logs, and Hindsight memory-operation usage cannot establish supported session lists with dates. They are not offered as import sources. The schema v6 upgrade removes their obsolete selections, custom paths, status records, and active source filters; saved sessions and other source settings are retained. Fx and Antigravity remain available because their supported metadata formats provide session identities and dates.

**Provider attribution:** Sakana Fugu rollouts remain Codex sessions. Synthetic remains the provider of its originating harness; Octofriend has its own source. They do not create duplicate source identities.

## Overrides, bounds, and retention

Every additional source accepts `SESSIONGRAPH_<SOURCE_ID_UPPERCASE_WITH_UNDERSCORES>_HISTORY_DIR`. For example, `SESSIONGRAPH_HERMES_HISTORY_DIR` points to a directory containing `state.db`; `SESSIONGRAPH_MUX_HISTORY_DIR` contains session directories with `chat.jsonl`. Directory layout matchers still apply. Core-source overrides remain documented in the guide.

Defaults also honor the implemented native home variables: `HERMES_HOME`, `OPENCLAW_STATE_DIR`, `FACTORY_HOME`, `KIMI_HOME`, `KIMI_CODE_HOME`, `GROK_HOME`, `JCODE_HOME`, `DSH_HOME`, `VIBE_HOME`, `MUX_ROOT`, `UNSLOTH_STUDIO_HOME`, `GOOSE_PATH_ROOT`, `CRUSH_GLOBAL_DATA`, `CODEBUFF_DATA_DIR`, `FREEBUFF_DATA_DIR`, Pi-family home/session overrides, `GEMINI_CLI_HOME`, `TOKSCALE_CONFIG_DIR`, and `TOKSCALE_HEADLESS_DIR`. Nothing reads or executes source configuration or credentials.

File imports are bounded to 32 MB combined expanded data and 50,000 messages. Generic SQLite readers query private DB/WAL copies (8 GB maximum per database or WAL), with 32 MB fields and 64 MB aggregate query output. Nested queries and expanded blobs share a 64 MB / 50,000-record session budget. Oversized or unsupported sessions retain previously saved history. Database revisions include WAL changes; source changes during copying abort the snapshot. At most two private copies are retained and cleaned on eviction/exit. Failed authoritative database representations block fallback to stale exports.

T3 Code has no fixed database/WAL size or thread-count limit. It prefers copy-on-write clones; where unavailable, a full temporary copy requires enough free space and runs asynchronously. History pages stay on the verified discovery snapshot while the live server continues writing. The T3 adapter still caps individual item payloads at 256,000 characters and PR links at 100 per thread, and does not copy attachments or checkpoint file snapshots. The shared importer allows up to 75,000 records, 24 million text characters, or 3,000 pages per session, subject to lower limits in some adapters. The saved timeline is bounded to 300,000 events or 48 MB. These are retention limits, not date filters or UI pagination. Sessions marked as capped by the previous shared limits are retried on source refresh.

Missing message timestamps remain unknown. Native dates place database sessions; undated database histories are skipped with a warning. File histories can fall back to file dates and disclose this. Unsupported message blocks, binary attachments, missing tools, and absent snapshots remain partial. Token counts are never estimated from text; usage aggregates are not converted into conversations. No new harness is enabled automatically, and continuing a session remains an explicit user action through supported launch destinations.

Fixture tests cover each parser family, registry/display-name consistency, duplicate representations, compressed archives, legacy Cursor bubbles, immutable DB/WAL reads, source changes, partial events, metadata-only sources, and saved-history retention. Native writers inspected in addition to Tokscale include Hermes, Goose, Zed, Octofriend, Mux, and Unsloth. See [the importer comparison](importer-comparison.md) for the title, content-decoding, and cross-source identity decisions informed by CASS and Agent Sessions.
