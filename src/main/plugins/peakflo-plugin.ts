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
import type { TaskRecord } from '../database'
import { TaskStatus } from '../../shared/constants'

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

/** Peakflo field names use camelCase; map to our snake_case */
function mapPeakfloTask(raw: any): MappedTask | null {
  const id = raw.taskId || raw.id
  const title = raw.title || raw.name
  if (!id || !title) return null

  return {
    external_id: String(id),
    title: String(title),
    description: raw.description != null ? String(raw.description) : undefined,
    type: raw.type === 'approval' ? 'approval' : 'general',
    priority: PRIORITY_MAP[raw.priority] ?? 'medium',
    status: STATUS_MAP[raw.status] ?? TaskStatus.NotStarted,
    assignee: raw.assignedTo
      ? Array.isArray(raw.assignedTo) ? raw.assignedTo.join(', ') : String(raw.assignedTo)
      : undefined,
    due_date: raw.dueDate ?? raw.due_date ?? null,
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : undefined
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
            ctx.db.updateTask(existing.id, {
              title: mapped.title,
              description: mapped.description,
              type: mapped.type,
              priority: mapped.priority,
              status: mapped.status,
              assignee: mapped.assignee,
              due_date: mapped.due_date,
              labels: mapped.labels
            })
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
              external_id: mapped.external_id,
              source_id: sourceId,
              source: sourceName
            })
            result.imported++
          }
        } catch (err: any) {
          result.errors.push(`Task ${mapped.external_id}: ${err?.message || 'Unknown error'}`)
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

    const action = actionId === 'approve' ? 'approved' : actionId === 'reject' ? 'rejected' : actionId

    const outputs: Record<string, unknown> = { action }
    if (input) outputs.reason = input

    const callResult = await ctx.toolCaller.callTool(ctx.mcpServer, 'task_complete', {
      taskId: task.external_id,
      outputs: JSON.stringify(outputs)
    })
    if (!callResult.success) {
      return { success: false, error: callResult.error || 'Action failed' }
    }

    const taskUpdate: Record<string, unknown> =
      actionId === 'approve'
        ? { status: TaskStatus.Completed }
        : actionId === 'reject'
          ? { status: TaskStatus.NotStarted }
          : {}

    return { success: true, taskUpdate }
  }

  // ── Response parsing ──────────────────────────────────────

  private parseResponse(result: unknown): { tasks: any[]; total?: number } {
    if (!result) return { tasks: [] }

    // MCP content wrapper
    const content = (result as any)?.content
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

  private extractTasks(data: unknown): { tasks: any[]; total?: number } {
    if (Array.isArray(data)) return { tasks: data }
    if (data && typeof data === 'object') {
      const obj = data as any
      const tasks = obj.tasks ?? obj.items ?? []
      return { tasks: Array.isArray(tasks) ? tasks : [], total: obj.total }
    }
    return { tasks: [] }
  }
}
