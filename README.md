# 20x

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.0.12-blue.svg)](./package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](.)

**Your tasks. AI agents. One app.**

20x is a desktop app that turns your task list into an AI-powered workforce. Connect your tools — Linear, HubSpot, Peakflo — assign tasks to AI agents, and watch them work in real time.

**No cloud. No subscriptions. Everything runs on your machine.**

## Why 20x?

Most AI tools make you copy-paste context between tabs. 20x flips it: **your tasks come to the agents, not the other way around.**

- Pull a task from Linear → AI agent picks it up, reads the context, writes the code, opens a PR
- Got a backlog of tickets? → Queue them up, agents work through them while you review
- Need human approval? → Agents pause and ask before doing anything risky

## How It Works

```
Your tools          20x              AI Agents
┌──────────┐    ┌──────────┐    ┌──────────────┐
│  Linear   │───>│          │───>│  Claude Code  │
│  HubSpot  │───>│  20x     │───>│  OpenCode     │
│  Peakflo  │───>│          │───>│  Codex        │
└──────────┘    └──────────┘    └──────────────┘
```

1. **Tasks flow in** — from integrations or created manually
2. **You assign an agent** — choose Claude Code, OpenCode, or Codex
3. **Agent works the task** — with live streaming output
4. **You stay in control** — approve, review, merge

## Features

### 🤖 Multi-Agent Support
- **Claude Code** — Anthropic's official agent SDK
- **OpenCode** — Open-source coding agent
- **Codex** — Zed Industries' agent framework
- **Live transcripts** — Watch agents think and work in real time
- **Human-in-the-loop** — Approve risky actions before execution

### 🔗 Smart Integrations
- **Linear** — Pull issues, update status, post comments
- **HubSpot** — Sync tickets and workflows
- **Peakflo** — Connect your Peakflo tasks
- **OAuth built-in** — Secure authentication flows

### 🧠 Skills System
- **Reusable instructions** — Create skill templates for common patterns
- **Auto-learning** — Agents update skills based on feedback
- **Confidence tracking** — Skills improve over time

### 🛠 Developer-First
- **Git worktree management** — Isolated branches per task
- **Repository context** — Agents know which repos to work on
- **MCP servers** — Connect Model Context Protocol tools
- **Local-first** — SQLite database, no cloud required

### 📋 Task Management
- **Recurring tasks** — Daily, weekly, monthly schedules
- **Rich metadata** — Types, priorities, due dates, labels
- **File attachments** — Add context files to tasks
- **Output fields** — Structured task results
- **Smart search** — Find anything fast

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **pnpm** >= 9
- **Git** (for worktree features)
- **GitHub CLI** (optional, for repo features)

### Installation

```bash
# Clone the repository
git clone https://github.com/peakflo/pf-desktop.git
cd pf-desktop

# Install dependencies
pnpm install
```

### Configuration

**API Keys:**
Configure in Agent Settings:
- Anthropic API key for Claude Code
- OpenAI API key for OpenCode (if needed)

**Database:**
- Stored at `~/.workflo/database.db`
- Automatic backups before migrations

**Integrations:**

See [TASK_SOURCES.md](./TASK_SOURCES.md) for detailed setup instructions.

Quick setup:
1. **Open Settings** → **Integrations** → **Add Source**
2. **Choose plugin** (Linear, HubSpot, or Peakflo)
3. **Configure credentials**:
   - **Linear**: Create OAuth app, use redirect URI `nuanu://oauth/callback`
   - **HubSpot**: OAuth app or Private App token
   - **Peakflo**: API key from Settings
4. **Complete authentication** and sync tasks

### Development

```bash
# Start dev server
pnpm run dev

# Run tests
pnpm test

# Build for distribution
pnpm run build:mac    # macOS
pnpm run build:win    # Windows
pnpm run build:linux  # Linux
```

## Architecture

### Data Flow

```
React UI → Zustand Store → IPC Client → Preload Bridge → Main Process → SQLite
```

- **Renderer** — React 19 + Tailwind CSS 4 + Zustand 5
- **Main Process** — Electron 34 + SQLite + Agent orchestration
- **Security** — Full context isolation, no Node.js in renderer

### Agent Architecture

```
┌─────────────────────────────────────────────────┐
│              Agent Manager                       │
│  ┌──────────────────────────────────────────┐   │
│  │   getAdapter(agent.config.coding_agent)  │   │
│  └────────────────┬─────────────────────────┘   │
│                   │                             │
│       ┌───────────┼───────────┐                 │
│       ▼           ▼           ▼                 │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │OpenCode │ │  Claude │ │  Codex  │           │
│  │ Adapter │ │  Adapter│ │ Adapter │           │
│  └─────────┘ └─────────┘ └─────────┘           │
└─────────────────────────────────────────────────┘
```

**Session Lifecycle:**
1. **Start** — Agent assigned, skills applied, session created
2. **Streaming** — Real-time output sent to UI
3. **Approval** — Agent pauses for human decisions
4. **Completion** — Results saved, task updated

See [AGENTS.md](./AGENTS.md) for detailed architecture.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Shell | Electron 34 |
| Build | electron-vite |
| Frontend | React 19 + Tailwind CSS 4 + Zustand 5 |
| UI Components | Radix UI primitives |
| Styling | cva + Tailwind CSS tokens |
| Icons | Lucide React |
| Font | Geist |
| Database | SQLite (better-sqlite3, WAL mode) |
| Agent SDKs | @opencode-ai/sdk, @anthropic-ai/claude-agent-sdk, @zed-industries/codex-acp |
| Testing | Vitest + happy-dom |

## Contributing

We welcome contributions! Here's how:

1. **Fork** the repo
2. **Create a branch**: `git checkout -b feature/my-feature`
3. **Write code**: Follow TypeScript strict mode, ESLint, Prettier
4. **Add tests**: Vitest tests for new features
5. **Commit**: Use conventional commits (`feat:`, `fix:`, etc.)
6. **Push**: `git push origin feature/my-feature`
7. **Open PR**: Describe changes, ensure CI passes

### Code Style
- TypeScript strict mode
- Minimal Tailwind classes (prefer CSS variables)
- Use `pnpm` (not npm)
- Check `MEMORY.md` for project patterns

## Community

- **Issues**: [GitHub Issues](https://github.com/peakflo/pf-desktop/issues)
- **Discord**: https://discord.gg/bPgkmycM

## Security

### Local-First
- All data stored locally in SQLite
- No cloud sync, no subscriptions
- Optional database encryption

### OAuth & API Keys
- Tokens encrypted with Electron `safeStorage`
- Keys never exposed to renderer process
- Parameterized SQL queries only

### Electron Security
- `contextIsolation: true`
- `nodeIntegration: false`
- External links open in system browser

## Roadmap

### Planned
- Additional integrations (Jira, Asana, GitHub Issues, Notion)
- Team collaboration (shared task sources)
- Cost tracking (token usage per session)
- Agent templates (pre-configured profiles)
- Plugin marketplace (community skills)
- Desktop notifications
- Light theme

### Recently Shipped
- ✅ Multi-agent support (OpenCode, Claude Code, Codex)
- ✅ Skills system with auto-learning
- ✅ Recurring tasks
- ✅ Linear, HubSpot, Peakflo integrations
- ✅ MCP server management
- ✅ Git worktree management

## License

[MIT](./LICENSE) © 2025 Peakflo

---

Built with [Electron](https://electronjs.org), [React](https://react.dev), and [Anthropic Claude](https://anthropic.com).
