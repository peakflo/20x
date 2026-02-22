# AGENTS.md — Multi-Agent Architecture (Phase 3)

This document describes the planned multi-agent system for 20x. It is not yet implemented — this serves as the architectural specification for Phase 3 development.

## Overview

20x will support running multiple AI coding agents in parallel, each working on assigned tasks within specific codebases. Agents are managed through the OpenCode SDK and interact with users via streaming terminal transcripts with human-in-the-loop (HITL) approval flows.

## Agent Model

Each agent is a persistent configuration stored in SQLite:

```typescript
interface Agent {
  id: string                    // cuid2
  name: string                  // e.g. "Backend Agent", "Frontend Agent"
  server_url: string            // OpenCode server URL
  config: AgentConfig           // stored as JSON
  is_default: boolean           // one agent is pre-seeded on first launch
  created_at: string
  updated_at: string
}

interface AgentConfig {
  model: string                 // e.g. "claude-sonnet-4-5-20250929"
  mcp_servers: McpServerConfig[]
  system_prompt?: string
  max_tokens?: number
  temperature?: number
}

interface McpServerConfig {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}
```

## Database Schema

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  server_url TEXT NOT NULL DEFAULT 'http://localhost:3000',
  config TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Tasks table gets a new nullable column:
ALTER TABLE tasks ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
```

A default agent is seeded on first launch with sensible defaults.

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
│  ┌───────────────────────┐  ┌──────────────────────────┐  │
│  │   Agent Manager       │  │   Database Manager       │  │
│  │                       │  │                           │  │
│  │ - OpenCode SDK client │  │ - agents table CRUD      │  │
│  │ - Session lifecycle   │  │ - task-agent assignment   │  │
│  │ - Event streaming     │  │                           │  │
│  │ - HITL flow           │  │                           │  │
│  └───────────┬───────────┘  └──────────────────────────┘  │
│              │                                             │
└──────────────┼─────────────────────────────────────────────┘
               │
               ▼
  ┌────────────────────────┐
  │   OpenCode Server(s)   │
  │                        │
  │  - LLM inference       │
  │  - MCP tool execution  │
  │  - File system access  │
  └────────────────────────┘
```

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
| `agent:start` | renderer -> main | `agentId, taskId` | `{ sessionId }` |
| `agent:stop` | renderer -> main | `sessionId` | `{ success }` |
| `agent:send` | renderer -> main | `sessionId, message` | — |
| `agent:output` | main -> renderer | `{ sessionId, data }` | — |
| `agent:status` | main -> renderer | `{ agentId, status }` | — |
| `agent:approval` | main -> renderer | `{ sessionId, action, description }` | — |
| `agent:approve` | renderer -> main | `{ sessionId, approved }` | — |

## Agent Manager

`src/main/agent-manager.ts` — the core orchestration layer.

```typescript
class AgentManager extends EventEmitter {
  // Active sessions indexed by session ID
  private sessions: Map<string, AgentSession>

  // Start an agent working on a task
  async startSession(agentId: string, taskId: string): Promise<string>

  // Stop a running session
  async stopSession(sessionId: string): Promise<void>

  // Send user input to a session (for HITL approval or follow-up prompts)
  async sendMessage(sessionId: string, message: string): Promise<void>

  // Clean up all sessions on app exit
  stopAllSessions(): void
}
```

Each session wraps an OpenCode SDK client instance and streams events (output, status changes, approval requests) to the renderer via IPC.

## UI Components (Planned)

### Agent Settings Page

- List of configured agents with name, server URL, model
- Create/edit/delete agents
- Per-agent MCP server configuration (add/remove servers, set commands and environment)
- Model selection dropdown
- Test connection button

### Agent Assignment

- Task detail view has an "Assign Agent" dropdown
- Shows available agents with their current status (idle, working, error)
- Assigning starts a session automatically
- **Auto-Triage**: When auto-run is enabled and a task has no agent assigned, the default agent automatically triages the task — analyzing similar historical tasks and assigning the best agent, skills, repos, priority, and labels. See `docs/task-lifecycle.md` for details.
- A manual "Triage" button is available on tasks with no agent assigned

### Agent Transcript Panel

- Split view: task detail on left, agent transcript on right
- Streaming terminal output with ANSI color support
- HITL approval banner when agent requests permission for file writes, shell commands, etc.
- Approve/reject buttons with optional user message

## HITL (Human-in-the-Loop) Flow

1. Agent encounters a potentially destructive action (file write, shell command, etc.)
2. OpenCode SDK emits an approval event with action description
3. Main process forwards to renderer via `agent:approval` IPC
4. UI shows a banner: "Agent wants to: _run `rm -rf dist/`_. [Approve] [Reject]"
5. User decision sent back via `agent:approve` IPC
6. Agent continues or aborts based on response

## Implementation Order

1. Add `agents` table to database, seed default agent
2. Create `AgentManager` class with OpenCode SDK integration
3. Register `agent:*` IPC handlers
4. Build Agent Settings UI (CRUD)
5. Add agent assignment to task detail view
6. Build streaming transcript panel
7. Implement HITL approval flow
8. Integration testing with real OpenCode server

## Open Questions

- **Session persistence**: Should agent sessions survive app restart? Leaning no — sessions are ephemeral, task assignment persists.
- **Concurrent tasks per agent**: Should one agent handle multiple tasks simultaneously? Starting with one task per agent.
- **Cost tracking**: Should we track token usage per session? Useful but not MVP.
- **Agent templates**: Pre-configured agent profiles (e.g., "Code Review Agent" with review-focused system prompt)? Nice to have.
