# Workflo Workspace

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.0.12-blue.svg)](./package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](.)

AI-powered task management for developers. Local-first, agent-driven, extensible.

Workflo Workspace is a desktop application that combines powerful task management with AI coding agents. Manage tasks locally in SQLite, assign them to AI agents (OpenCode, Claude Code, Codex), monitor streaming transcripts, and integrate with external platforms like Linear, HubSpot, and Peakflo.

## Features

### Core Task Management
- **Local-first SQLite storage** — All data stored on your machine with WAL mode for performance
- **Rich task model** — Types (coding, review, approval, manual, general), priorities, statuses, due dates, labels
- **File attachments** — Attach files directly to tasks for context
- **Custom output fields** — Define structured outputs (text, select, multi-select) for task results
- **Recurring tasks** — Flexible scheduling patterns (daily, weekly, monthly) with automatic instance creation
- **Smart features** — Snooze tasks with preset/custom times, overdue notifications, full-text search

### AI Agent System
- **Multi-backend support** — OpenCode, Claude Code, and Codex agents via adapter pattern
- **Streaming transcripts** — Real-time agent output in dedicated panels
- **Human-in-the-loop** — Review and approve agent actions before execution
- **Session management** — Start, monitor, and control agent sessions per task
- **Agent-specific MCP tools** — Configure which MCP tools each agent can access

### Skills System
- **Reusable instructions** — Create skill templates with system prompts and context
- **Confidence-based ranking** — Skills track usage and success metrics
- **Task assignment** — Attach skills to tasks for consistent agent behavior
- **Version control** — Skills maintain version history for rollbacks

### Integrations
- **Linear** — Bidirectional sync with Linear issues, OAuth authentication
- **HubSpot** — Sync tasks with HubSpot tickets and workflows
- **Peakflo** — Integration with Peakflo task management
- **OAuth flows** — Built-in OAuth client for secure integration authentication

### Developer Tools
- **Git worktree management** — Manage repository worktrees for isolated development
- **Repository selection** — Attach git repos to tasks for context-aware agents
- **GitHub CLI integration** — Leverage `gh` CLI for repository operations

### MCP Servers
- **Local & remote MCP servers** — Connect to Model Context Protocol servers
- **Per-agent tool filtering** — Control which tools each agent can use
- **Tool introspection** — Discover available tools from connected servers
- **Environment management** — Configure environment variables per MCP server

## Screenshots

> _Coming soon: Main task list, agent transcript panel, skills editor, agent settings, integration setup_

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Shell | Electron 34 |
| Build | electron-vite |
| Frontend | React 19 + Tailwind CSS 4 + Zustand 5 |
| UI Components | Radix UI (Dialog, Select, Checkbox, Switch, Tabs) |
| Styling | class-variance-authority + Tailwind CSS variable tokens |
| Icons | Lucide React |
| Font | Geist (CDN) |
| Database | SQLite via better-sqlite3 (WAL mode) |
| IDs | @paralleldrive/cuid2 |
| Agent SDKs | @opencode-ai/sdk, @anthropic-ai/claude-agent-sdk, @zed-industries/codex-acp |
| Integrations | @hubspot/api-client, Linear SDK |
| Testing | Vitest + happy-dom |

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **pnpm** >= 9
- **Git** (for worktree features)
- **GitHub CLI** (optional, for repository features)

### Installation

```bash
# Clone the repository
git clone https://github.com/peakflo/pf-desktop.git
cd pf-desktop

# Install dependencies
pnpm install
```

> **Note:** Native modules (better-sqlite3) are automatically rebuilt via the postinstall script.

### Configuration

**Database Location:**
- SQLite database stored at: `~/.workflo/database.db`

**API Keys:**
Configure agent API keys in the Agent Settings panel:
- Anthropic API key for Claude Code agents
- OpenAI API key for OpenCode agents (if needed)

**OAuth Setup:**
For integrations (Linear, HubSpot, Peakflo):
1. Obtain OAuth client ID/secret from each platform
2. Configure in the Integrations settings panel
3. Complete OAuth flow via in-app browser

### Development

```bash
pnpm run dev
```

Opens the Electron window with hot-reload:
- **Renderer process**: Vite HMR (instant UI updates)
- **Main process**: Automatic restart on file changes

### Build

```bash
# Build the application
pnpm run build

# Package for distribution
pnpm run build:mac    # macOS (dmg, zip)
pnpm run build:win    # Windows (nsis)
pnpm run build:linux  # Linux (AppImage)
```

Packaged apps are output to `dist/`.

### Testing

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:run

# Test specific project
pnpm test:main      # Main process tests
pnpm test:renderer  # Renderer process tests
```

## Architecture

### Data Flow

```
React UI → Zustand Store → IPC Client → Preload Bridge → Main Process → SQLite
```

- **Renderer** (React) never touches Node.js APIs directly
- **Preload** exposes a minimal, typed API surface via `contextBridge`
- **Main process** owns the database and handles all IPC calls
- **Zustand** stores hold UI state and task data, calling IPC through a typed client wrapper

### Agent Architecture

The agent system uses an **adapter pattern** to support multiple backends:

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
1. **Start** — Agent assigned to task, session created with skills applied
2. **Streaming** — Real-time transcript output sent to UI
3. **HITL** — Agent requests approval for actions (file writes, shell commands)
4. **Completion** — Session ends, task updated with results

See [AGENTS.md](./AGENTS.md) for detailed agent architecture.

### Security Model

- `contextIsolation: true` — Renderer cannot access Node.js globals
- `nodeIntegration: false` — No `require()` in renderer
- `sandbox: false` — Required for better-sqlite3 native module in main process (renderer is still fully isolated)
- All external links open in the system browser (`setWindowOpenHandler`)
- Database writes use parameterized queries exclusively
- Dynamic column names in `UPDATE` validated against compile-time whitelist

### Task Data Model

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | cuid2 |
| `title` | string | Required |
| `description` | string | Markdown-compatible |
| `type` | enum | `coding`, `manual`, `review`, `approval`, `general` |
| `priority` | enum | `critical`, `high`, `medium`, `low` |
| `status` | enum | `inbox`, `accepted`, `in_progress`, `pending_review`, `completed`, `cancelled` |
| `assignee` | string | Free text |
| `due_date` | string \| null | ISO 8601 |
| `labels` | string[] | Stored as JSON |
| `attachments` | FileAttachmentRecord[] | Files with metadata |
| `repos` | string[] | Git repository paths |
| `output_fields` | OutputFieldRecord[] | Structured task outputs |
| `agent_id` | string \| null | Assigned agent |
| `session_id` | string \| null | Active agent session |
| `skill_ids` | string[] \| null | Applied skills |
| `external_id` | string \| null | Integration source ID |
| `source_id` | string \| null | Task source configuration ID |
| `source` | string | `local`, `linear`, `hubspot`, `peakflo` |
| `snoozed_until` | string \| null | Snooze timestamp |
| `resolution` | string \| null | Completion notes |
| `is_recurring` | boolean | Recurring task flag |
| `recurrence_pattern` | RecurrencePatternRecord \| null | Schedule pattern |
| `recurrence_parent_id` | string \| null | Parent template task |
| `last_occurrence_at` | string \| null | Last instance created |
| `next_occurrence_at` | string \| null | Next scheduled instance |
| `created_at` | string | ISO 8601 |
| `updated_at` | string | ISO 8601 |

### Skill Data Model

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | cuid2 |
| `name` | string | Skill name |
| `description` | string | Purpose and usage |
| `content` | string | System prompt / instructions |
| `version` | number | Version counter |
| `confidence` | number | Success metric (0-100) |
| `uses` | number | Usage counter |
| `last_used` | string \| null | Last usage timestamp |
| `tags` | string[] | Categorization tags |

## Project Structure

```
src/
  main/                          Electron main process
    index.ts                     App lifecycle, window creation
    database.ts                  SQLite operations (better-sqlite3)
    ipc-handlers.ts              IPC handler registrations
    agent-manager.ts             Agent orchestration
    adapters/
      coding-agent-adapter.ts    Adapter interface
      opencode-adapter.ts        OpenCode implementation
      claude-code-adapter.ts     Claude Code implementation
      codex-adapter.ts           Codex implementation
  preload/                       Context bridge
    index.ts                     electronAPI exposure
  renderer/                      React app (Vite)
    src/
      types/                     TypeScript types and DTOs
      stores/                    Zustand stores (task, ui, skill, agent)
      hooks/                     Custom hooks (filtering, sorting)
      lib/                       Utilities (IPC client, cn(), date helpers)
      components/
        ui/                      Radix primitives (Button, Dialog, Input, etc.)
        tasks/                   Task-specific components
        agents/                  Agent transcript and settings
        skills/                  Skill editor and management
        integrations/            OAuth and sync UI
        layout/                  App shell (TitleBar, Sidebar)
      styles/                    Tailwind CSS entry point
```

## Contributing

We welcome contributions! To get started:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/my-feature`
3. **Write code**: Follow TypeScript strict mode, ESLint, and Prettier
4. **Add tests**: Write Vitest tests for new features
5. **Commit changes**: Use conventional commits (e.g., `feat: add skill versioning`)
6. **Push to branch**: `git push origin feature/my-feature`
7. **Open a Pull Request**: Describe changes, ensure CI passes

### Code Style
- TypeScript strict mode enabled
- ESLint for linting
- Prettier for formatting (auto-format on save recommended)
- Minimal Tailwind classNames, prefer CSS variable tokens

### Development Setup
- Use `pnpm` (not npm) for package management
- Read `MEMORY.md` for project-specific patterns and conventions
- Check `AGENTS.md` for agent architecture deep-dive

### Reporting Issues
- Use GitHub Issues for bug reports and feature requests
- Provide detailed reproduction steps
- Include OS, Node.js version, and app version

## Community

- **Issues**: [GitHub Issues](https://github.com/peakflo/pf-desktop/issues)
- **Discord**: https://discord.gg/bPgkmycM

## Security

### Local-First Security
- All data stored locally in SQLite (no cloud sync)
- Database encryption available via better-sqlite3 (optional)

### OAuth Token Storage
- Integration tokens stored in SQLite with Electron's `safeStorage` encryption
- Tokens never logged or transmitted outside authorized API calls

### API Key Handling
- Agent API keys stored in encrypted database
- Keys loaded only in main process (never exposed to renderer)
- Use environment variables for additional security layer (optional)

## Roadmap

### Planned Features
- **Additional integrations** — Jira, Asana, GitHub Issues, Notion
- **Team collaboration** — Shared task sources, multi-user support
- **Cost tracking** — Monitor agent token usage and costs per session
- **Agent templates** — Pre-configured agent profiles for common workflows
- **Plugin marketplace** — Community-contributed skills and integrations
- **Desktop notifications** — System notifications for overdue tasks and agent events
- **Light theme** — Light mode option alongside dark theme

### Recently Completed
- ✅ Multi-agent support (OpenCode, Claude Code, Codex)
- ✅ Skills system with versioning
- ✅ Recurring tasks with scheduling
- ✅ Linear, HubSpot, Peakflo integrations
- ✅ MCP server management
- ✅ File attachments and output fields
- ✅ Git worktree management

## License

[MIT](./LICENSE) © 2025 Peakflo

---

Built with [Electron](https://electronjs.org), [React](https://react.dev), and [Anthropic Claude](https://anthropic.com).
