import type { DatabaseManager, TaskRecord } from './database'
import type { McpToolCaller } from './mcp-tool-caller'
import type { PluginRegistry } from './plugins/registry'
import type { PluginContext, PluginSyncResult, ActionResult } from './plugins/types'

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
      return result
    }

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin) {
      result.errors.push(`Plugin "${source.plugin_id}" not found`)
      return result
    }

    const ctx = this.buildContext(source.mcp_server_id)

    // Merge legacy columns into config for backward compat
    const config = this.getConfig(source)

    try {
      const pluginResult: PluginSyncResult = await plugin.importTasks(sourceId, config, ctx)
      result.imported = pluginResult.imported
      result.updated = pluginResult.updated
      result.errors = pluginResult.errors
    } catch (err: any) {
      result.errors.push(err?.message || 'Import failed')
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

  private getConfig(source: { config: Record<string, unknown> }): Record<string, unknown> {
    return { ...source.config }
  }
}
