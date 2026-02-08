# Task Sources

Task sources allow importing tasks from external systems (Linear, Jira, Notion, Peakflo Workflo, etc.) via MCP servers. Each task source is linked to an MCP server and uses its tools to list and update tasks.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────┐     ┌──────────────────┐
│  Sidebar UI  │────▶│ TaskSource   │────▶│ SyncManager│────▶│  McpToolCaller   │
│  (sync btn)  │     │   Store      │     │            │     │  (JSON-RPC)      │
└─────────────┘     └──────────────┘     └────────────┘     └──────┬───────────┘
                                                                    │
                                                         ┌─────────▼─────────┐
                                                         │   MCP Server      │
                                                         │ (local or remote) │
                                                         └───────────────────┘
```

### Key Files

| File | Role |
|------|------|
| `src/main/database.ts` | `task_sources` table, CRUD methods, task `external_id`/`source_id` columns |
| `src/main/mcp-tool-caller.ts` | Calls any MCP tool via JSON-RPC (stdio for local, HTTP for remote) |
| `src/main/sync-manager.ts` | Import (list tool → upsert tasks) and export (update tool) logic |
| `src/main/ipc-handlers.ts` | IPC handlers for `taskSource:*` channels |
| `src/renderer/src/stores/task-source-store.ts` | Zustand store for task sources |
| `src/renderer/src/stores/ui-store.ts` | `sourceFilter` state |
| `src/renderer/src/components/agents/AgentSettingsDialog.tsx` | Task source config UI |

## Data Model

### `task_sources` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | cuid2 |
| `mcp_server_id` | TEXT FK → mcp_servers | Which MCP server to call |
| `name` | TEXT | Display name (e.g. "Linear", "Jira") — also used as `task.source` |
| `list_tool` | TEXT | MCP tool name for listing tasks (e.g. `list_tasks`) |
| `list_tool_args` | TEXT (JSON) | Static arguments passed to list tool on every sync |
| `update_tool` | TEXT | MCP tool name for updating tasks (optional, e.g. `update_task`) |
| `update_tool_args` | TEXT (JSON) | Static arguments merged into update tool calls |
| `last_synced_at` | TEXT | ISO timestamp of last successful sync |
| `enabled` | INTEGER | 1 = active, 0 = disabled |

### Task Columns Added

| Column | Type | Description |
|--------|------|-------------|
| `external_id` | TEXT | The task's ID in the external system |
| `source_id` | TEXT FK → task_sources | Which source this task came from |

A unique index on `(source_id, external_id)` prevents duplicate imports.

Local tasks have `external_id = NULL`, `source_id = NULL`, `source = 'local'`.

## How a Task Source Works

### 1. Configuration

In **Agent Settings → Task Sources**, the user:

1. Selects an MCP server (must already be configured and tested so its tools are discovered)
2. Gives the source a name (e.g. "Linear")
3. Picks a **list tool** from the server's discovered tools dropdown
4. Optionally picks an **update tool** for two-way sync

The form populates tool dropdowns from `mcpServer.tools[]`, which are discovered during MCP server test connection.

### 2. Import (Sync)

Triggered manually — user clicks the sync button in the sidebar header or "Sync Now" on a source card.

**Flow:**

1. `SyncManager.importTasks(sourceId)` is called
2. Fetches the `TaskSourceRecord` and its linked `McpServerRecord` from the database
3. `McpToolCaller.callTool(server, source.list_tool, source.list_tool_args)` executes the MCP tool
4. The tool response is parsed into `ExternalTask[]`
5. For each external task, upsert by `(source_id, external_id)`:
   - **Exists** → update title, description, type, priority, status, assignee, due_date, labels
   - **New** → create task with `source = source.name`, `source_id`, `external_id`
6. `last_synced_at` is updated on the source

**Response parsing** handles multiple formats:

- Standard MCP: `{ content: [{ type: "text", text: "<JSON>" }] }` — JSON is parsed from the text content
- Direct array: `[{ id, title, ... }]`
- Wrapped: `{ tasks: [...] }` or `{ items: [...] }`

Each item must have `external_id` (or `id`) and `title`. All other fields are optional.

### 3. Export (Two-Way Sync)

When a user updates a task that has a `source_id` and `external_id`, the change is automatically pushed back.

**Flow:**

1. `task-store.ts` `updateTask` detects `updated.source_id && updated.external_id`
2. Fires `taskSourceApi.exportUpdate(taskId, changedFields)` in the background
3. `SyncManager.exportTaskUpdate` fetches the task and its source
4. If the source has an `update_tool`, calls it with: `{ ...source.update_tool_args, external_id, ...changedFields }`

If the source has no `update_tool`, the export is silently skipped (one-way import only).

### 4. Conflict Resolution

Last-write-wins. On import, the external system's data overwrites local changes. On export, local changes are pushed immediately. No merge logic.

## MCP Tool Caller

`McpToolCaller` speaks the MCP protocol directly, without going through OpenCode.

### Local Servers (stdio)

1. Spawns the server process (`command + args`) with stdin/stdout pipes
2. Sends JSON-RPC `initialize` request
3. On success, sends `notifications/initialized` + `tools/call` with the tool name and arguments
4. Parses the `tools/call` response
5. Kills the process

Each call spawns a fresh process — no persistent connections.

### Remote Servers (HTTP)

1. POST `initialize` to the server URL
2. POST `notifications/initialized` (fire-and-forget)
3. POST `tools/call` with tool name and arguments
4. Returns the parsed response

Both transports have a 60-second timeout.

## UI

### Sidebar

- **Sync button** (RefreshCw icon) — appears next to Settings when sources exist. Syncs all enabled sources, shows spinner while running. After sync, refetches all tasks.
- **Source filter** — dropdown in the filters section: "All Sources", "Local", or individual source names. Filters `tasks` by `source_id`.

### Task List Item

Tasks from external sources show a small badge with the source name (e.g. "Linear") below the priority badge.

### Agent Settings Dialog

The **Task Sources** section appears between MCP Servers and GitHub Integration:

- **TaskSourceCard** — shows name, linked MCP server, list tool, last synced timestamp, sync/edit/delete buttons
- **TaskSourceForm** — MCP server select → name input → list tool dropdown → update tool dropdown (optional)

Tool dropdowns are populated from the selected MCP server's `tools[]` array. If no tools are discovered (server not tested), falls back to a plain text input.

## MCP Server Tool Contract

For a task source to work, the MCP server must expose tools that follow this contract:

### List Tool

The list tool must return tasks as JSON. Each task object should have:

```typescript
{
  external_id: string  // or "id" — unique identifier in the external system
  title: string        // required
  description?: string
  type?: string        // "coding" | "manual" | "review" | "approval" | "general"
  priority?: string    // "critical" | "high" | "medium" | "low"
  status?: string      // "inbox" | "accepted" | "in_progress" | "pending_review" | "completed" | "cancelled"
  assignee?: string
  due_date?: string    // ISO date string or null
  labels?: string[]
}
```

The response can be a JSON array or an object with a `tasks` or `items` property containing the array. The JSON should be returned as an MCP text content block:

```json
{ "content": [{ "type": "text", "text": "[{\"id\": \"LIN-123\", \"title\": \"Fix bug\", ...}]" }] }
```

### Update Tool

The update tool receives merged arguments: `{ ...source.update_tool_args, external_id, ...changedFields }`. It should update the corresponding task in the external system.

`changedFields` contains only the fields that were changed locally (e.g. `{ status: "completed" }`).
