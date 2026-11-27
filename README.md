<h1 align="center">
  <img src="public/brand/lockup.svg#gh-dark-mode-only" width="420" alt="SessionGraph">
  <img src="public/brand/lockup-light.svg#gh-light-mode-only" width="420" alt="SessionGraph">
</h1>
<p align="center">Explore &amp; visualize all your LLM sessions</p>
<p align="center">
  <a href="https://github.com/arvindell/sessiongraph/releases/latest">Download</a> ·
  <a href="docs/guide.md">Documentation</a> ·
  <a href="PRIVACY.md">Privacy</a> ·
  <a href="docs/releases.md">Releases</a>
</p>

[![SessionGraph in action: zoom, playback, messages, search, and twelve sources using synthetic sessions](docs/sessiongraph-demo.gif)](https://github.com/arvindell/sessiongraph/releases/latest/download/sessiongraph-demo.mp4)

Explore local history from **OpenCode, Claude Code, Codex, T3 Code, Cursor, Gemini, Pi, and more** in one app. Search conversations, browse messages, and inspect changed files.

- **Session orbs** show your conversations over time.
- **Fork connections** show where sessions branched or spawned subagents.
- **Clusters** group sessions by project directory, even across harnesses.

### Your history stays local

**No account needed.** SessionGraph reads your local history without changing it. Imported conversations and search stay on your computer.

### Install

Run the desktop app with **Node.js 24+**:

```sh
npx sessiongraph
```

Prefer your browser? Run `npx sessiongraph --browser`.

Or download an installer — no Node.js required:

| Platform | Direct downloads |
| --- | --- |
| macOS · Apple Silicon | [DMG](https://github.com/arvindell/sessiongraph/releases/latest/download/sessiongraph-darwin-arm64.dmg) |
| macOS · Intel | [DMG](https://github.com/arvindell/sessiongraph/releases/latest/download/sessiongraph-darwin-x64.dmg) |
| Windows · x64 | [EXE](https://github.com/arvindell/sessiongraph/releases/latest/download/sessiongraph-win32-x64.exe) · [MSI](https://github.com/arvindell/sessiongraph/releases/latest/download/sessiongraph-win32-x64.msi) |
| Linux · x64 | [AppImage](https://github.com/arvindell/sessiongraph/releases/latest/download/sessiongraph-linux-x64.AppImage) · [DEB](https://github.com/arvindell/sessiongraph/releases/latest/download/sessiongraph-linux-x64.deb) · [RPM](https://github.com/arvindell/sessiongraph/releases/latest/download/sessiongraph-linux-x64.rpm) |
| Linux · ARM64 | [AppImage](https://github.com/arvindell/sessiongraph/releases/latest/download/sessiongraph-linux-arm64.AppImage) · [DEB](https://github.com/arvindell/sessiongraph/releases/latest/download/sessiongraph-linux-arm64.deb) · [RPM](https://github.com/arvindell/sessiongraph/releases/latest/download/sessiongraph-linux-arm64.rpm) |

### Harness support

| Harness | Local history |
| --- | --- |
| <img src="public/sources/opencode.svg" width="14" alt=""/> **OpenCode** | Run OpenCode when importing |
| <img src="public/sources/claude.svg" width="14" alt=""/> **Claude Code** | Projects, worktrees, and subagents |
| <img src="public/sources/openai.svg" width="14" alt=""/> **Codex** | Active and archived sessions |
| <img src="public/sources/t3.svg" width="14" alt=""/> **T3 Code** | Threads and activity |
| <img src="public/sources/cursor.svg" width="14" alt=""/> **Cursor** | IDE and CLI conversations |
| <img src="public/sources/gemini.svg" width="14" alt=""/> **Gemini CLI** | Saved chats |
| <img src="public/sources/qwen.svg" width="14" alt=""/> **Qwen Code** | Project chats |
| <img src="public/sources/pi.svg" width="14" alt=""/> **Pi** | Session trees |
| <img src="public/sources/copilot.svg" width="14" alt=""/> **GitHub Copilot CLI** | Saved sessions |
| <img src="public/sources/copilot.svg" width="14" alt=""/> **GitHub Copilot Chat (VS Code)** | Saved IDE chats |
| <img src="public/sources/cline.svg" width="14" alt=""/> **Cline** | Tasks and messages |
| <img src="public/sources/roo.svg" width="14" alt=""/> **Roo Code** | Task history |
| <img src="public/sources/kilo.svg" width="14" alt=""/> **Kilo Code / CLI** | Extension and CLI sessions |
| <img src="public/sources/continue.svg" width="14" alt=""/> **Continue** | IDE and CLI sessions |

Also supports OpenClaw, Hermes, Kiro, Mux, and more. [Full source list and coverage →](docs/import-coverage.md)

### Develop

```sh
pnpm install
portless sessiongraph pnpm dev
```

`pnpm desktop:dev` runs the native app. `pnpm test` runs the tests.

### License

[MIT](LICENSE) © 2026 Alex Vilchis.
