# AGENTS.md — Multi-Agent Architecture (Implemented)

This document describes the production multi-agent system powering 20x. The architecture spans three agent backends, a centralized polling coordinator, skill management, auto-triage, secret management, heartbeat monitoring, and enterprise sync.

## Overview

20x supports running multiple AI coding agents in parallel, each working on assigned tasks within specific codebases. Agents are managed through adapter interfaces and interact with users via streaming transcripts with human-in-the-loop (HITL) approval flows. Three backend adapters are supported: **OpenCode SDK**, **Claude Code**, and **Codex (ACP)**.

## Agent Model

Each agent is a persistent configuration stored in SQLite:

```typescript
interface AgentRecord {
  id: string                    // cuid2
  name: string                  // e.g. "Backend Agent", "Frontend Agent"
  server_url: string            // Default: 'http://localhost:4096'
  config: AgentConfigRecord     // stored as JSON
  is_default: boolean           // one agent is pre-seeded on first launch
  created_at: string
  updated_at: string
}

interface AgentConfigRecord {
  coding_agent?: 'opencode' | 'claude-code' | 'codex'
  model?: string
  auth_method?: 'subscription' | 'api_key'
  permission_mode?: 'ask' | 'allow'
  system_prompt?: string
  mcp_servers?: Array<string | AgentMcpServerEntry>
  skill_ids?: string[]
  secret_ids?: string[]
  api_keys?: {
    openai?: string
    anthropic?: string
  }
}

interface AgentMcpServerEntry {
  serverId: string
  enabledTools?: string[]
}
```

A default agent is seeded on first launch with sensible defaults.

## Database Schema

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  server_url TEXT NOT NULL DEFAULT 'http://localhost:4096',
  config TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Tasks table has agent_id for assignment:
ALTER TABLE tasks ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;

-- Skills table stores reusable instructions:
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.5,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  enterprise_skill_id TEXT DEFAULT NULL,
  uses_at_last_sync INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Secrets table for encrypted env vars:
CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  env_var_name TEXT NOT NULL UNIQUE,
  value BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- MCP servers table:
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'local',
  command TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '[]',
  url TEXT,
  headers TEXT NOT NULL DEFAULT '{}',
  environment TEXT NOT NULL DEFAULT '{}',
  tools TEXT NOT NULL DEFAULT '[]',
  oauth_metadata TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Database schema migrations are run automatically with version tracking (`SCHEMA_VERSION = 8` in `database.ts`). Migration history includes column additions for attachments, repos, output fields, agent_id, session_id, snoozed_until, recurring tasks, heartbeat, subtasks, and more.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Renderer Process                       │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Agent Panel  │  │ Task Detail  │  │ Agent Settings │  │
│  │ (streaming   │  │ (assign      │  │ (CRUD agents,  │  │
│  │  transcript) │  │  agent)      │  │  MCP config)   │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                 │                   │           │
│         └────────┬────────┴───────────────────┘           │
│                  │ IPC                                     │
├──────────────────┼────────────────────────────────────────┤
│                  │       Main Process                      │
│                  ▼                                         │
│  ┌──────────────────────────────────────────────────┐     │
│  │              Agent Manager                        │     │
│  │                                                   │     │
│  │  ┌─────────────┐  ┌──────────────┐               │     │
│  │  │  Polling    │  │  Adapter     │               │     │
│  │  │  Coordinator│  │  Registry    │               │     │
│  │  │  (2s tick)  │  │              │               │     │
│  │  └─────────────┘  └──────┬───────┘               │     │
│  │                          │                        │     │
│  │              ┌───────────┼───────────┐            │     │
│  │              ▼           ▼           ▼            │     │
│  │  ┌────────────┐ ┌───────────┐ ┌─────────────┐    │     │
│  │  │  OpenCode  │ │Claude Code│ │ Codex (ACP) │    │     │
│  │  │  Adapter   │ │  Adapter  │ │  Adapter    │    │     │
│  │  └────────────┘ └───────────┘ └─────────────┘    │     │
│  │                                                   │     │
│  │  ┌──────────────┐  ┌──────────────────────────┐  │     │
│  │  │Secret Broker  │  │  MCP Auth Proxy          │  │     │
│  │  │(env injection)│  │  (JWT injection for      │  │     │
│  │  └──────────────┘  │   enterprise MCP Dev)     │  │     │
│  │                    └──────────────────────────┘  │     │
│  └──────────────────────────────────────────────────┘     │
│                                                           │
│  ┌───────────────────────┐  ┌──────────────────────────┐  │
│  │   Worktree Manager    │  │   Database Manager       │  │
│  │                       │  │                           │  │
│  │ - Git worktree setup  │  │ - All table CRUD         │  │
│  │ - Per-task workspace  │  │ - Schema migrations      │  │
│  │ - Multi-repo support  │  │ - Auto-backup before      │  │
│  └───────────────────────┘  │   migrations              │  │
│                             └──────────────────────────┘  │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │Enterprise    │  │ Heartbeat    │  │ Task API       │  │
│  │ Sync Manager │  │ Scheduler    │  │ Server (MCP)   │  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
│                                                           │
└───────────────────────────────────────────────────────────┘
               │
               ▼
  ┌──────────────────────────────┐
  │  Agent Backend Servers       │
  │                              │
  │  - OpenCode (localhost:4096) │
  │  - Claude Code (CLI)         │
  │  - Codex (ACP protocol)      │
  │  - MCP servers (stdio/http)  │
  └──────────────────────────────┘
```

## Adapter Architecture

Each coding agent backend is wrapped in a standard `CodingAgentAdapter` interface (`src/main/adapters/coding-agent-adapter.ts`):

```typescript
interface CodingAgentAdapter {
  initialize(): Promise<void>
  createSession(config: SessionConfig): Promise<string>
  resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]>
  sendPrompt(sessionId: string, parts: MessagePart[], config: SessionConfig): Promise<void>
  getStatus(sessionId: string, config: SessionConfig): Promise<SessionStatus>
  pollMessages(sessionId: string, seenMessageIds, seenPartIds, partContentLengths, config): Promise<MessagePart[]>
  abortPrompt(sessionId: string, config: SessionConfig): Promise<void>
  destroySession(sessionId: string, config: SessionConfig): Promise<void>
  registerMcpServer(serverName: string, mcpConfig, workspaceDir?: string): Promise<void>
  checkHealth(): Promise<{ available: boolean; reason?: string }>
  // Optional: getProviders, getAllMessages, getRunningTools, respondToQuestion, notifyConfigChanged
}
```

### OpenCode Adapter (`src/main/adapters/opencode-adapter.ts`)

Uses `@opencode-ai/sdk` to communicate with the OpenCode server (typically running on `localhost:4096`). This is the default backend. Supports MCP server registration, streaming, and HITL approval via the SDK's native event model.

### Claude Code Adapter (`src/main/adapters/claude-code-adapter.ts`)

Spawns `claude` CLI process with MCP config injected via the `--mcp-servers` flag. Supports `subscription` (OAuth/Pro/Max) and `api_key` (pay-per-use) auth methods. Permission mode can be `ask` (HITL approval) or `allow` (automatic). Uses JSON-RPC over stdin/stdout.

### Codex Adapter (`src/main/adapters/acp-adapter.ts`)

Implements the Agent Communication Protocol (ACP) — the same protocol used by Zed's Codex integration. Communicates via WebSocket with OpenAI's Codex backend.

## Polling Coordinator

Instead of independent timers per session (which would cause event-loop starvation under load), a single centralized timer polls all active sessions sequentially every 2 seconds:

```typescript
// src/main/agent-manager.ts — PollingEntry tracking
interface PollingEntry {
  sessionId: string
  adapter: CodingAgentAdapter
  seenMessageIds: Set<string>        // Dedup
  seenPartIds: Set<string>           // Dedup
  partContentLengths: Map<string, string>  // Content-level dedup
  initialPromptSent?: boolean
  createdAt: number
  hasSeenWork?: boolean
  // ...
}
```

Features:
- **Dedup by ID and content length** — avoids re-processing the same messages
- **Idle-to-completion transition** — after a grace period with no activity, transitions from `agent_working` → `ready_for_review`
- **Stuck session watchdog** — aborts after 5 minutes with no new data
- **Stuck tool detector** — aborts individual tools after 90 seconds (e.g., cross-workspace file reads)
- **Garbled output detection** — aborts when model hallucinates tool-call markup
- **Event-driven nudge** — adapters call `onDataAvailable()` to trigger an immediate poll (50ms debounce) instead of waiting for the 2s tick
- **Memory safety** — capped dedup structures (5K entries), 10MB per-session value limit, 200 session redirects
- **tillDone nudge** — capped at 5 nudges per session

## IPC Channels

### Agent CRUD

| Channel | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `agent:getAll` | renderer -> main | — | `Agent[]` |
| `agent:get` | renderer -> main | `id` | `Agent` |
| `agent:create` | renderer -> main | `CreateAgentData` | `Agent` |
| `agent:update` | renderer -> main | `id, UpdateAgentData` | `Agent` |
| `agent:delete` | renderer -> main | `id` | `boolean` |

### Agent Sessions

| Channel | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `agentSession:start` | renderer -> main | `agentId, taskId, workspaceDir?, skipInitialPrompt?` | `{ sessionId }` |
| `agentSession:resume` | renderer -> main | `agentId, taskId, ocSessionId` | `{ sessionId, ended? }` |
| `agentSession:abort` | renderer -> main | `sessionId` | `{ success }` |
| `agentSession:stop` | renderer -> main | `sessionId` | `{ success }` |
| `agentSession:stopByTaskId` | renderer -> main | `taskId` | `{ success, sessionId }` |
| `agentSession:send` | renderer -> main | `sessionId, message, taskId?, agentId?, attachments?` | `{ success, ... }` |
| `agentSession:sendByTaskId` | renderer -> main | `taskId, message, attachments?` | `{ success, ... }` |
| `agentSession:approve` | renderer -> main | `sessionId, approved, message?` | `{ success }` |
| `agentSession:syncSkills` | renderer -> main | `sessionId` | `SkillSyncResult` |
| `agentSession:syncSkillsForTask` | renderer -> main | `taskId` | `SkillSyncResult` |
| `agentSession:learnFromSession` | renderer -> main | `sessionId, message` | `SkillSyncResult` |
| `agentSession:getRawTranscript` | renderer -> main | `taskId` | transcript data |

### Agent Events (main -> renderer via `webContents.send`)

| Channel | Payload |
|---------|---------|
| `agent:output` | `{ sessionId, data }` — streaming transcript parts |
| `agent:status` | `{ agentId, status }` — status transitions |
| `agent:approval` | `{ sessionId, action, description }` — HITL request |
| `agent:todos` | `{ sessionId, todos }` — todo list updates |

### Agent Config

| Channel | Direction | Description |
|---------|-----------|-------------|
| `agentConfig:getProviders` | renderer -> main | List available models from backend |

## Agent Manager

`src/main/agent-manager.ts` — the core orchestration layer (1500+ lines).

```typescript
class AgentManager extends EventEmitter {
  private sessions: Map<string, AgentSession>
  private pollingEntries: Map<string, PollingEntry>
  private adapters: Map<string, CodingAgentAdapter>

  // Session lifecycle
  async startSession(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<string>
  async resumeSession(agentId: string, taskId: string, ocSessionId: string): Promise<string | null>
  async stopSession(sessionId: string): Promise<void>
  async abortSession(sessionId: string): Promise<void>
  async stopByTaskId(taskId: string): Promise<{ sessionId: string | undefined }>
  stopAllSessions(): void
  async stopServer(): Promise<void>

  // Communication
  async sendMessage(sessionId: string, message: string, taskId?: string, agentId?: string, attachments?): Promise<{ role }>
  async sendByTaskId(taskId: string, message: string, attachments?): Promise<{ role }>
  async respondToPermission(sessionId: string, approved: boolean, message?: string): Promise<void>

  // Skills
  async writeSkillFiles(taskId: string, agentId: string, workspaceDir: string): Promise<void>
  async learnFromSession(sessionId: string, message: string): Promise<SkillSyncResult>
  async syncSkillsFromWorkspace(sessionId: string): Promise<SkillSyncResult>
  async syncSkillsForTask(taskId: string): Promise<SkillSyncResult>

  // Diagnostics
  async getRawTranscriptForDebug(taskId: string): Promise<any>

  // MCP
  async testMcpServer(serverData): Promise<McpTestResult>
  async getProviders(serverUrl?, directory?, backendType?): Promise<...>
}
```

### Session Lifecycle

Each session wraps a coding agent adapter instance and streams events to the renderer via IPC.

1. **Start** — Agent assigned, worktree setup, skill files written to workspace, MCP servers configured, session created
2. **Streaming** — Centralized polling coordinator polls every 2s; adapter nudges on new data (50ms debounce)
3. **Approval** — Agent pauses for human decisions; response sent back via `agentSession:approve`
4. **Completion** — Idle detection transitions to `ready_for_review`, task updated
5. **Learning** — Optional feedback loop: agent reviews session, updates skills, syncs back to DB

### Worktree Management

Before starting an agent session, the AgentManager optionally sets up git worktrees for the task's repositories:
- Fetches repo metadata from GitHub or GitLab
- Creates isolated worktrees per branch per task
- Supports multiple repos across different orgs
- Falls back gracefully if worktree setup fails

### Secret Broker

Secrets (encrypted API keys, database URLs, etc.) are injected into agent sessions:
- **Encryption**: Values encrypted with Electron `safeStorage` at rest
- **Secret Broker**: An HTTP server on `localhost` that serves secrets to the agent's shell process
- **Wrapper script**: `secret-shell.sh` intercepts bash commands to inject env vars
- **Claude Code path**: Direct env var injection into the spawned process
- **System prompt awareness**: Agents are told which secrets are available (name/description only — never the value)

### Memory Management

- `MAX_DEDUP_ENTRIES = 5_000` per session — prevents OOM from unbounded sets
- `MAX_VALUE_CHARS_PER_SESSION = 10_000_000` — prevents OOM from large part content
- `MAX_SESSION_REDIRECTS = 200` — prevents unbounded redirect map growth
- `MAX_TILLDONE_NUDGES = 5` — prevents infinite nudge loops
- `STUCK_SESSION_TIMEOUT_MS = 300_000` (5 min) — aborts hung sessions
- `STUCK_TOOL_TIMEOUT_MS = 90_000` (90 sec) — aborts hung tools

## UI Components

### Agent Settings Page

- List of configured agents with name, coding agent type, model
- Create/edit/delete agents
- Per-agent MCP server configuration (add/remove servers, set commands and environment, enable/disable tools)
- Coding agent selection (OpenCode / Claude Code / Codex)
- Auth method (subscription vs API key) and permission mode (ask vs allow)
- Skill assignment picker
- Secret assignment picker
- Model selection dropdown (fetched from backend)
- Test connection button

### Agent Assignment

- Task detail view has an "Assign Agent" dropdown
- Shows available agents with their current status (idle, working, error)
- Assigning starts a session automatically
- **Auto-Triage**: When auto-run is enabled and a task has no agent assigned, the default agent automatically triages the task
- A manual "Triage" button is available on tasks with no agent assigned

### Agent Transcript Panel

- Split view: task detail on left, agent transcript on right
- Streaming terminal output with message part rendering (text, reasoning, tool calls, progress events)
- HITL approval banner when agent requests permission for file writes, shell commands, etc.
- Approve/reject buttons with optional user message
- Todo list tracking from agent output
- Session status indicator (idle, working, error, waiting_approval)

### Dashboard Workspace

- Overview dashboard with task completion stats, AI autonomy metrics, agent success rates
- Kanban task board grouped by status with drag-and-drop support
- Workflow application launcher
- Presetup wizard with guided templates

## Auto-Triage System

When auto-run is enabled and a new task has no `agent_id`, the system automatically triages it using the default agent (see `docs/task-lifecycle.md`):

```
New task (no agent_id, status=not_started)
  → selectTriageCandidates() detects it
  → startTriage() → status='triaging' → start default agent
  → Agent runs MCP tools:
    find_similar_tasks, list_agents, list_skills, list_repos
    update_task(agent_id, skill_ids, labels, priority, repos)
  → Agent goes idle → status back to 'not_started'
  → Auto-run picks up assigned task → starts real agent
```

- **Retry limit**: Max 2 triage attempts per task
- **Status guard**: API skips status changes during triage
- **Session cleanup**: Triage session removed from store post-completion

## Skills System

Skills are reusable `SKILL.md` instructions that agents discover and load on-demand during sessions.

### Data Model

- **Task-level**: `task.skill_ids` — takes priority
- **Agent-level**: `agent.config.skill_ids` — fallback
- **Unset** (both null): all skills loaded

### File Layout

```
workspaces/<taskId>/
  .agents/skills/<name>/SKILL.md   (OpenCode / Codex)
  .claude/skills/<name>/SKILL.md    (Claude Code)
```

### Feedback Learning Loop

1. User completes task → FeedbackDialog (1-5 stars + optional comment)
2. `learnFromSession(sessionId, prompt)` fires in background
3. Agent reviews session transcript, updates SKILL.md files
4. `syncSkillsFromWorkspace()` syncs changes back to SQLite
5. Skills confidence and usage stats are updated automatically

### 2-Way Sync with Workflo

Skills synchronize bidirectionally between 20x and Workflo (enterprise). Uses `enterprise_skill_id` and `uses_at_last_sync` for conflict resolution.

## HITL (Human-in-the-Loop) Flow

1. Agent encounters a potentially destructive action (file write, shell command, etc.)
2. Backend (OpenCode SDK / Claude Code / Codex) emits an approval event
3. Main process forwards to renderer via IPC
4. UI shows a banner with action description and approve/reject buttons
5. User decision sent back via `agentSession:approve`
6. Agent continues or aborts based on response

## Heartbeat Monitoring

Continuous health checks for active tasks:

- Configurable per-task interval (default: 30 minutes)
- Heartbeat scheduler checks every 60 seconds
- CI failure detection (GitHub preflight)
- Status: ok, info, attention_needed, error
- Logs stored in `heartbeat_logs` table
- Auto-disabled when task is completed

## Enterprise Features

### Enterprise Auth (20x Cloud)

- Login/register via browser OAuth callback flow
- Tenant selection with resource sync
- JWT-based authentication with auto-refresh
- Session persistence across app restarts

### Enterprise Sync

- Skills, MCP servers, and agents sync bidirectionally
- Task state sync (status changes, completions, feedback)
- Enterprise heartbeat with CI failure detection
- MCP auth proxy injects fresh JWT into enterprise MCP Dev Server requests

### Enterprise AI Gateway

- Bring your own key or use subscription-based model
- Model selection from gateway catalog
- Auto-fetch AI gateway key on subscription activation

## Implementation Status

| Feature | Status |
|---------|--------|
| Agents table + seed default agent | ✅ Implemented |
| Agent CRUD IPC handlers | ✅ Implemented |
| OpenCode adapter | ✅ Implemented |
| Claude Code adapter | ✅ Implemented |
| Codex (ACP) adapter | ✅ Implemented |
| Centralized polling coordinator | ✅ Implemented |
| Agent Settings UI (CRUD) | ✅ Implemented |
| Agent assignment to task detail | ✅ Implemented |
| Streaming transcript panel | ✅ Implemented |
| HITL approval flow | ✅ Implemented |
| Auto-triage system | ✅ Implemented |
| Skills system (write, sync, learn) | ✅ Implemented |
| Skills 2-way sync with Workflo | ✅ Implemented |
| Secret management (encrypted env vars) | ✅ Implemented |
| Git worktree management | ✅ Implemented |
| Heartbeat monitoring | ✅ Implemented |
| Enterprise auth + sync | ✅ Implemented |
| MCP server management | ✅ Implemented |
| MCP OAuth flow | ✅ Implemented |
| Subtask support | ✅ Implemented |
| Recurring tasks | ✅ Implemented |
| Mobile API server | ✅ Implemented |
| Claude Plugin marketplace | ✅ Implemented |
| Workspace cleanup scheduler | ✅ Implemented |

## Key Source Files

| File | Role |
|------|------|
| `src/main/agent-manager.ts` | Core orchestration, session lifecycle, polling, skills, secrets |
| `src/main/adapters/coding-agent-adapter.ts` | Adapter interface definition |
| `src/main/adapters/opencode-adapter.ts` | OpenCode SDK integration |
| `src/main/adapters/claude-code-adapter.ts` | Claude Code CLI integration |
| `src/main/adapters/acp-adapter.ts` | Codex ACP protocol integration |
| `src/main/ipc-handlers.ts` | All IPC channel registration |
| `src/main/database.ts` | SQLite schema, CRUD, migrations |
| `src/main/worktree-manager.ts` | Git worktree setup |
| `src/main/secret-broker.ts` | Secret injection HTTP server |
| `src/main/mcp-auth-proxy.ts` | Enterprise JWT injection proxy |
| `src/main/task-api-server.ts` | HTTP API for task-management MCP |
| `src/main/enterprise-sync.ts` | Workflo resource sync |
| `src/main/enterprise-heartbeat.ts` | CI failure heartbeat |
| `src/main/enterprise-state-sync.ts` | Task event streaming |
| `src/main/heartbeat-scheduler.ts` | Task-level heartbeat scheduling |
| `src/main/recurrence-scheduler.ts` | Recurring task scheduling |
| `src/main/claude-plugin-manager.ts` | Claude Plugin marketplace |
| `docs/task-lifecycle.md` | Auto-triage and state transitions |
| `docs/skills.md` | Skills system documentation |
