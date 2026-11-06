# History importer comparison

Reviewed November 6, 2026. These are source-code comparisons, not claims that another project's entire importer is correct. References are pinned so later upstream changes do not alter the evidence.

## CASS / Franken Agent Detection

[CASS](https://github.com/Dicklesworthstone/coding_agent_session_search/tree/298f51895585ab086d8b129b9a475a3b26609407) delegates its core connectors to [Franken Agent Detection at `6b337ba`](https://github.com/Dicklesworthstone/franken_agent_detection/tree/6b337ba434b72c65c6c5a748b7ec47885f840ac0), pinned in CASS's Cargo manifest.

- Its [Codex connector](https://github.com/Dicklesworthstone/franken_agent_detection/blob/6b337ba434b72c65c6c5a748b7ec47885f840ac0/src/connectors/codex.rs#L987-L1004) skips injected-context user records when deriving a title. It also tests mirrored `event_msg` / `response_item` prompts so they do not become duplicate messages.
- Its [Cursor connector](https://github.com/Dicklesworthstone/franken_agent_detection/blob/6b337ba434b72c65c6c5a748b7ec47885f840ac0/src/connectors/cursor.rs#L495-L504) excludes NULL-valued Composer marker rows explicitly. A marker is not a corrupt conversation. It deduplicates native session IDs across database representations.
- Its [Hermes connector](https://github.com/Dicklesworthstone/franken_agent_detection/blob/6b337ba434b72c65c6c5a748b7ec47885f840ac0/src/connectors/hermes.rs#L246-L284) reads message content as text rather than guessing JSON from punctuation.

**Applied here:** source-specific title normalization, NULL-marker filtering, and native-identity deduplication. Our raw histories remain separate from the map's grouping, and unchanged parser revisions are invalidated when decoding changes.

## Agent Sessions

[Agent Sessions at `555fbfd`](https://github.com/jazzyalex/agent-sessions/tree/555fbfddaa286b63cdef2ef13db88cb9cf320d87) is a comparable local history browser.

- Its [title selection](https://github.com/jazzyalex/agent-sessions/blob/555fbfddaa286b63cdef2ef13db88cb9cf320d87/AgentSessions/Model/Session.swift#L666-L740) prioritizes custom titles and filters harness preambles before falling back to other text.
- Its [Cursor parser](https://github.com/jazzyalex/agent-sessions/blob/555fbfddaa286b63cdef2ef13db88cb9cf320d87/AgentSessions/Services/CursorSessionParser.swift#L48-L58) recognizes error-only `turn_ended` records. Its user-query tag removal does not cover every attachment/web-context envelope encountered in our audit.
- Some of its preamble checks search for phrases anywhere in a message. Those heuristics can also match a legitimate request quoting a prompt or XML example.

**Applied here:** retain native Codex names before prompt fallbacks, preserve Cursor lifecycle errors, and normalize only recognized leading context. Strip context before payload truncation so a long injected preamble cannot consume the real prompt's entire budget. Keep literal markup inside user queries intact. Context-only blocks remain source events rather than user-message dots.

## Hermes's native writer is the content-format authority

Hermes [encodes and decodes structured content](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/hermes_state_messages.py#L139-L169) using a reserved NUL + `json:` prefix. Ordinary strings are unchanged, even if they are valid JSON. Literal strings starting with the reserved prefix are JSON-string-escaped. Malformed marked content falls back to its original text.

**Applied here:** follow that contract exactly. Do not parse `[IMPORTANT: ...]`, JSON followed by prose, or a literal JSON example as structured conversation blocks. This fixes whole-session rejection without discarding the offending message. Empty native sessions are reported separately from unreadable histories.

## Tokscale

[Tokscale at `82613d2`](https://github.com/junhoyeo/tokscale/tree/82613d2f5e96654ce3729892afbb0025979f1c75) remains useful for format discovery, native IDs, and archived rollout coverage. Its [Codex parser](https://github.com/junhoyeo/tokscale/blob/82613d2f5e96654ce3729892afbb0025979f1c75/crates/tokscale-core/src/sessions/codex.rs) derives deduplication identity from in-file session metadata. Its [Hermes parser](https://github.com/junhoyeo/tokscale/blob/82613d2f5e96654ce3729892afbb0025979f1c75/crates/tokscale-core/src/sessions/hermes.rs#L1-L19) primarily reconstructs usage from session aggregates and logged API calls.

**Boundary:** usage aggregates and billing deduplication are not conversation reconstruction. SessionGraph imports recorded messages and times rather than manufacturing turns or allocating aggregate usage to prompts.

## T3 / provider overlap

The inspected connectors do not establish a reusable T3-to-provider ownership rule. SessionGraph uses T3's explicit, strong provider bindings. Matching titles, timestamps, or similar messages never establish identity.

- A uniquely bound T3 thread with imported user messages occupies one map entry, even when attachment or payload omissions make it partial.
- The inspector offers the separately saved provider history. Grouping does not overwrite, append, or merge the two transcripts, and partial coverage remains visible.
- Empty or pending T3 histories do not hide native sessions. All binding claimants count when checking ambiguity, including pending or partial ones.
- Snapshot changes during T3 discovery get up to three fresh-copy attempts. Only the consistency-race error is retried; schema errors still surface. Paged reads remain pinned to one verified snapshot.

## Remaining format boundaries

Attachments and checkpoint snapshots are still not imported by T3. Cursor Composer values above the existing 32 MB limit are still bounded and reported; NULL markers are excluded from that warning. Native histories that are genuinely empty cannot supply conversation messages. Live validation covers installed sources; fixture tests cover parser families for unavailable harnesses.
