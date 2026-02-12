import type { DatabaseManager, TaskRecord } from './database'
import type { McpToolCaller } from './mcp-tool-caller'
import type { PluginRegistry } from './plugins/registry'
import type { PluginContext, PluginSyncResult, ActionResult } from './plugins/types'
import type { SourceUser, ReassignResult } from '../shared/types'

export interface SyncResult {
  source_id: string
  imported: number
  updated: number
  errors: string[]
}

export class SyncManager {
  constructor(
    private db: DatabaseManager,
    private toolCaller: McpToolCaller,
    private pluginRegistry: PluginRegistry
  ) {}

  private buildContext(mcpServerId?: string): PluginContext {
    const mcpServer = mcpServerId ? this.db.getMcpServer(mcpServerId) : undefined
    return { db: this.db, toolCaller: this.toolCaller, mcpServer }
  }

  async importTasks(sourceId: string): Promise<SyncResult> {
    const result: SyncResult = { source_id: sourceId, imported: 0, updated: 0, errors: [] }

    const source = this.db.getTaskSource(sourceId)
    if (!source) {
      result.errors.push('Task source not found')
      console.error('[sync] Task source not found:', sourceId)
      return result
    }

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin) {
      result.errors.push(`Plugin "${source.plugin_id}" not found`)
      console.error('[sync] Plugin not found:', source.plugin_id)
      return result
    }

    const ctx = this.buildContext(source.mcp_server_id)
    console.log('[sync] Importing from:', source.name)

    // Merge legacy columns into config for backward compat
    const config = this.getConfig(source)

    try {
      const pluginResult: PluginSyncResult = await plugin.importTasks(sourceId, config, ctx)
      result.imported = pluginResult.imported
      result.updated = pluginResult.updated
      result.errors = pluginResult.errors
      console.log('[sync] Result:', { imported: result.imported, updated: result.updated, errors: result.errors })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Import failed'
      result.errors.push(msg)
      console.error('[sync] Import error:', err)
    }

    return result
  }

  async exportTaskUpdate(taskId: string, changedFields: Record<string, unknown>): Promise<void> {
    const task = this.db.getTask(taskId)
    if (!task?.source_id || !task.external_id) return

    const source = this.db.getTaskSource(task.source_id)
    if (!source) return

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin) return

    const ctx = this.buildContext(source.mcp_server_id)
    const config = this.getConfig(source)

    await plugin.exportUpdate(task, changedFields, config, ctx)
  }

  async executeAction(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    sourceId: string
  ): Promise<ActionResult> {
    const source = this.db.getTaskSource(sourceId)
    if (!source) return { success: false, error: 'Task source not found' }

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin) return { success: false, error: `Plugin "${source.plugin_id}" not found` }

    const ctx = this.buildContext(source.mcp_server_id)
    const config = this.getConfig(source)

    const result = await plugin.executeAction(actionId, task, input, config, ctx)

    // Apply local task updates if action succeeded
    if (result.success && result.taskUpdate && Object.keys(result.taskUpdate).length > 0) {
      this.db.updateTask(task.id, result.taskUpdate)
    }

    return result
  }

  async getSourceUsers(sourceId: string): Promise<SourceUser[]> {
    const source = this.db.getTaskSource(sourceId)
    if (!source) return []

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin?.getUsers) return []

    const ctx = this.buildContext(source.mcp_server_id)
    const config = this.getConfig(source)
    return plugin.getUsers(config, ctx)
  }

  async reassignTask(
    taskId: string,
    userIds: string[],
    assigneeDisplay: string
  ): Promise<ReassignResult> {
    const task = this.db.getTask(taskId)
    if (!task?.source_id || !task.external_id) {
      return { success: false, error: 'Task not found or not linked to a source' }
    }

    const source = this.db.getTaskSource(task.source_id)
    if (!source) return { success: false, error: 'Task source not found' }

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin?.reassignTask) {
      return { success: false, error: 'Plugin does not support reassignment' }
    }

    const ctx = this.buildContext(source.mcp_server_id)
    const config = this.getConfig(source)

    const result = await plugin.reassignTask(task, userIds, config, ctx)
    if (result.success) {
      this.db.updateTask(taskId, { assignee: assigneeDisplay })
    }
    return result
  }

  private getConfig(source: { config: Record<string, unknown> }): Record<string, unknown> {
    return { ...source.config }
  }
}
