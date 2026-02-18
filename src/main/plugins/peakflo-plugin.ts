import type {
  TaskSourcePlugin,
  PluginConfigSchema,
  ConfigFieldOption,
  PluginContext,
  FieldMapping,
  PluginAction,
  PluginSyncResult,
  ActionResult
} from './types'
import type { TaskRecord, OutputFieldRecord } from '../database'
import type { SourceUser, ReassignResult } from '../../shared/types'
import { TaskStatus } from '../../shared/constants'

// ── Peakflo API response shapes ─────────────────────────────

interface PeakfloAssignee {
  assigneeType: string
  assigneeValue: string
}

interface PeakfloField {
  id: string
  type?: string
  label?: string
  value?: unknown
  options?: unknown[]
  required?: boolean
  multiple?: boolean
}

interface PeakfloOutput {
  id: string
  name?: string
  type?: string
}

interface PeakfloRawTask {
  taskId?: string
  id?: string
  title?: string
  name?: string
  description?: string
  type?: string
  priority?: string
  status?: string
  assignedTo?: string | string[]
  assignees?: PeakfloAssignee[]
  dueDate?: string
  due_date?: string
  labels?: string[]
  taskData?: {
    fields?: PeakfloField[]
    outputs?: PeakfloOutput[]
  }
}

interface McpContentItem {
  type: string
  text?: string
}

interface McpResult {
  content?: McpContentItem[]
  isError?: boolean
}

interface PeakfloRawUser {
  id?: string
  userId?: string
  email?: string
  name?: string
  displayName?: string
}

/** Maps Peakflo priority → local priority */
const PRIORITY_MAP: Record<string, string> = {
  urgent: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low'
}

/** Maps Peakflo status → local status */
const STATUS_MAP: Record<string, TaskStatus> = {
  pending: TaskStatus.NotStarted,
  in_progress: TaskStatus.NotStarted,
  completed: TaskStatus.Completed,
  cancelled: TaskStatus.NotStarted,
  expired: TaskStatus.NotStarted
}

/** Extract assignee display string from structured assignees array or legacy assignedTo */
function extractAssignee(raw: PeakfloRawTask): string | undefined {
  if (Array.isArray(raw.assignees) && raw.assignees.length > 0) {
    const email = raw.assignees.find((a) => a.assigneeType === 'email')
    if (email) return String(email.assigneeValue)
    return String(raw.assignees[0].assigneeValue)
  }
  if (raw.assignedTo) {
    return Array.isArray(raw.assignedTo) ? raw.assignedTo.join(', ') : String(raw.assignedTo)
  }
  return undefined
}

/** Peakflo field names use camelCase; map to our snake_case */
function mapPeakfloTask(raw: PeakfloRawTask): MappedTask | null {
  const id = raw.taskId || raw.id
  const title = raw.title || raw.name
  if (!id || !title) return null

  const fields: PeakfloField[] = raw.taskData?.fields ?? []
  const outputs: PeakfloOutput[] = raw.taskData?.outputs ?? []

  // Map taskData.outputs → output_fields, enriched with options/values from fields
  const fieldsById = new Map(fields.map((f) => [f.id, f]))
  const outputFields: OutputFieldRecord[] = outputs.map((o) => {
    const field = fieldsById.get(o.id)
    return {
      id: String(o.id ?? ''),
      name: String(o.name ?? o.id ?? ''),
      type: o.type === 'string' && field?.options ? 'list' : (o.type ?? 'text'),
      value: field?.value,
      options: Array.isArray(field?.options) ? field.options.map(String) : undefined,
      required: field?.required ?? false,
      multiple: field?.multiple ?? false
    }
  })

  if (outputFields.length > 0) {
    console.log('[peakflo] mapped output_fields for', title, ':', JSON.stringify(outputFields))
  }

  // Build description from non-action data fields
  const descParts: string[] = []
  if (raw.description) descParts.push(String(raw.description))
  for (const f of fields) {
    if (f.id === 'action' || f.value == null || f.value === '') continue
    descParts.push(`**${f.label ?? f.id}**\n${f.value}`)
  }

  return {
    external_id: String(id),
    title: String(title),
    description: descParts.length > 0 ? descParts.join('\n\n') : undefined,
    type: raw.type === 'approval' ? 'approval' : 'general',
    priority: (raw.priority && PRIORITY_MAP[raw.priority]) ?? 'medium',
    status: (raw.status && STATUS_MAP[raw.status]) ?? TaskStatus.NotStarted,
    assignee: extractAssignee(raw),
    due_date: raw.dueDate ?? raw.due_date ?? null,
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : undefined,
    output_fields: outputFields.length > 0 ? outputFields : undefined
  }
}


interface MappedTask {
  external_id: string
  title: string
  description?: string
  type?: string
  priority?: string
  status?: string
  assignee?: string
  due_date?: string | null
  labels?: string[]
  output_fields?: OutputFieldRecord[]
}

export class PeakfloPlugin implements TaskSourcePlugin {
  id = 'peakflo'
  displayName = 'Peakflo Workflo'
  description = 'Import and manage tasks from Peakflo Workflo platform'
  icon = 'Zap'
  requiresMcpServer = true

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: 'status_filter',
        label: 'Status Filter',
        type: 'select',
        default: 'pending',
        options: [
          { value: 'pending', label: 'Pending' },
          { value: 'in_progress', label: 'In Progress' },
          { value: 'all', label: 'All' }
        ]
      },
      {
        key: 'auto_sync_interval',
        label: 'Auto-sync Interval (minutes)',
        type: 'number',
        default: 0,
        description: '0 = manual sync only'
      }
    ]
  }

  async resolveOptions(): Promise<ConfigFieldOption[]> {
    return []
  }

  validateConfig(): string | null {
    return null
  }

  getFieldMapping(): FieldMapping {
    return {
      external_id: 'taskId|id',
      title: 'title|name',
      description: 'description',
      type: 'type',
      priority: 'priority',
      status: 'status',
      assignee: 'assignedTo',
      due_date: 'dueDate',
      labels: 'labels'
    }
  }

  getActions(): PluginAction[] {
    return [
      {
        id: 'approve',
        label: 'Approve',
        icon: 'CheckCircle',
        variant: 'default'
      },
      {
        id: 'reject',
        label: 'Reject',
        icon: 'XCircle',
        variant: 'destructive',
        requiresInput: true,
        inputLabel: 'Rejection reason',
        inputPlaceholder: 'Enter reason for rejection...'
      }
    ]
  }

  async importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }

    if (!ctx.mcpServer) {
      result.errors.push('MCP server not found')
      return result
    }

    const statusFilter = (config.status_filter as string) || 'pending'
    const source = ctx.db.getTaskSource(sourceId)
    const sourceName = source?.name ?? 'Peakflo'

    // Paginated fetch
    let offset = 0
    const limit = 100
    let hasMore = true

    while (hasMore) {
      const args: Record<string, unknown> = { limit, offset }
      if (statusFilter !== 'all') args.status = statusFilter

      const callResult = await ctx.toolCaller.callTool(ctx.mcpServer, 'task_list', args)
      if (!callResult.success) {
        result.errors.push(callResult.error || 'task_list call failed')
        break
      }

      const response = this.parseResponse(callResult.result)
      const tasks = response.tasks

      for (const raw of tasks) {
        const mapped = mapPeakfloTask(raw)
        if (!mapped) continue

        try {
          const existing = ctx.db.getTaskByExternalId(sourceId, mapped.external_id)
          if (existing) {
            const update: Record<string, unknown> = {
              title: mapped.title,
              description: mapped.description,
              type: mapped.type,
              priority: mapped.priority,
              status: mapped.status,
              due_date: mapped.due_date,
              labels: mapped.labels,
              output_fields: mapped.output_fields
            }
            // Only overwrite assignee if server provided it
            if (mapped.assignee !== undefined) update.assignee = mapped.assignee
            ctx.db.updateTask(existing.id, update)
            result.updated++
          } else {
            ctx.db.createTask({
              title: mapped.title,
              description: mapped.description,
              type: mapped.type ?? 'general',
              priority: mapped.priority ?? 'medium',
              status: mapped.status ?? TaskStatus.NotStarted,
              assignee: mapped.assignee,
              due_date: mapped.due_date,
              labels: mapped.labels,
              output_fields: mapped.output_fields,
              external_id: mapped.external_id,
              source_id: sourceId,
              source: sourceName
            })
            result.imported++
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          result.errors.push(`Task ${mapped.external_id}: ${msg}`)
        }
      }

      // Check if there are more pages
      if (tasks.length < limit || (response.total != null && offset + limit >= response.total)) {
        hasMore = false
      } else {
        offset += limit
      }
    }

    ctx.db.updateTaskSourceLastSynced(sourceId)
    return result
  }

  async exportUpdate(
    _task: TaskRecord,
    _changedFields: Record<string, unknown>,
    _config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<void> {
    // Peakflo uses action-based completion, not field updates
    // Export is a no-op; use executeAction instead
  }

  async executeAction(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    _config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ActionResult> {
    if (!ctx.mcpServer || !task.external_id) {
      return { success: false, error: 'Missing MCP server or external task ID' }
    }

    // Build outputs from all output_fields with values
    const outputs: Record<string, unknown> = {}
    for (const field of task.output_fields) {
      if (field.value !== undefined && field.value !== null && field.value !== '') {
        outputs[field.id] = field.value
      }
    }
    // Override action with the explicitly passed actionId
    outputs.action = actionId
    if (input) outputs.reason = input

    const args = {
      taskId: task.external_id,
      outputs
    }
    console.log('[peakflo] task_complete request:', JSON.stringify(args))

    const callResult = await ctx.toolCaller.callTool(ctx.mcpServer, 'task_complete', args)
    console.log('[peakflo] task_complete response:', JSON.stringify(callResult))

    if (!callResult.success) {
      return { success: false, error: callResult.error || 'Action failed' }
    }

    // Check for application-level errors in the MCP response content
    const res = callResult.result as McpResult | undefined
    if (res?.isError) {
      const errText = this.extractContentText(res)
      return { success: false, error: errText || 'Action failed' }
    }
    const contentText = this.extractContentText(res)
    if (contentText) {
      try {
        const parsed = JSON.parse(contentText)
        if (parsed.error) {
          return { success: false, error: String(parsed.error) }
        }
      } catch {
        // Not JSON, that's fine
      }
    }

    return { success: true, taskUpdate: { status: TaskStatus.Completed } }
  }

  async getUsers(
    _config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<SourceUser[]> {
    if (!ctx.mcpServer) return []

    const callResult = await ctx.toolCaller.callTool(ctx.mcpServer, 'users_list', {})
    if (!callResult.success) return []

    const text = this.extractContentText(callResult.result as McpResult | undefined)
    if (!text) return []

    try {
      const parsed = JSON.parse(text)
      const users: PeakfloRawUser[] = Array.isArray(parsed) ? parsed : (parsed.users ?? parsed.items ?? [])
      return users
        .filter((u) => u.id || u.userId)
        .map((u) => ({
          id: String(u.id ?? u.userId),
          email: String(u.email ?? ''),
          name: String(u.name ?? u.displayName ?? u.email ?? '')
        }))
    } catch {
      return []
    }
  }

  async reassignTask(
    task: TaskRecord,
    userIds: string[],
    _config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ReassignResult> {
    if (!ctx.mcpServer || !task.external_id) {
      return { success: false, error: 'Missing MCP server or external task ID' }
    }

    const assignees = userIds.map((id) => ({
      assigneeType: 'user',
      assigneeValue: id
    }))

    const callResult = await ctx.toolCaller.callTool(ctx.mcpServer, 'task_update', {
      taskId: task.external_id,
      assignees: JSON.stringify(assignees)
    })

    if (!callResult.success) {
      return { success: false, error: callResult.error || 'Reassign failed' }
    }

    const res = callResult.result as McpResult | undefined
    if (res?.isError) {
      const errText = this.extractContentText(res)
      return { success: false, error: errText || 'Reassign failed' }
    }

    const contentText = this.extractContentText(res)
    if (contentText) {
      try {
        const parsed = JSON.parse(contentText)
        if (parsed.error) return { success: false, error: String(parsed.error) }
      } catch {
        // Not JSON, fine
      }
    }

    return { success: true }
  }

  // ── Content helpers ──────────────────────────────────────

  private extractContentText(result: McpResult | undefined): string | null {
    const content = result?.content
    if (!Array.isArray(content)) return null
    for (const item of content) {
      if (item.type === 'text' && typeof item.text === 'string') return item.text
    }
    return null
  }

  // ── Response parsing ──────────────────────────────────────

  private parseResponse(result: unknown): { tasks: PeakfloRawTask[]; total?: number } {
    if (!result) return { tasks: [] }

    // MCP content wrapper
    const content = (result as McpResult | undefined)?.content
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === 'text' && typeof item.text === 'string') {
          try {
            const parsed = JSON.parse(item.text)
            return this.extractTasks(parsed)
          } catch {
            continue
          }
        }
      }
    }

    return this.extractTasks(result)
  }

  private extractTasks(data: unknown): { tasks: PeakfloRawTask[]; total?: number } {
    if (Array.isArray(data)) return { tasks: data }
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>
      const tasks = (obj.tasks ?? obj.items ?? []) as unknown
      return { tasks: Array.isArray(tasks) ? tasks : [], total: obj.total as number | undefined }
    }
    return { tasks: [] }
  }

  /**
   * Returns markdown documentation for setting up Peakflo Workflows integration
   */
  getSetupDocumentation(): string {
    return `# Peakflo Workflows Integration Setup Guide

## Overview

Connect Peakflo Workflows to import and manage approval tasks. This integration requires an MCP server to communicate with Peakflo's API.

## Prerequisites

- A Peakflo account with Workflows access
- API credentials from Peakflo
- An MCP server configured for Peakflo

---

## Setup Steps

### Step 1: Set up the MCP Server

Before creating a Peakflo task source, you need an MCP server that can communicate with Peakflo's API.

1. Go to **Settings** → **MCP Servers**
2. Click **Add Server**
3. Configure the Peakflo MCP server:
   - **Name**: \`Peakflo MCP\`
   - **Type**: Select appropriate server type
   - **Configuration**: Add your Peakflo API connection details

### Step 2: Get Peakflo API Credentials

1. Log in to your [Peakflo account](https://app.peakflo.co)
2. Go to **Settings** → **API & Integrations**
3. Generate an API key if you don't have one
4. Copy the **API Key**
5. Optionally, copy your **Organization ID** for filtering

### Step 3: Create the Task Source

1. Select **Peakflo Workflo** as the plugin
2. Choose the MCP server you configured in Step 1
3. Give your source a name (e.g., "Peakflo Approvals")

### Step 4: Configure API Settings

Fill in the configuration form:

- **API Key**: Paste your Peakflo API key
- **Organization ID** (Optional): Filter tasks by organization
- **Status Filter**: Choose which tasks to sync:
  - **Pending**: Only pending approval tasks
  - **In Progress**: Tasks being worked on
  - **All**: Sync all tasks regardless of status
- **Auto-sync Interval**: Set to 0 for manual sync, or specify minutes for automatic syncing

### Step 5: Save and Sync

1. Click **Add** to save the task source
2. Click **Sync Now** to import tasks from Peakflo
3. Your workflow tasks will appear in the task list

---

## Features

### Import Workflow Tasks
- Automatically imports tasks from Peakflo Workflows
- Supports approval workflows and manual tasks
- Maps Peakflo fields to task properties:
  - Task ID → External ID
  - Title/Name → Title
  - Description → Description
  - Priority (urgent, high, medium, low)
  - Status (pending, in_progress, completed, cancelled, expired)
  - Assignee information
  - Due dates
  - Labels/tags

### Task Actions
Peakflo tasks support workflow-specific actions:

- **Approve**: Approve a pending task
- **Reject**: Reject a task with a reason
- **Complete**: Mark task as completed with output fields

### Output Fields
Many Peakflo tasks have structured output fields:

- **Form fields**: Text, select, checkbox inputs
- **Action buttons**: Approve/Reject options
- **Custom fields**: Defined by your workflow

These fields are rendered dynamically based on the task type.

### Pagination
The integration automatically handles pagination for large task lists, fetching up to 100 tasks per request.

---

## Status Mapping

Peakflo status maps to task status:

| Peakflo Status | Task Status |
|----------------|-------------|
| pending | Not Started |
| in_progress | Not Started |
| completed | Completed |
| cancelled | Not Started |
| expired | Not Started |

---

## Priority Mapping

| Peakflo Priority | Task Priority |
|------------------|---------------|
| urgent | Critical |
| high | High |
| medium | Medium |
| low | Low |

---

## Troubleshooting

### MCP Server not available
- Ensure you've created an MCP server first (Settings → MCP Servers)
- Test the MCP server connection before creating the task source
- Check that the server has the required Peakflo tools (\`task_list\`, \`task_complete\`)

### No tasks importing
- Verify your API key is correct and has proper permissions
- Check the status filter - you might be filtering out all tasks
- Ensure you have tasks in Peakflo that match your filters
- Try clicking **Sync Now** to force a manual sync

### "API key invalid" error
- Double-check your API key from Peakflo settings
- Ensure there are no extra spaces or characters
- Regenerate the API key if needed

### Organization filter not working
- Verify the Organization ID is correct
- Leave the Organization ID empty to sync all organizations
- Check that you have permission to access the specified organization

### Actions not working
- Ensure the task has the required output fields filled in
- For rejection, provide a reason when prompted
- Check that your API key has write permissions

### Auto-sync not triggering
- Auto-sync interval must be greater than 0
- The value is in minutes (e.g., 15 = sync every 15 minutes)
- Manual sync always works regardless of this setting

---

## MCP Server Configuration

The Peakflo MCP server must expose these tools:

### Required Tools

**\`task_list\`**: Fetch tasks from Peakflo
- Parameters: \`limit\`, \`offset\`, \`status\` (optional)
- Returns: Array of task objects with required fields

**\`task_complete\`**: Complete a task with outputs
- Parameters: \`taskId\`, \`outputs\` (object with field values)
- Returns: Success/error response

### Optional Tools

**\`users_list\`**: Fetch available users for assignment
- Returns: Array of user objects

**\`task_update\`**: Update task assignees or other fields
- Parameters: \`taskId\`, \`assignees\`, etc.

---

## Support

For more help:
- [Peakflo Workflows Documentation](https://docs.peakflo.co/workflows)
- [Peakflo API Reference](https://docs.peakflo.co/api)
- Contact your Peakflo account manager for API access
`
  }
}
