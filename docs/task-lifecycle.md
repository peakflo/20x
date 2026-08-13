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

## Per-Task Automation Flags

Two flags on a task drive it without any human, and without any window:

| Flag | Effect |
|------|--------|
| `auto_start_agent` | The task is handed to its agent as soon as it exists or becomes due. Set it on a recurring task and every occurrence runs by itself. |
| `auto_complete_without_review` | The task goes straight to `completed` when its agent finishes, instead of stopping at `ready_for_review`. |

Both are owned by the **main process**, not the renderer, and both are
independent of the sidebar auto-run toggle:

- `src/main/task-automation-scheduler.ts` reconciles them against SQLite every
  60 seconds, and on demand whenever a task is created or its status changes.
  Because it reconciles durable state rather than reacting to an event, a
  missed event costs latency, never correctness.
- `src/main/agent-manager.ts` (`transitionToIdle` →
  `completeTaskWithoutReview`) applies `auto_complete_without_review`
  immediately when a session goes idle.

Both flags can be set from the desktop UI, the mobile UI, the HTTP API, and the
`create_task` / `update_task` MCP tools.

> These used to live in `use-agent-auto-start.ts`, driven by one-shot
> `task:created` / `task:updated` events. That made them silently
> window-dependent — an occurrence created while the window was closed was
> never started, and never retried.

### Flags and subtasks

A task that works through subtasks obeys these rules:

- A parent is **never completed while a child is unfinished**. Its agent can
  create children and then stop; completing there would mark the occurrence
  done with none of the work run. The parent is parked in `ready_for_review`
  and completes once every child is terminal.
- A child is started **through its parent**, one at a time, in `sort_order`.
  Only a genuinely running child (`agent_working`, `triaging`,
  `agent_learning`) blocks the next one. A child in `ready_for_review` has
  finished its agent run and does not block, because a subtask cannot set
  itself to `completed`.
- `/create_subtask` passes `auto_complete_without_review` down from the
  parent, so an unattended chain does not park in review at its first step.
  `auto_start_agent` is **not** passed down — children are started through the
  parent, which is what keeps them in order.

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

Uses SQL `LIKE` substring matching — not semantic search:

- `title_keywords` → `WHERE title LIKE '%keyword%'`
- `description_keywords` → `WHERE description LIKE '%keyword%'`
- `type` → exact match
- `labels` → JSON substring match
- `completed_only` → filters to completed tasks only (default: true)

## Key Files

| File | Role |
|------|------|
| `src/shared/constants.ts` | `TaskStatus` enum |
| `src/main/agent-manager.ts` | Session lifecycle, `buildTriagePrompt`, `transitionToIdle` |
| `src/main/task-api-server.ts` | HTTP API routes (`/update_task` status guard, `/list_repos`) |
| `src/main/mcp-servers/task-management-mcp.ts` | MCP tool definitions |
| `src/main/task-automation-scheduler.ts` | `auto_start_agent` / `auto_complete_without_review` reconciliation |
| `src/renderer/src/hooks/use-agent-auto-start.ts` | Auto-run scheduler + triage trigger |
| `src/renderer/src/components/tasks/TaskWorkspace.tsx` | Manual triage button wiring |
| `src/renderer/src/components/tasks/TaskDetailView.tsx` | Triage button UI |
| `src/renderer/src/stores/agent-store.ts` | Session state management |
| `src/renderer/src/stores/agent-scheduler-store.ts` | Running counts, queues |
