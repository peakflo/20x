# Enterprise Sync — Implementation (20x Desktop)

## Overview

The Enterprise Sync system connects the 20x desktop app to a pf-workflo organization, enabling bidirectional task synchronization, file downloads, agent/skill/MCP server provisioning, and action execution (approve/reject). It operates in two layers:

1. **EnterpriseSyncManager** — Syncs org node configuration (agents, skills, MCP servers, task sources) from workflo into the local SQLite database.
2. **PeakfloPlugin** — Syncs tasks from workflo, downloads file attachments, exports field updates, and executes approval/rejection actions.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  20x Desktop (Electron)                                          │
│                                                                  │
│  Renderer                     Main Process                       │
│  ┌─────────────────┐         ┌──────────────────────────────┐   │
│  │ EnterpriseStore  │◀──IPC─▶│ EnterpriseAuth               │   │
│  │ TaskSourceStore  │        │   ├─ Supabase client          │   │
│  └─────────────────┘        │   ├─ Token storage (SQLite)   │   │
│                              │   └─ API proxy (JWT auth)     │   │
│                              ├──────────────────────────────┤   │
│                              │ EnterpriseSyncManager         │   │
│                              │   ├─ syncAgents()             │   │
│                              │   ├─ syncSkills()             │   │
│                              │   ├─ syncMcpServers()         │   │
│                              │   └─ syncTaskSources()        │   │
│                              ├──────────────────────────────┤   │
│                              │ PeakfloPlugin                 │   │
│                              │   ├─ importTasksEnterprise()  │   │
│                              │   ├─ downloadWorkfloFiles()   │   │
│                              │   ├─ exportUpdate()           │   │
│                              │   └─ executeAction()          │   │
│                              ├──────────────────────────────┤   │
│                              │ WorkfloApiClient              │──────── JWT ────▶ pf-workflo API
│                              │   ├─ listTasks()              │
│                              │   ├─ updateTask()             │
│                              │   ├─ executeAction()          │
│                              │   ├─ downloadFile()           │
│                              │   ├─ listOrgNodes()           │
│                              │   └─ listSkills()             │
│                              └──────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                            ┌───────────────────────┐
                            │  pf-workflo Backend    │
                            │  (Fastify + Inngest)   │
                            │                       │
                            │  POST /api/20x/auth/* │
                            │  GET  /api/org-nodes  │
                            │  GET  /api/tasks      │
                            │  POST /.../sync       │
                            │  POST /.../complete   │
                            └───────────────────────┘
```

---

## Key Files

| File | Role |
|------|------|
| `src/main/enterprise-auth.ts` | Supabase login, JWT storage, token refresh, API proxy |
| `src/main/enterprise-sync.ts` | Syncs org node resources (agents, skills, MCP servers, task sources) |
| `src/main/workflo-api-client.ts` | HTTP client for pf-workflo REST API with JWT auth |
| `src/main/plugins/peakflo-plugin.ts` | Task import/export, file downloads, approve/reject actions |
| `src/main/plugins/types.ts` | Plugin interface definitions (`TaskSourcePlugin`) |
| `src/main/sync-manager.ts` | Generic sync manager (orchestrates plugin sync) |
| `src/main/database.ts` | SQLite schema: `task_sources`, `mcp_servers`, tasks, file attachments |
| `src/renderer/src/stores/enterprise-store.ts` | Zustand store for enterprise auth state |
| `src/renderer/src/components/settings/tabs/EnterpriseSettings.tsx` | Enterprise settings UI |

---

## Authentication Flow

See [enterprise-tab-spec.md](./enterprise-tab-spec.md) for the full auth specification.

Summary:
1. User signs in with email/password via Supabase (from the Enterprise settings tab)
2. Supabase access token is sent to `POST /api/20x/auth/verify` to get user profile + companies
3. User selects a tenant → `POST /api/20x/auth/select-tenant` returns a pf-workflo JWT
4. JWT is stored in SQLite settings DB and used for all subsequent API calls
5. Token auto-refreshes on app start and when < 5 min remaining

---

## Enterprise Sync Manager

**File:** `src/main/enterprise-sync.ts`

Runs on enterprise connect and before every task sync. Fetches org nodes from workflo and provisions local resources.

### Sync Flow

```
GET /api/org-nodes → filter by user assignment → for each node:
  ├─ node.agents[]     → upsert local agents
  ├─ node.skillIds[]   → GET /api/skills → upsert local skills
  ├─ node.mcpServers[] → upsert local mcp_servers (remote type)
  └─ node.taskSources[]→ auto-create local task_sources
```

### Resource Naming

Enterprise-synced resources use the `wf_` prefix to avoid conflicts with user-created resources.

### User Assignment

- If the user is assigned to specific org nodes, only those nodes' resources are synced
- If no specific assignment, all nodes are synced (admin mode)

### Result

```typescript
interface EnterpriseSyncResult {
  agents: { created: number; updated: number }
  skills: { created: number; updated: number }
  mcpServers: { created: number; updated: number }
  taskSources: { created: number; updated: number }
  errors: string[]
}
```

---

## Peakflo Plugin — Task Sync

**File:** `src/main/plugins/peakflo-plugin.ts`

The plugin operates in two modes:

### Enterprise Mode (REST API)

Used when connected to pf-workflo. Detected by `config.enterprise_mode || ctx.workfloApiClient`.

**Import flow:**
1. Paginated fetch: `apiClient.listTasks({ status, page, pageSize, myTasks: true })`
2. For each task:
   - Map status: `completed` → `Completed`, `in_progress` → `Triaging`, `pending`/other → `NotStarted`
   - Map priority: `urgent` → `critical`, `high`/`medium`/`low` pass through
   - Extract fields from `taskData.fields`, map outputs from `taskData.outputs`
   - Build markdown description with fields table
   - Upsert by `(source_id, external_id)` — create or update
   - Queue file download jobs for fields with `type: 'file'`
3. After sync loop: download files sequentially (no fire-and-forget races)

### Legacy MCP Mode

Used without enterprise connection. Calls MCP tools directly:
- `task_list` — Fetch tasks with pagination
- `task_complete` — Execute approve/reject actions
- `users_list` — Fetch assignable users

### Status Mapping

| Workflo Status | 20x Status |
|---------------|------------|
| `pending` | `NotStarted` |
| `in_progress` | `Triaging` |
| `completed` | `Completed` |
| `cancelled` | `NotStarted` |
| `expired` | `NotStarted` |

### Priority Mapping

| Workflo Priority | 20x Priority |
|-----------------|-------------|
| `urgent` | `critical` |
| `high` | `high` |
| `medium` | `medium` |
| `low` | `low` |

---

## File Downloads

**File:** `src/main/plugins/peakflo-plugin.ts` → `downloadWorkfloFiles()`

Files are downloaded from pf-workflo storage via the API client and saved as local attachments.

### Flow

1. Scan task fields for `type: 'file'` entries
2. Each file field value is a `FileDataTypeValue`: `{ path, originalName, size, mimeType }`
3. Check `workflo_path` on existing attachments to skip re-downloads
4. Download via `apiClient.downloadFile(path)` → returns `{ buffer, contentType }`
5. Save to `{attachmentsDir}/{uuid}-{originalName}`
6. Add `FileAttachmentRecord` with `workflo_path` tracking to prevent duplicates

### File Attachment Record

```typescript
interface FileAttachmentRecord {
  id: string          // UUID
  filename: string    // Original filename
  size: number        // Bytes
  mime_type: string   // MIME type
  added_at: string    // ISO timestamp
  workflo_path?: string  // pf-workflo storage path (for dedup)
}
```

### Sequential Downloads

File downloads are queued during the sync loop and executed sequentially after the loop completes:

```typescript
const fileDownloadJobs: Array<{ taskId: string; fields: PeakfloField[] }> = []
// ... sync loop queues jobs ...
// After sync:
for (const job of fileDownloadJobs) {
  await this.downloadWorkfloFiles(job.taskId, job.fields, apiClient, ctx)
}
```

This prevents race conditions with concurrent database writes during sync.

---

## Two-Way Sync

### Export Updates (20x → Workflo)

When a user edits a task in 20x, changes are pushed back:

```typescript
async exportUpdate(task, changedFields, config, ctx) {
  // Fields exported: title, description, priority, due_date
  // Status is NOT exported (20x statuses don't map to workflo)
  await ctx.workfloApiClient.updateTask(task.external_id, updateData)
}
```

### Action Execution (Approve/Reject)

Tasks with `output_fields` support approve/reject actions:

```typescript
async executeAction(actionId, task, input, config, ctx) {
  const outputs = { action: actionId, ...outputFieldValues }
  if (input) outputs.reason = input  // Rejection reason
  await ctx.workfloApiClient.executeAction(task.external_id, outputs)
  return { success: true, taskUpdate: { status: TaskStatus.Completed } }
}
```

### User Listing

```typescript
async getUsers(config, ctx) {
  // MCP mode only — calls users_list tool
  // Enterprise mode: users come from org node userIds
}
```

### Task Reassignment

```typescript
async reassignTask(task, userIds, config, ctx) {
  // Enterprise: calls apiClient.reassignTask()
  // MCP: calls task_reassign tool
}
```

---

## Plugin Configuration

### Config Schema

```typescript
{
  status_filter: 'pending' | 'in_progress' | 'all'  // Default: 'pending'
  auto_sync_interval: number  // Minutes, 0 = manual only
}
```

### Enterprise Detection

Enterprise mode is active when:
- `config.enterprise_mode === true`, OR
- `ctx.workfloApiClient` is available (injected by enterprise auth)

In enterprise mode, `requiresMcpServer = false` — no MCP server configuration is needed.

---

## Data Model (Local SQLite)

### `task_sources` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | cuid2 |
| `mcp_server_id` | TEXT FK | Linked MCP server (legacy mode) |
| `name` | TEXT | Display name, also used as `task.source` |
| `list_tool` | TEXT | MCP tool for listing tasks |
| `list_tool_args` | TEXT (JSON) | Static args for list tool |
| `update_tool` | TEXT | MCP tool for updating tasks (optional) |
| `update_tool_args` | TEXT (JSON) | Static args for update tool |
| `last_synced_at` | TEXT | ISO timestamp of last sync |
| `enabled` | INTEGER | 1 = active |

### Task Columns

| Column | Type | Description |
|--------|------|-------------|
| `external_id` | TEXT | Task ID in workflo/external system |
| `source_id` | TEXT FK → task_sources | Which source imported this task |
| `source` | TEXT | Source display name (e.g., "Peakflo") |
| `workflo_path` | TEXT | On `FileAttachmentRecord`: tracks storage path for dedup |

Unique index on `(source_id, external_id)` prevents duplicates.

---

## End-to-End Sync Flow

```
1. User connects to enterprise (Settings > Enterprise > Sign In)
   └─ EnterpriseAuth stores JWT

2. User clicks "Sync" (or auto-sync fires)
   ├─ EnterpriseSyncManager.syncAll()
   │   ├─ GET /api/org-nodes → upsert agents, skills, MCP servers, task sources
   │   └─ GET /api/skills → upsert skills
   └─ SyncManager.importTasks(sourceId)
       └─ PeakfloPlugin.importTasksEnterprise()
           ├─ GET /api/tasks?myTasks=true (paginated)
           ├─ Upsert tasks by (source_id, external_id)
           └─ Download file attachments (sequential, post-loop)

3. User edits a task locally
   └─ PeakfloPlugin.exportUpdate()
       └─ PATCH /api/tasks/{id} (title, description, priority, due_date)

4. User clicks "Approve" or "Reject"
   └─ PeakfloPlugin.executeAction()
       └─ POST /api/tasks/{id}/action { action, outputs, reason? }
       └─ Task marked Completed locally

5. pf-workflo receives completion
   └─ TaskSyncService.completeExternalTask()
       └─ Propagates to external source (Notion, etc.) if configured
```

---

## Error Handling

- Import errors are collected per-task and returned in `result.errors[]` (sync continues)
- File download failures are caught per-file and logged (don't fail the sync)
- Enterprise API errors include the HTTP status and response body
- MCP tool errors check both `callResult.success` and `res.isError` for application-level failures
