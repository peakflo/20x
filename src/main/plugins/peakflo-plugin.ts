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
}
