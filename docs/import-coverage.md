# Extended import coverage

The comparison uses [Tokscale at `8d9b509`](https://github.com/junhoyeo/tokscale/tree/8d9b509c4d719f3385e3c2464b770dc5257cb354), especially its scanner and session parsers. Tokscale is a format reference, not a runtime dependency. Its usage inventory includes providers, account aggregates, and opaque metadata; those are not equivalent to conversation history.

The source picker includes the independent harnesses from that inventory. **Metadata only** imports a native session without conversation messages. **Detection only** explains why an available usage source cannot be imported and creates no sessions. Other sources import the recognized conversation/event formats below; this is not a guarantee of every historical version or complete pre-compaction context. The existing core sources are documented in the [guide](guide.md#source-coverage).

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

**Detection only:** `reasonix` (`~/.reasonix/stats/`), `trae` (Tokscale `trae-cache/sessions/`), `warp` (Tokscale `warp-cache/`), `lm-studio` (`~/.lmstudio/server-logs/`), and `hindsight` (`~/.hindsight/usage/`). These compared inputs contain request/account usage rather than supported native conversation histories. Reasonix's separate transcripts are not yet supported. Detection produces an explanation and no synthetic sessions.

**Provider attribution:** Sakana Fugu rollouts remain Codex sessions. Synthetic remains the provider of its originating harness; Octofriend has its own source. They do not create duplicate source identities.

## Overrides, bounds, and retention

Every additional source accepts `SESSIONGRAPH_<SOURCE_ID_UPPERCASE_WITH_UNDERSCORES>_HISTORY_DIR`. For example, `SESSIONGRAPH_HERMES_HISTORY_DIR` points to a directory containing `state.db`; `SESSIONGRAPH_MUX_HISTORY_DIR` contains session directories with `chat.jsonl`. Directory layout matchers still apply. Core-source overrides remain documented in the guide.

Defaults also honor the implemented native home variables: `HERMES_HOME`, `OPENCLAW_STATE_DIR`, `FACTORY_HOME`, `KIMI_HOME`, `KIMI_CODE_HOME`, `GROK_HOME`, `JCODE_HOME`, `DSH_HOME`, `VIBE_HOME`, `MUX_ROOT`, `UNSLOTH_STUDIO_HOME`, `GOOSE_PATH_ROOT`, `CRUSH_GLOBAL_DATA`, `CODEBUFF_DATA_DIR`, `FREEBUFF_DATA_DIR`, Pi-family home/session overrides, `GEMINI_CLI_HOME`, `TOKSCALE_CONFIG_DIR`, and `TOKSCALE_HEADLESS_DIR`. Nothing reads or executes source configuration or credentials.

File imports are bounded to 32 MB combined expanded data and 50,000 messages. SQLite imports query private DB/WAL copies (8 GB maximum per database or WAL), with 32 MB fields and 64 MB aggregate query output. Nested queries and expanded blobs share a 64 MB / 50,000-record session budget. Oversized or unsupported sessions retain previously saved history. Database revisions include WAL changes; source changes during copying/reading abort the read. T3 Code pages stay on the verified discovery snapshot while its live server continues writing; later imports pick up newer revisions. At most two private copies are retained and cleaned on eviction/exit. Failed authoritative database representations block fallback to stale exports.

Missing message timestamps remain unknown. Native dates place database sessions; undated database histories are skipped with a warning. File histories can fall back to file dates and disclose this. Unsupported message blocks, binary attachments, missing tools, and absent snapshots remain partial. Token counts are never estimated from text; usage aggregates are not converted into conversations. No new harness is enabled automatically, and continuing a session remains an explicit user action through supported launch destinations.

Fixture tests cover each parser family, registry/display-name consistency, duplicate representations, compressed archives, legacy Cursor bubbles, immutable DB/WAL reads, source changes, partial events, metadata-only sources, and saved-history retention. Native writers inspected in addition to Tokscale include Hermes, Goose, Zed, Octofriend, Mux, and Unsloth. See [the importer comparison](importer-comparison.md) for the title, content-decoding, and cross-source identity decisions informed by CASS and Agent Sessions.
