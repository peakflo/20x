<p align="center">
  <img src="resources/icon.png" alt="20x Logo" width="120" />
</p>

# 20x

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/github/package-json/v/peakflo/20x)](./package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](.)
[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/fUVsqTWDxX)

**One app. All your tasks. Powered by AI agents.**

20x is a desktop app that turns your task list into an AI-powered workforce. Connect your tools — Linear, HubSpot, YouTrack, GitLab, Notion, Peakflo — assign tasks to AI agents, and watch them work in real time.

**No cloud. No subscriptions. Everything runs on your machine.**

<p align="center">
  <img src="resources/product-demo.gif" alt="20x product demo" />
</p>

## Why 20x?

Most AI tools make you copy-paste context between tabs. 20x flips it: **your tasks come to the agents, not the other way around.**

- Pull a task from Linear → AI agent picks it up, reads the context, writes the code, opens a PR
- Got a backlog of tickets? → Queue them up, agents work through them while you review
- Need human approval? → Agents pause and ask before doing anything risky

## How It Works

<p align="center">
  <img src="resources/process.png" alt="20x process: Hubspot, YouTrack, Linear, Github issues, Peakflo Workflo → triage agent → Agent (Claude Code, Opencode, OpenAI Codex) → HITL review → Feedback" />
</p>

1. **Tasks flow in** — from Linear, YouTrack, HubSpot, GitHub Issues, Notion, Peakflo Workflo, or created manually
2. **Triage agent** — Assigns priority, coding agent (Claude Code, OpenCode, or Codex), relevant skills, and git repos
3. **Agent works the task** — reads skills, git worktrees, and MCP servers; streams output in real time
4. **HITL review** — Agents pause for human approval before risky actions
5. **Feedback loop** — Skills and confidence levels are automatically updated after completion

## Features

<p align="center">
  <img src="resources/integrations.png" alt="20x integrations: Hubspot, YouTrack, Linear, Github issues, Peakflo Workflo → 20x ↔ GitLab, Github, MCP → Claude Code, Opencode, OpenAI Codex; Skills automatically improved" />
</p>

### 📊 Dashboard Workspace
- **Overview dashboard** — See task completion stats, AI autonomy metrics, and agent success rates at a glance
- **Kanban task board** — Tasks grouped by status with drag-and-drop support
- **Workflow applications** — Launch and manage workflow apps directly from the dashboard
- **Presetup wizard** — Guided templates to get started quickly with new applications

### 🤖 Multi-Agent Support
- **Claude Code** — Anthropic's official agent SDK (Claude Sonnet 4.6)
- **OpenCode** — Open-source coding agent
- **Codex** — OpenAI's agent framework (GPT-5.4)
- **Live transcripts** — Watch agents think and work in real time with message counts
- **Human-in-the-loop** — Approve risky actions before execution
- **Task progress tracking** — Real-time progress events during agent execution

### 🔗 Smart Integrations
- **Linear** — Pull issues, update status, post comments
- **HubSpot** — Sync tickets and workflows
- **YouTrack** — Connect JetBrains YouTrack projects and tasks
- **GitLab** — Full GitLab integration for task sourcing and repositories
- **Notion** — Sync Notion databases with full property and attachment support
- **Peakflo** — Connect your Peakflo Workflo tasks
- **GitHub Issues** — Pull issues directly from GitHub repositories
- **OAuth built-in** — Secure authentication flows

### 🧠 Skills System
- **Reusable instructions** — Create skill templates for common patterns
- **Auto-learning** — Agents update skills based on feedback
- **Confidence tracking** — Skills improve over time
- **2-way sync** — Skills synchronize bidirectionally between 20x and Workflo
- **Searchable skills** — Quickly find skills with built-in search

### 🛠 Developer-First
- **Git worktree management** — Isolated branches per task
- **Repository context** — Agents know which repos to work on (GitHub & GitLab)
- **MCP servers** — Connect Model Context Protocol tools with auto-registration
- **Local-first** — SQLite database, no cloud required

### 📋 Task Management
- **Subtasks** — Break tasks into subtasks with ordering and drag-and-drop reordering
- **Recurring tasks** — Daily, weekly, monthly schedules
- **Task snoozing** — Snooze tasks and have them resurface at the right time
- **Rich metadata** — Types, priorities, due dates, labels
- **File attachments** — Add context files to tasks
- **Output fields** — Structured task results
- **Smart search** — Find anything fast

### 💓 Heartbeat Monitoring
- **Enterprise heartbeat** — Continuous health checks with GitHub preflight
- **CI failure detection** — Automatically detect CI pipeline failures
- **State syncing** — Keep task state in sync across sessions

## Getting Started

### Supported Platforms

- **macOS** — Full support
- **Windows** — Full support
- **Linux** — AppImage installer

### Prerequisites

- **Node.js** >= 22
- **pnpm** >= 9
- **Git** (for worktree features)
- **GitHub CLI** (optional, for GitHub repo features)
- **GitLab CLI** (optional, for GitLab repo features)

### Installation

```bash
# Clone the repository
git clone https://github.com/peakflo/20x.git
cd 20x

# Install dependencies
pnpm install
```

### macOS: Signed & Notarized Releases

Release artifacts are signed with an Apple Developer ID certificate and notarized to avoid Gatekeeper install/open warnings.

For maintainers, setup details are in [docs/macos-signing-notarization.md](./docs/macos-signing-notarization.md).

### Configuration

**API Keys:**
Configure in Agent Settings:
- Anthropic API key for Claude Code
- OpenAI API key for OpenCode (if needed)

**Database:**
- Stored at `~/Library/Application Support/pf-desktop/pf-desktop.db` (macOS)
- Automatic backups before migrations

**Integrations:**
1. Get OAuth credentials from Linear/HubSpot/Peakflo
2. Configure in Integrations settings
3. Complete OAuth flow in-app

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

- **Issues**: [GitHub Issues](https://github.com/peakflo/20x/issues)
- **Discord**: https://discord.gg/fUVsqTWDxX

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
- Additional integrations (Jira, Asana)
- Team collaboration (shared task sources)
- Cost tracking (token usage per session)
- Agent templates (pre-configured profiles)
- Plugin marketplace (community skills)
- Light theme

### Recently Shipped
- ✅ Dashboard workspace with Kanban board and workflow apps
- ✅ Subtask support with ordering and drag-and-drop
- ✅ GitLab integration (task sourcing & repositories)
- ✅ YouTrack integration
- ✅ Notion integration with full property support
- ✅ GitHub Issues integration
- ✅ Windows and Linux platform support
- ✅ Task snoozing
- ✅ Skills 2-way sync with Workflo
- ✅ Heartbeat monitoring with CI failure detection
- ✅ Presetup wizard and dashboard templates
- ✅ Claude Sonnet 4.6 and GPT-5.4 model support
- ✅ Multi-agent support (OpenCode, Claude Code, Codex)
- ✅ Skills system with auto-learning
- ✅ Recurring tasks
- ✅ Linear, HubSpot, Peakflo integrations
- ✅ MCP server management
- ✅ Git worktree management

## License

[MIT](./LICENSE) © 2026 Peakflo

---

Built with [Electron](https://electronjs.org), [React](https://react.dev), and [Anthropic Claude](https://anthropic.com).
