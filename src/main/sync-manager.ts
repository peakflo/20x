import { randomUUID } from 'crypto'
import { serverTaskFields, saveServerTaskSnapshot, serverTaskSnapshot } from './workflo-task-sync'
import type { DatabaseManager, TaskRecord } from './database'
import type { EnterpriseStateSync } from './enterprise-state-sync'
import type { McpToolCaller } from './mcp-tool-caller'
import type { PluginRegistry } from './plugins/registry'
import type { OAuthManager } from './oauth/oauth-manager'
import type { PluginContext, PluginSyncResult, ActionResult } from './plugins/types'
import type { WorkfloApiClient } from './workflo-api-client'
import type { EnterpriseSyncManager } from './enterprise-sync'
import type { SourceUser, ReassignResult } from '../shared/types'

export interface SyncResult {
  source_id: string
  imported: number
  updated: number
  errors: string[]
}

export class SyncManager {
  private workfloApiClient?: WorkfloApiClient
  private enterpriseSyncManager?: EnterpriseSyncManager
  private enterpriseStateSync?: EnterpriseStateSync
  private enterpriseUserId?: string
  private uploadInFlight = false
  private updateInFlight = false
  private completionInFlight = false

  constructor(
    private db: DatabaseManager,
    private toolCaller: McpToolCaller,
    private pluginRegistry: PluginRegistry,
    private oauthManager?: OAuthManager
  ) {
  }

  /**
   * Set the enterprise connection for REST API-based task import.
   * Called when enterprise auth succeeds (selectTenant).
   */
  setEnterpriseConnection(
    apiClient: WorkfloApiClient,
    syncManager: EnterpriseSyncManager,
    userId: string,
    stateSync?: EnterpriseStateSync
  ): void {
    this.workfloApiClient = apiClient
    this.enterpriseSyncManager = syncManager
    this.enterpriseUserId = userId
    this.enterpriseStateSync = stateSync
    const scope = this.taskUploadScope()
    if (scope) this.db.setSetting('workflo-sync-scope', scope)
    let source = this.db.getTaskSources().find(s => s.plugin_id === 'peakflo' && s.config?.unified_scope === scope)
    if (!source && scope) source = this.db.createTaskSource({
      name: '[Workflo] My tasks', plugin_id: 'peakflo', mcp_server_id: null,
      config: { enterprise_mode: true, unified_scope: scope },
      list_tool: '', list_tool_args: {}, update_tool: '', update_tool_args: {}
    })
    if (source) void this.importTasks(source.id)
    else void this.flushTaskUploads()
  }

  clearEnterpriseConnection(): void {
    this.workfloApiClient = undefined
    this.enterpriseSyncManager = undefined
    this.enterpriseStateSync = undefined
    this.enterpriseUserId = undefined
  }

  /**
   * Trigger enterprise resource sync (agents, skills, MCP servers) on demand.
   * Returns the sync result or null if enterprise is not connected.
   */
  async syncEnterpriseResources(): Promise<import('./enterprise-sync').EnterpriseSyncResult | null> {
    if (!this.enterpriseSyncManager || !this.enterpriseUserId) return null
    return this.enterpriseSyncManager.syncAll(this.enterpriseUserId)
  }

  private buildContext(mcpServerId?: string, sourceId?: string): PluginContext {
    const mcpServer = mcpServerId ? this.db.getMcpServer(mcpServerId) : undefined
    return {
      db: this.db,
      toolCaller: this.toolCaller,
      mcpServer,
      oauthManager: this.oauthManager,
      sourceId,
      workfloApiClient: this.workfloApiClient,
      enterpriseStateSync: this.enterpriseStateSync
    }
  }

  async importTasks(sourceId: string): Promise<SyncResult> {
    const result: SyncResult = { source_id: sourceId, imported: 0, updated: 0, errors: [] }

    const source = this.db.getTaskSource(sourceId)
    if (!source) {
      result.errors.push('Task source not found')
      console.error('[sync] Task source not found:', sourceId)
      return result
    }

    if (source.config?.unified_scope && source.config.unified_scope !== this.taskUploadScope()) {
      result.errors.push('This task source belongs to a different Workflo account or organization.')
      return result
    }
    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin) {
      result.errors.push(`Plugin "${source.plugin_id}" not found`)
      console.error('[sync] Plugin not found:', source.plugin_id)
      return result
    }

    await this.flushTaskUploads()
    await this.flushTaskUpdates()
    await this.flushTaskCompletions()
    const ctx = this.buildContext(source.mcp_server_id || undefined, sourceId)
    console.log('[sync] Importing from:', source.name)

    // Merge legacy columns into config for backward compat
    const config = this.getConfig(source)

    // Phase 2.4: re-sync agents/skills/MCP servers before each task import
    if (this.enterpriseSyncManager && this.enterpriseUserId) {
      try {
        console.log('[sync] Running enterprise resource sync before task import...')
        await this.enterpriseSyncManager.syncAll(this.enterpriseUserId)
      } catch (err: unknown) {
        console.error('[sync] Enterprise resource sync error (non-fatal):', err)
      }
    }

    try {
      const pluginResult: PluginSyncResult = await plugin.importTasks(sourceId, config, ctx)
      result.imported = pluginResult.imported
      result.updated = pluginResult.updated
      result.errors = pluginResult.errors
      console.log('[sync] Result:', { imported: result.imported, updated: result.updated, errors: result.errors })

      // Update last_synced_at timestamp for incremental sync
      this.db.updateTaskSourceLastSynced(sourceId)
      console.log('[sync] Updated last_synced_at for source:', sourceId)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Import failed'
      result.errors.push(msg)
      console.error('[sync] Import error:', err)
    }

    return result
  }

  /** A durable command, retried on reconnect and on each task sync. */
  async uploadTask(taskId: string, autonomous = false): Promise<{ queued: boolean }> {
    const task = this.db.getTask(taskId)
    if (!task || task.source_id || task.external_id) throw new Error('Only a local task can be sent to Workflo.')
    if (task.session_id || !['not_started', 'ready_for_review'].includes(task.status)) {
      throw new Error('Stop the local session before sending this task to Workflo.')
    }
    const scope = this.taskUploadScope()
    if (!scope) throw new Error('Connect to Workflo and select an organization first.')
    const key = `workflo-upload:${taskId}`
    if (!this.db.getSetting(key)) {
      const agent = task.agent_id ? this.db.getAgent(task.agent_id) : undefined
      const agentId = (agent?.config as Record<string, unknown> | undefined)?.enterprise_agent_id as string | undefined
      if (autonomous && !agentId) throw new Error('Select an agent from Workflo for autonomous work.')
      if (task.agent_id && !agentId) throw new Error('Select an agent from Workflo before sending this task.')
      const skills = (task.skill_ids ?? []).map(id => this.db.getSkill(id)?.enterprise_skill_id)
      if (skills.some(id => !id)) throw new Error('Sync the selected skills to Workflo first.')
      if (task.recurrence_pattern && typeof task.recurrence_pattern !== 'string') {
        throw new Error('Use a cron expression before sending this recurring task to Workflo.')
      }
      this.db.setSetting(key, JSON.stringify({ scope, taskId, data: {
        clientRequestId: `20x:${randomUUID()}`,
        title: task.title, description: task.description,
        agentId, skillIds: skills,
        // Selecting an agent for help does not transfer human ownership.
        assignees: autonomous ? [{ assigneeType: 'agent', assigneeValue: agentId }] : [{ assigneeType: 'user', assigneeValue: this.enterpriseUserId }],
        cron: task.is_recurring ? task.recurrence_pattern ?? undefined : undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        autoCompleteWithoutReview: autonomous && task.auto_complete_without_review
      } }))
    }
    this.db.updateTask(taskId, { auto_start_agent: false, is_recurring: false, recurrence_pattern: null, next_occurrence_at: null })
    await this.flushTaskUploads()
    return { queued: !!this.db.getSetting(key) }
  }

  canUploadTasks(): boolean { return !!this.taskUploadScope() }

  private taskUploadScope(): string | undefined {
    const tenant = this.db.getSetting('enterprise_tenant_id')
    if (!this.workfloApiClient || !this.enterpriseUserId || !tenant) return undefined
    return JSON.stringify([this.workfloApiClient.getDomain(), tenant, this.enterpriseUserId])
  }

  async flushTaskUploads(): Promise<void> {
    if (this.uploadInFlight || !this.workfloApiClient) return
    const scope = this.taskUploadScope()
    if (!scope) return
    this.uploadInFlight = true
    try {
      const settings = this.db.getAllSettings()
      for (const [key, value] of Object.entries(settings)) {
        if (!key.startsWith('workflo-upload:') || key.endsWith(':error')) continue
        const command = JSON.parse(value)
        if (command.scope !== scope) continue
        try {
          const local = this.db.getTask(command.taskId)
          if (!local) { this.db.deleteSetting(key); continue }
          const remote = await this.workfloApiClient.createTask(command.data)
          let source = this.db.getTaskSources().find(s => s.plugin_id === 'peakflo' && s.config?.unified_scope === scope)
          if (!source) source = this.db.createTaskSource({
            name: '[Workflo] My tasks', plugin_id: 'peakflo', mcp_server_id: null,
            config: { enterprise_mode: true, unified_scope: scope },
            list_tool: '', list_tool_args: {}, update_tool: '', update_tool_args: {}
          })
          if (!source) throw new Error('Could not create the Workflo task source.')
          saveServerTaskSnapshot(this.db, local.id, remote)
          this.db.updateTask(local.id, { ...serverTaskFields(this.db, remote),
            title: remote.title, description: remote.description ?? '', external_id: remote.id, source_id: source.id, source: source.name
          }, 'workflo-server')
          this.db.deleteSetting(key)
          this.db.deleteSetting(`${key}:error`)
        } catch (error) {
          // Retain the exact command and request ID after network failures.
          this.db.setSetting(`${key}:error`, error instanceof Error ? error.message : String(error))
        }
      }
    } finally { this.uploadInFlight = false }
  }

  async exportTaskUpdate(taskId: string, changedFields: Record<string, unknown>): Promise<void> {
    const task = this.db.getTask(taskId)
    if (!task?.source_id || !task.external_id) return

    const source = this.db.getTaskSource(task.source_id)
    if (!source) return

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin) return

    const fields = { ...changedFields }
    // Internal completion control — never a source field.
    delete fields.complete_at_source
    if (Object.keys(fields).length === 0) return

    const ctx = this.buildContext(source.mcp_server_id || undefined, task.source_id || undefined)
    const config = this.getConfig(source)

    if (source.plugin_id === 'peakflo' && this.workfloApiClient) {
      // Status is confirmed through task actions and server reads.
      delete fields.status
      const allowed = ['title', 'description', 'priority', 'due_date', 'agent_id', 'skill_ids']
      const edits = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.includes(key)))
      if (Object.keys(edits).length === 0) return
      const scope = this.taskUploadScope()
      if (!scope) throw new Error('Select a Workflo organization before editing this task.')
      const key = `workflo-update:${taskId}`
      const pending = this.db.getSetting(key)
      const previous = pending ? JSON.parse(pending) : undefined
      this.db.setSetting(key, JSON.stringify({ scope, taskId,
        expectedVersion: previous?.expectedVersion ?? serverTaskSnapshot(this.db, taskId)?.version,
        fields: { ...previous?.fields, ...edits }
      }))
      await this.flushTaskUpdates()
      return
    }
    await plugin.exportUpdate(task, fields, config, ctx)
  }

  async flushTaskUpdates(): Promise<void> {
    if (this.updateInFlight || !this.workfloApiClient) return
    const scope = this.taskUploadScope()
    if (!scope) return
    this.updateInFlight = true
    try {
      for (const [key, value] of Object.entries(this.db.getAllSettings())) {
        if (!key.startsWith('workflo-update:') || key.endsWith(':error')) continue
        const command = JSON.parse(value)
        if (command.scope !== scope) continue
        const task = this.db.getTask(command.taskId)
        const source = task?.source_id ? this.db.getTaskSource(task.source_id) : undefined
        if (!task || !source) continue
        const plugin = this.pluginRegistry.get(source.plugin_id)
        if (!plugin) continue
        try {
          await plugin.exportUpdate(task, { ...command.fields, __expectedVersion: command.expectedVersion },
            this.getConfig(source), this.buildContext(source.mcp_server_id || undefined, source.id))
          // Keep any edit that arrived while this request was in flight.
          if (this.db.getSetting(key) === value) this.db.deleteSetting(key)
          this.db.deleteSetting(`${key}:error`)
        } catch (error) {
          this.db.setSetting(`${key}:error`, error instanceof Error ? error.message : String(error))
        }
      }
    } finally { this.updateInFlight = false }
  }

  async flushTaskCompletions(): Promise<void> {
    if (this.completionInFlight || !this.workfloApiClient) return
    const scope = this.taskUploadScope()
    if (!scope) return
    this.completionInFlight = true
    try {
      for (const [key, value] of Object.entries(this.db.getAllSettings())) {
        if (!key.startsWith('workflo-completion:') || key.endsWith(':error')) continue
        const command = JSON.parse(value)
        if (command.scope !== scope) continue
        try {
          await this.workfloApiClient.executeAction(command.externalId, command.outputs, command.expectedVersion)
          const current = await this.workfloApiClient.getTask(command.externalId)
          saveServerTaskSnapshot(this.db, command.taskId, current)
          this.db.updateTask(command.taskId, serverTaskFields(this.db, current), 'workflo-server')
          if (current.status !== 'completed') throw new Error('The server has not confirmed completion.')
          this.db.deleteSetting(key)
          this.db.deleteSetting(`${key}:error`)
        } catch (error) {
          this.db.setSetting(`${key}:error`, error instanceof Error ? error.message : String(error))
        }
      }
    } finally { this.completionInFlight = false }
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

    if (source.plugin_id === 'peakflo') {
      const scope = this.taskUploadScope()
      const snapshot = serverTaskSnapshot(this.db, task.id)
      if (!scope || !snapshot?.version) return {success:false,error:'Sync this task with Workflo before completing it.'}
      const key = `workflo-completion:${task.id}`
      if (!this.db.getSetting(key)) {
        const outputs: Record<string, unknown> = Object.fromEntries((task.output_fields ?? [])
          .filter(field => field.value !== undefined && field.value !== null && field.value !== '')
          .map(field => [field.id, field.value]))
        outputs.action = actionId
        if (input) outputs.reason = input
        this.db.setSetting(key, JSON.stringify({scope,taskId:task.id,externalId:task.external_id,expectedVersion:snapshot.version,outputs}))
      }
      await this.flushTaskCompletions()
      return this.db.getSetting(key)
        ? {success:false,error:this.db.getSetting(`${key}:error`) || 'Completion is pending. Workflo must confirm it.'}
        : {success:true}
    }

    const ctx = this.buildContext(source.mcp_server_id || undefined, sourceId)
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

    const ctx = this.buildContext(source.mcp_server_id || undefined, sourceId)
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

    const ctx = this.buildContext(source.mcp_server_id || undefined, task.source_id || undefined)
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
