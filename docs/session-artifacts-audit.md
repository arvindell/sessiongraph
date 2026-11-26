# Session-linked commits, files, branches, and directories

Investigation: November 6, 2026. Implementation update: November 8, 2026.

## Implemented first version

The approved lean design is now implemented in source: existing sessions and tool events, one `session_commits` table, and small per-session extraction metadata. Execution cwd/exit codes and conditional Claude native Git results are retained; conservative creation/amendment/cherry-pick extraction runs atomically during import. Indexed API/CLI reads, selected-session graph markers, and evidence inspection are available. See the [guide](guide.md#recorded-commit-history) and [harness data matrix](import-coverage.md#imported-data-by-harness) for actual supported behavior.

The broad multi-table design below is **historical and superseded for this feature**. Separate repository, payload, branch, location, file-summary, and checkpoint indices remain proposals. Provider histories keep their own commit attribution; they are not automatically aggregated. Full local Git enrichment and arbitrary-shell parsing are not implemented. The contract-supported Claude native-result path has fixture coverage; the original live-sample limitation still applies.

<details>
<summary>Original investigation and broader proposal (historical)</summary>

## Conclusion

Normalize evidence once during import, then serve indexed session-to-artifact links to the graph. We already read changed histories during import; rendering should never need another conversation scan to discover commits or files.

There is no universal source-provided `session.commits` or complete audit log of everything a session changed. Several sources provide strong structured evidence, and others provide matching tool executions/results from which particular operations can be extracted. Keep the relationship and its evidence explicit: **created a commit**, **started at a commit**, and **mentioned a commit** are different facts.

Likewise, a workspace snapshot establishes a change during an interval, not exclusive authorship when another agent or person shares that workspace. "Recorded changes" is supportable; "every change made by this agent" is generally not.

## What the current app stores

- [`Session`](../packages/core/src/types.ts) contains native identity, one directory/project, explicit lineage/provider links, timing, and available model/usage metadata. There are no normalized commits, Git branches, repository identities, or directory histories.
- [`ImportedMessage`](../server/adapters/types.ts) contains per-message file evidence, tool names, and structured timeline events. File evidence currently stores only `path`, evidence category, and `steps`; it loses change kind, rename pairing, and line statistics.
- [`SessionGraphStore.detail()`](../server/store.ts) reparses 120 saved message JSON objects per request and aggregates their files/tools. [`loadFiles()`](../src/main.ts) requests every page when selecting a session. This is the scan that a materialized index should replace.
- [`timeline_items`](../server/event-store.ts) already indexes event identity, time, kind, and tool-call correlation, but commits/branches/locations are not extracted into queryable records.
- OpenCode's [`summarizeMessages()`](../server/opencode.ts) recognizes directory moves, but [`opencodeAdapter.read()`](../server/adapters/opencode.ts) does not carry its `locations` into imported messages. The saved detail endpoint always returns `locations: []`. Some move payloads survive as generic event text instead.
- [`Importer`](../server/importer.ts) already skips unchanged source revisions and replaces a session's messages/events in one transaction. This is the natural integration point for artifact extraction and replacement.

## Source findings

"Available" below means observed in the audited source format or specified by its inspected contract. It does not promise that older versions or every session populated the field. Source-specific execution parsing is a potential extension unless explicitly described as imported today.

| Source | Commit evidence | File evidence | Branch/repository/directory evidence |
| --- | --- | --- | --- |
| **OpenCode V2** | No created-commit collection in the inspected session API. Shell input/result, call ID, completion time, and shell result metadata can support extraction. | Imported `snapshot.files`, with start/end snapshot coverage, or successful edit tools when complete snapshots are absent. | Session `location.directory`, project canonical directory/sandboxes, and recorded `location-switched` messages. VCS endpoints expose location state, not historical session branch ownership. |
| **Claude Code** | Installed SDK declares structured `BashOutput.gitOperation.commit` with SHA, kind, and optional branch. This is an especially useful native path when producers persist it. Otherwise correlate Bash calls/results. | Imported successful Edit/Write/MultiEdit/NotebookEdit results. Raw `file-history-snapshot` records also exist, but their backup semantics need separate validation before using them as a changed-file list. | SDK session metadata has `gitBranch`; raw transcript envelopes have `cwd` and `gitBranch`. These fields can provide recorded observations, rather than a complete branch-switch ledger. |
| **Codex** | Optional `session_meta.payload.git.commit_hash` is a context/base commit, **not a created commit**. Completed command output can support operation extraction. | Imported successful `patch_apply_end`, completed FileChange items, and explicit moves. | Optional header `git.branch`/`repository_url`, `cwd`, and observed `runtime_workspace_roots`; turn contexts can record later `cwd`. Git header data is currently dropped. |
| **T3 Code V2** | Saved command items contain command input/output, status, native provider identity, and `exitCode`. Actual commit-success output was observed. Checkpoint refs are internal snapshots, not user commits. | Completed actual-path `file_change` items are imported. Separate checkpoint projections also contain `files[]` with path, kind, additions, and deletions; these are currently omitted. OpenCode tool labels such as `patch` are not paths. | Thread `branch`, `worktreePath`, project `workspace_root`; checkpoint scopes also record `cwd`. Branch and checkpoint scope metadata are currently omitted. Strong provider links permit additional native-source evidence. |
| **Hermes** | No dedicated created-commit relation found in the inspected sessions schema/adapter. Retained tool calls/results are candidates for source-specific extraction. | Current adapter does not normalize file changes; successful tool-result decoding would need additional work. | Native sessions table has `cwd`, `git_branch`, `git_repo_root`, and a Git metadata generation. Only `cwd` is currently imported. Git fields are mutable observations, not history. |
| **Cursor** | No normalized commit relation in current readers. Exported calls/results are incomplete and cannot establish a complete commit history. | Current reader intentionally supplies no verified file evidence; requests/attachments are insufficient. | Recorded cwd/workspace metadata, with conservative path matching. No verified native Git-branch history in the audited readers. |
| **GitHub Copilot CLI** | Correlated execution start/complete events offer a possible extraction path; no created-commit collection in our reader. | Explicit result `fileEdits[]` is already imported, including changes that succeeded within a partially failed operation. "Committed" here means applied file mutations, not Git commits. | Recorded session-start context cwd; other Git metadata needs format validation before promising support. |
| **GitHub Copilot Chat** | Saved tool invocations/results may permit extraction where full output and execution context survive. | Explicit accepted-edit events are imported. References, proposals, and undo events are not accepted changes. | Explicit working directory or a verified single-folder workspace. Multi-root/remote folders must not be guessed. |
| **Gemini / Qwen** | Correlated recorded tool executions can support extraction; no dedicated commit collection currently imported. | Successful matching edit results already imported. | Gemini project-root marker; Qwen recorded cwd. No verified Git-branch ledger in the audited readers. |
| **Pi and Pi-format sources** | Tool calls/results can support extraction where status and output are retained. | Pi-format parser extracts successful write/edit evidence, including when used by additional harness adapters. | Header cwd. Conversation-tree branches and `branch_summary` are **not Git branches**. |
| **Cline / Roo / Kilo extension** | Potential from structured calls/results; coverage is limited by retained API-conversation snapshots. | Matching successful edit tools where recorded. XML requests alone are insufficient. | Matching task/session metadata supplies workspace and explicit lineage. Checkpoint/branch semantics outside current readers need validation. |
| **Continue** | Potential from retained execution results; no dedicated commit index. | Current reader does not extract verified edits. | `workspaceDirectory`; no verified Git history in the current reader. |
| **Other conversation adapters** | No native commit index implemented. Validate each producer's execution/result format before enabling extraction. | Mostly message-oriented readers; do not infer support merely because tool text exists. | Selected cwd/working-directory/folder fields where explicitly available; missing paths remain unknown. |
| **Metadata-only / detection-only sources** | Insufficient evidence for session-created commits. | Insufficient change evidence. | Some expose native session/workspace identity; detection-only inputs create no sessions. |

The additional conversation adapters include Amp, Droid, Codebuff/Freebuff, Kimi, Grok, Jcode, Cherry Studio, Command Code, ZCode, CodeBuddy, WorkBuddy, Proma, DeepSeek Harness, Aside, Vibe, Goose, Zed, Devin, Crush, Octofriend, Kilo CLI, MiMo, Unsloth, Kiro, Mux, and captured MiniMax histories. OpenClaw varies by representation: the database reader is message-oriented, while its Pi-format export reader can extract successful edits. See [extended import coverage](import-coverage.md) for the complete registry and format limitations. These sources were reviewed at the adapter/format level, not all against live installations.

### Particularly useful data we currently discard

**T3 checkpoints.** The inspected SQLite schema has `orchestration_v2_projection_checkpoints`, linked by thread/scope/run/node, with status and capture time. Ready checkpoints with nonempty file lists were observed. `orchestration_v2_projection_checkpoint_scopes` supplies cwd. Checkpoint activity items carry `checkpointId`, `scopeId`, and files as well: consume one authoritative representation and deduplicate by checkpoint ID. Validate the interval/baseline before summing line changes. Empty lists on unavailable/missing checkpoints are not proof of no edits. Refs under `refs/t3/orchestration-v2/checkpoints/...` must remain a separate checkpoint category even when backed by Git commit objects.

**T3 commands.** The adapter currently preserves input/output but drops `exitCode` and, for ordinary commands, native call identity. Preserve both before extracting operations. The command projection can omit the provider's per-call cwd, so use scoped directory evidence or the linked provider record when necessary; do not blindly attach every operation to the thread's latest directory.

**Claude native Git results.** SDK `0.3.312` / Claude Code `2.1.312` declares:

```ts
gitOperation?: {
  commit?: { sha: string; kind: 'committed' | 'amended' | 'cherry-picked'; branch?: string };
  push?: { branch: string };
  branch?: { ref: string; action: 'merged' | 'rebased' };
  pr?: { number: number; url?: string; action: string };
}
```

The live SDK user-message envelope exposes `tool_use_result`; on-disk producers can use a different envelope spelling that must be checked. The narrower `getSessionMessages()` return type does not expose structured tool output or Git metadata. Our transcript loader already reads raw entries before using the SDK conversation-chain parser, so an enrichment pass can join retained entries to returned message UUIDs without flattening away those fields or including abandoned conversation branches accidentally. The small surviving local Claude sample confirmed `cwd`, `gitBranch`, and file-history records, **not an actual `gitOperation` result**. Treat Git-operation persistence as contract-supported and requiring a producer-specific fixture/live example before shipping.

**Codex metadata.** Sampled rollouts confirmed optional `git.commit_hash`, `git.branch`, and `git.repository_url`. Other sampled headers lacked Git metadata. Preserve them as observations attached to the header, with their recorded timing; never count the initial SHA as a session-created commit.

**Hermes Git fields.** The installed writer updates cwd and Git metadata together, with generation checks for asynchronous probes. It may retain a previous nonempty Git value when a same-cwd probe fails. Store this as the harness's recorded metadata observation, not an exact historical checkout event or current disk truth.

**OpenCode execution metadata.** The local API exposed completed shell `state.metadata.exit`, `status`, and `truncated`. Our generic timeline conversion retains content but drops this metadata. A completed tool envelope alone is insufficient to prove a successful Git command. The V2 API also exposes session snapshot diffs and durable logs; neither is a native list of commits created by a session. `revert/commit` applies a staged session revert, not a Git commit operation.

## Reliability rules

### Commits

Accept a created-commit link from a validated native operation result, or a correlated Git execution with a confirmed commit outcome and unambiguous repository context. Keep extraction provenance so users can inspect the evidence.

- Prefer native structured results. Fallback parsers should understand a small set of execution formats and actual command syntax, not search arbitrary prose for hexadecimal strings or `git commit`.
- A successful command request, "I committed it," a `git log` listing, an initial HEAD, or matching timestamps does not establish creation.
- Preserve full object IDs when available. Resolve abbreviated IDs only against the identified local repository and require an unambiguous commit object. Keep unresolved evidence explicit; do not invent the remaining hash.
- Optional read-only Git enrichment can fetch subject, parents, object format, and commit dates in batches after attribution. It validates/enriches the object; it does not establish which session created it. Do not fetch repositories or inspect every repository's full log per session.
- A shell command can create a commit and then fail during push/test. Conversely, `git commit ...; echo done` can return zero after commit failure. Overall exit status is not enough: attribute the specific operation. Background execution requires its eventual result.
- Distinguish creation, amendment, cherry-pick, merge/rebase effects, push, base/checkout observation, and reference. A pushed commit need not have been created in that session.
- Use recorded execution time for a graph action marker. Git author/committer dates are separate and may be rewritten or backdated.
- Exclude harness checkpoint refs from normal commit markers. Copied/inherited history in a fork does not mean the child created the parent's commits.

### Files

Accept actual source snapshots/file-change records and confirmed successful edit results. Preserve whether the evidence is a workspace delta or an agent tool mutation.

- A file read, mention, proposed patch, attachment, or tool name is not a change.
- Snapshot coverage can miss files excluded by the source, transient edits reverted within one interval, or changes outside its workspace. Edit tools can miss shell scripts, generators, formatters, and external changes. The union is useful, but still has a coverage boundary.
- Paths require source-specific resolution: snapshot-relative paths, per-call cwd, and session cwd are not interchangeable. Preserve original path and resolution base; do not resolve old relative paths against the session's latest directory.
- Keep rename source/destination and operation type when explicitly recorded. A filename is not a stable identity across renames.
- `steps` currently counts recorded evidence steps, not lines or unique tool invocations. Do not double-count matching snapshot and tool evidence. Snapshot line deltas over overlapping intervals cannot be summed as net session changes.

### Branches, repositories, and directories

Define "touched" explicitly rather than using one undifferentiated string list:

- Branch: `observed`, `created`, `checked_out`, `merged`, `rebased`, or `pushed`.
- Directory: `session_workspace`, `execution_cwd`, `workspace_move`, or `modified_file_parent`.
- Repository: observed native metadata or a verified local repository/worktree association.

Starting/last-recorded branch fields do not enumerate every intermediate branch. Working in a file's parent directory is different from running a command there. `cd` in a command may be subshell-local; `git -C`, explicit workdir, worktree moves, remote execution, and multi-repository commands need their own context. Worktree directory names must never be decoded into guessed branch names. Git's current branch and reflog alone cannot reconstruct session attribution.

## Proposed normalized model

Use ordinary relational links with `session_id` foreign keys, backed by a compact summary on the existing session object. The following are conceptual tables, not a migration:

| Record | Important fields |
| --- | --- |
| `repositories` | Local repository identity, object format, verified common Git directory when available; retain observed roots/aliases separately. Remote URL alone is not unique. |
| `commits` | Repository ID + full object ID; optional subject, parents, author/committer dates. |
| `session_commits` | Session ID, commit ID, relationship, recorded action time, evidence reference. |
| `session_files` | Session ID, repository/workspace scope, resolved or explicitly unresolved path, observed-change summary, evidence coverage. |
| `session_branches` | Session ID, repository/workspace scope, branch/ref, relationship, recorded observation/action time. |
| `session_locations` | Session ID, directory/worktree, relationship, recorded time and source order. |
| `session_checkpoints` | Session ID, native checkpoint ID/ref, scope/baseline, capture time/status; file deltas kept separate from Git commits. |
| `artifact_evidence` | Owning source/native session, native message/event/call/checkpoint ID, extraction version, status, evidence kind, time provenance, source revision. |
| `session_artifact_summary` | Indexed counts, per-category coverage, artifact revision, bounded marker summary if needed. |

Keep the action/evidence rows as well as unique artifact links: one commit can have multiple recorded operations or sources; multiple sessions may contribute to a file or refer to a commit. Do not use a global SHA or path alone to collapse repository/workspace identity. Unknown repository scope should remain distinct until a verified association exists.

Index by `(session_id, ...)`, by `(session_id, occurred_at)`, and by repository/object ID. A time-first marker index can support graph-wide date windows. Store `occurred_at = NULL` when absent; source order remains available without invented marker positions.

Per-category coverage should include support, extraction completion, revision/version, missing/truncated input, and the evidence scope. "Finished extracting observed edits" is not "proved that all filesystem edits were captured." Unknown is not zero; counts should mean **recorded/confirmed items**, with coverage attached. A single `capabilities.files` boolean or conversation `coverage.history` flag cannot express this.

### Import and invalidation

1. Read session-level metadata directly during discovery where available.
2. Extract native artifact facts from raw records while the adapter already reads history, before text/payload truncation discards structured fields. Bound artifact extraction independently and disclose limits.
3. Correlate tool requests/results across pages by native call identity and session scope. Do not rely on a one-message overlap for nonadjacent or parallel calls. Preserve source order and handle duplicate/inherited records explicitly.
4. Normalize and deduplicate facts, then atomically replace artifact links, evidence, summary, messages, events, and search invalidation in the existing snapshot transaction. Failed refreshes retain the previous saved artifact snapshot.
5. Track an artifact extractor version separately from source revision. An unchanged source still needs reprocessing after extractor changes. Include newly consumed checkpoint/metadata dependencies in revision calculation.
6. Backfill from saved structured events/files when sufficient. Fields already discarded, including native checkpoint lists and structured tool metadata, require source refresh. An unavailable source stays unavailable rather than becoming an empty list.
7. For T3, aggregate evidence from explicitly and unambiguously linked provider sessions. Retain original ownership and native call IDs, deduplicate mirrors, and invalidate the visible T3 summary when a linked provider revision changes. Ambiguous links must not merge unrelated evidence.

### Fast graph reads

- Keep the graph's session payload small: counts, coverage, revision, and optionally a small bounded marker preview. Do not attach every file path and full commit body to every session in the initial graph response.
- Fetch lightweight commit markers for visible session IDs/time windows in bounded batches. Include only IDs, session links, action times, and display data. Query normalized artifact indexes, never message JSON. Cache against artifact revision.
- Use clustering/level of detail and explicit result limits for large graphs; omitted markers must be distinguishable from missing source data. Untimed commits remain in the inspector instead of being placed at fabricated times.
- Lazy-load a selected session's full artifacts and evidence from the same indexes. Existing file-detail routes can retain their public shape while changing their backing query from message scans to indexed file summaries.
- Optional Git enrichment is cached by repository/object ID and occurs outside the rendering path. It should not delay showing already-confirmed session evidence.

## Other useful session-linked facts

Native session identity, explicit forks/children/provider bindings, recorded message times, tool calls/results and statuses, model/provider observations, and available token/cost totals can use the same provenance conventions. T3 also records linked/branch PR references, and Claude's SDK declares PR operations. A linked PR is an association; an explicit created/merged operation is an action. Token usage, model metadata, and lineage still have source-specific coverage, and T3/provider mirrors must not double-count them.

## Recommended order

1. Materialize currently imported file/tool evidence and add per-category coverage. Preserve OpenCode directory moves and the verified branch/repository metadata from Claude, Codex, T3, and Hermes.
2. Add T3 ready-checkpoint file evidence, preserving scope/baseline and keeping internal checkpoints distinct from commits.
3. Add commit evidence extraction: validated Claude native results when present, then conservative OpenCode/T3/Codex execution parsers with repository context and success checks.
4. Render lightweight commit markers and indexed artifact details. Expand other sources only as their native result formats are verified.

Meaningful implementation checks should cover failed/dry-run/multi-command commits, successful commit followed by failed push, short-hash ambiguity, internal checkpoints, branch moves, relative paths across workspaces, fork-inherited history, duplicate T3/provider evidence, page-boundary correlation, unavailable sources, truncation, and atomic replacement. Verify graph reads do not query `messages` or parse timeline payloads after indexing.

## Evidence and scope of this audit

- Reviewed all registered adapter families, current storage/import code, timeline indexes, and the file-detail loading path.
- Inspected T3 and Hermes native schemas through private read-only SQLite copies, including T3 ready checkpoint file shapes and successful/failed command result shapes.
- Inspected bounded local Codex and Claude transcript samples. Some saved transcript paths no longer existed; the surviving Claude sample was small. These samples establish field presence, not population-wide completeness.
- Used OpenCode's authenticated loopback GET API for its live OpenAPI schema, session/message shapes, shell result metadata, and snapshot shapes. No OpenCode database access or agent execution was used. Public contract: [OpenCode V2 API](https://opencode.ai/v2/docs/api).
- Inspected the installed Claude SDK's `sdk-tools.d.ts` (`BashOutput.gitOperation`), `sdk.d.ts` (`SDKSessionInfo`, `SDKUserMessage`, `SessionMessage`), and installed Hermes metadata writer semantics.
- Diagnostics and local field-shape reports are in ignored `tmp/audit-session-evidence*`. The investigation did not import into or rewrite the persistent SessionGraph library. No runtime behavior or artifact index was implemented.

</details>
