# Task Lifecycle & State Management

This document describes the task status model, state transitions, auto-run scheduling, and auto-triage system.

## Task Statuses

```typescript
enum TaskStatus {
  NotStarted    = 'not_started'      // Default. Waiting to be picked up.
  Triaging      = 'triaging'         // Auto-triage in progress (assigning agent/skills/labels).
  AgentWorking  = 'agent_working'    // Agent session is active.
  ReadyForReview = 'ready_for_review' // Agent finished. Awaiting human review.
  AgentLearning = 'agent_learning'   // Agent is learning from feedback (skill extraction).
  Completed     = 'completed'        // Done.
}
```

### UI Indicators

| Status | Badge | Dot Color |
|--------|-------|-----------|
| Not Started | grey | grey |
| Triaging | grey | grey (pulsing) |
| Agent Working | yellow | amber (pulsing) |
| Ready for Review | purple | purple |
| Agent Learning | blue | blue (pulsing) |
| Completed | green | green |

## State Transitions

```
                    ┌─────────────────────────────────────────┐
                    │                                         │
                    ▼                                         │
              ┌───────────┐    auto-triage     ┌──────────┐  │
  Created ──> │not_started│ ─────────────────> │ triaging │  │
              └─────┬─────┘ <──────────────── └──────────┘  │
                    │         triage complete                 │
                    │         (agent_id now set)              │
                    │                                         │
                    │  auto-run / manual start                │
                    ▼                                         │
              ┌─────────────┐                                │
              │agent_working│                                │
              └──────┬──────┘                                │
                     │  agent goes idle                      │
                     ▼                                       │
              ┌────────────────┐                             │
              │ready_for_review│                             │
              └───────┬────────┘                             │
                      │  user completes                      │
                      ▼                                      │
              ┌───────────────┐   feedback    ┌────────────┐│
              │   completed   │ ────────────> │agent_learning│
              └───────────────┘ <──────────── └────────────┘
                                  learning done
```

### Transition Details

| From | To | Trigger |
|------|----|---------|
| (new) | `not_started` | Task created (UI, MCP, sync, API) |
| `not_started` | `triaging` | Auto-run enabled, task has no `agent_id` |
| `triaging` | `not_started` | Triage agent finishes (agent_id now assigned) |
| `not_started` | `agent_working` | Auto-run picks up task (has agent_id), or manual start |
| `agent_working` | `ready_for_review` | Agent session goes idle (`transitionToIdle`) |
| `ready_for_review` | `completed` | User clicks "Complete Task" |
| `completed` | `agent_learning` | User submits feedback; `learnFromSession` starts |
| `agent_learning` | `completed` | Skill extraction finishes |

## Auto-Run

Auto-run is toggled via the Play button in the sidebar. When enabled, the scheduler (`use-agent-auto-start.ts`) continuously monitors tasks and starts agent sessions automatically.

### Eligibility Criteria (regular auto-start)

A task is eligible for auto-start when ALL conditions are true:

- `status === 'not_started'`
- `agent_id` is set
- Not snoozed (`snoozed_until` is null or in the past)
- No active session exists for this task

### Scheduling

- Tasks are grouped by `agent_id`
- Each agent respects `max_parallel_sessions` (default: 1)
- Tasks are sorted by priority (critical > high > medium > low)
- Excess tasks are queued per-agent
- When an agent goes idle, the next queued task starts
- A periodic check (60s) catches any stuck tasks

## Auto-Triage

When auto-run is enabled and a new task has no `agent_id`, the system automatically triages it using the default agent.

### Triage Flow

```
New task (no agent_id, status=not_started)
    │
    ▼
selectTriageCandidates() detects it
    │
    ▼
startTriage() → status='triaging' → start default agent
    │
    ▼
agent-manager detects status='triaging' → builds triage prompt
    │
    ▼
Default agent runs:
  → find_similar_tasks (keyword matching on historical tasks)
  → list_agents, list_skills, list_repos
  → update_task(agent_id, skill_ids, labels, priority, repos)
    │
    ▼
Agent goes idle → transitionToIdle()
  → detects isTriageSession → status back to 'not_started'
  → removes triage session from store
    │
    ▼
Auto-run detects task with agent_id + status=not_started
  → starts assigned agent via normal auto-run flow
```

### Triage Prompt

The triage agent receives a structured prompt that instructs it to:

1. Call `find_similar_tasks` with keywords from the task title/description
2. Call `list_agents` to see available agents
3. Call `list_skills` to see available skills
4. Call `list_repos` to see known repositories
5. Determine the best `agent_id`, `skill_ids`, `repos`, `priority`, and `labels`
6. Call `update_task` once with all determined values
7. NOT work on the task itself

### Triage Safety

- **Status guard:** The `/update_task` API skips status changes when a task is in `triaging` status. This prevents the triage agent from accidentally changing the task status.
- **Retry limit:** Max 2 triage attempts per task. If the agent fails to assign an `agent_id` after 2 tries, a toast notification tells the user to assign manually.
- **Session cleanup:** The triage session is removed from the agent store after completion so the task becomes eligible for auto-start.
- **No triage when disabled:** If auto-run is off, no triage happens.
- **Pre-assigned tasks skip triage:** Tasks created with `agent_id` already set go directly to auto-run.

### Manual Triage

A "Triage" button (with sparkle icon) appears in the task detail view when no agent is assigned. Clicking it manually triggers the same triage flow.

## MCP Tools for Triage

The task-management MCP server provides these tools used during triage:

| Tool | Purpose |
|------|---------|
| `find_similar_tasks` | Find historical tasks by keyword matching (title, description, type, labels) |
| `list_agents` | List all available agents with capabilities |
| `list_skills` | List all available skills |
| `list_repos` | List known repos from historical tasks + GitHub org setting |
| `update_task` | Assign agent_id, skill_ids, labels, priority, repos |

### `find_similar_tasks` Algorithm

Uses **SQLite FTS5 full-text search** with BM25 ranking — not semantic search and not simple LIKE matching:

- Keywords are tokenised into individual words and matched using FTS5 `MATCH` expressions
- `title_keywords` → `title:<word>*` (prefix match, higher BM25 weight)
- `description_keywords` → `description:<word>*` (prefix match, lower BM25 weight)
- `type` → exact column filter
- `labels` → `labels:<word>` per label token
- Results are ranked by `bm25(tasks_fts, 10.0, 5.0, 2.0, 1.0)` — title matches weighted 10×, description 5×
- `completed_only` → filters to completed tasks first; falls back to all statuses if no results found
- Falls back to recent tasks ordered by `created_at DESC` if no keywords are provided

## Key Files

| File | Role |
|------|------|
| `src/shared/constants.ts` | `TaskStatus` enum |
| `src/main/agent-manager.ts` | Session lifecycle, `buildTriagePrompt`, `transitionToIdle` |
| `src/main/task-api-server.ts` | HTTP API routes (`/update_task` status guard, `/list_repos`) |
| `src/main/mcp-servers/task-management-mcp.ts` | MCP tool definitions |
| `src/renderer/src/hooks/use-agent-auto-start.ts` | Auto-run scheduler + triage trigger |
| `src/renderer/src/components/tasks/TaskWorkspace.tsx` | Manual triage button wiring |
| `src/renderer/src/components/tasks/TaskDetailView.tsx` | Triage button UI |
| `src/renderer/src/stores/agent-store.ts` | Session state management |
| `src/renderer/src/stores/agent-scheduler-store.ts` | Running counts, queues |
