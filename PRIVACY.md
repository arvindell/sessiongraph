# Privacy and local data

**Your session history stays on your device.** Import, search, and visualization run locally, without an account, automatic cloud sync, or app telemetry. Imports read selected sources without modifying them or starting an agent. The [privacy policy](https://sessiongraph.ai/privacy) covers the website and optional publishing.

## What a public graph shares

GitHub sign-in alone does not publish anything. SessionGraph builds the preview locally and uploads only the metadata snapshot for the sessions you select, after you confirm. Subsequent imports do not update it. You can inspect the exact JSON before sharing.

- **Always included:** graph-specific numeric session IDs and groups, and recorded parent or fork links within the selection.
- **Optional:** token counts, session and message timestamps, message counts, recognized model names, and coding-tool names. Disabled fields are omitted.
- **Never included:** conversation text, code, tool inputs or outputs, project or session names, file paths, native session IDs, credentials, or costs.

Anyone can view a published graph at `/@<github_username>` or find it in **Explore graphs**. Anonymous session labels do not anonymize your profile; timestamps and activity can reveal work patterns. The site stores the latest confirmed snapshot. **Unpublish** in the app or on the [account page](https://sessiongraph.ai/account) removes the hosted copy, not copies others already saved. Signing out does not unpublish.

## Local files and network access

The SQLite library stores imported sessions, search data, and preferences on your device. See the [storage guide](docs/guide.md#local-storage-and-privacy) for paths and overrides. Handoff files and optional desktop login credentials also stay on your device. SessionGraph does not encrypt these files; use OS permissions and disk encryption as needed.

Desktop updates contact GitHub, and npm installs contact the npm registry. Those requests do not include session history. The hosted service handles optional GitHub sign-in, publishing, and organization features. Organizations do not share your local history. If you explicitly continue a conversation in another coding tool, that tool may send the handoff context to its model provider under its own settings.

To check local behavior, disconnect from the internet and browse or search an already imported library. You can also inspect the [source adapters](server/adapters/), [local API](server/standalone.ts), and [public graph format](packages/core/src/public-graph.ts).
