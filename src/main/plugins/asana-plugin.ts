import type { TaskRecord } from '../database'
import {
  PluginActionId,
  type TaskSourcePlugin,
  type PluginConfigSchema,
  type ConfigFieldOption,
  type PluginContext,
  type FieldMapping,
  type PluginAction,
  type PluginSyncResult,
  type ActionResult
} from './types'

export class AsanaPlugin implements TaskSourcePlugin {
  id = 'asana'
  displayName = 'Asana'
  description = 'Import and manage tasks from Asana workspaces'
  icon = 'CheckSquare'
  requiresMcpServer = false

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: 'personal_access_token',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        description: 'Your Asana Personal Access Token (PAT)'
      },
      {
        key: 'workspace_id',
        label: 'Workspace ID',
        type: 'text',
        required: true,
        description: 'The ID of your Asana workspace to sync tasks from'
      }
    ]
  }

  async resolveOptions(
    _resolverKey: string,
    _config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ConfigFieldOption[]> {
    return []
  }

  validateConfig(config: Record<string, unknown>): string | null {
    if (!config.personal_access_token || typeof config.personal_access_token !== 'string') {
      return 'Personal Access Token is required'
    }
    if (!config.workspace_id || typeof config.workspace_id !== 'string') {
      return 'Workspace ID is required'
    }
    return null
  }

  getFieldMapping(_config: Record<string, unknown>): FieldMapping {
    return {
      external_id: 'gid',
      title: 'name',
      description: 'notes',
      status: 'completed',
      assignee: 'assignee.name',
      due_date: 'due_on'
    }
  }

  getActions(_config: Record<string, unknown>): PluginAction[] {
    return [
      {
        id: PluginActionId.ChangeStatus,
        label: 'Mark Complete',
        icon: 'Check'
      }
    ]
  }

  async importTasks(
    _sourceId: string,
    _config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<PluginSyncResult> {
    // TODO: Implement Asana API client and task fetching
    console.log('[asana-plugin] importTasks called - implementation pending')
    return { imported: 0, updated: 0, errors: [] }
  }

  async exportUpdate(
    _task: TaskRecord,
    _changedFields: Record<string, unknown>,
    _config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<void> {
    // TODO: Implement Asana API update
    console.log('[asana-plugin] exportUpdate called - implementation pending')
  }

  async executeAction(
    actionId: string,
    _task: TaskRecord,
    _input: string | undefined,
    _config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ActionResult> {
    // TODO: Implement action execution
    console.log(`[asana-plugin] executeAction called for ${actionId} - implementation pending`)
    return { success: false, error: 'Not implemented yet' }
  }
}
