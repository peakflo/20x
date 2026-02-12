import type { DatabaseManager, McpServerRecord, TaskRecord } from '../database'
import type { McpToolCaller } from '../mcp-tool-caller'
import type { SourceUser, ReassignResult } from '../../shared/types'

// ── Config Schema (declarative, JSON-serializable) ──────────

export type ConfigFieldType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'dynamic-select'
  | 'key-value'
  | 'password'

export interface ConfigFieldOption {
  value: string
  label: string
}

export interface ConfigFieldSchema {
  key: string
  label: string
  type: ConfigFieldType
  placeholder?: string
  required?: boolean
  default?: unknown
  description?: string
  options?: ConfigFieldOption[]
  /** For 'dynamic-select': calls plugin.resolveOptions(resolverKey, ...) */
  optionsResolver?: string
  /** Conditional visibility */
  dependsOn?: { field: string; value: unknown }
}

export type PluginConfigSchema = ConfigFieldSchema[]

// ── Field Mapping ───────────────────────────────────────────

export interface FieldMapping {
  external_id: string
  title: string
  description?: string
  type?: string
  priority?: string
  status?: string
  assignee?: string
  due_date?: string
  labels?: string
}

// ── Actions ─────────────────────────────────────────────────

export interface PluginAction {
  id: string
  label: string
  icon?: string
  variant?: 'default' | 'destructive'
  requiresInput?: boolean
  inputLabel?: string
  inputPlaceholder?: string
}

export interface ActionResult {
  success: boolean
  error?: string
  /** Fields to apply to local task after action */
  taskUpdate?: Record<string, unknown>
}

// ── Sync Result ─────────────────────────────────────────────

export interface PluginSyncResult {
  imported: number
  updated: number
  errors: string[]
}

// ── Plugin Context ──────────────────────────────────────────

export interface PluginContext {
  db: DatabaseManager
  toolCaller: McpToolCaller
  mcpServer?: McpServerRecord
}

// ── Plugin Interface ────────────────────────────────────────

export interface TaskSourcePlugin {
  id: string
  displayName: string
  description: string
  icon: string
  requiresMcpServer: boolean

  getConfigSchema(): PluginConfigSchema

  resolveOptions(
    resolverKey: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ConfigFieldOption[]>

  validateConfig(config: Record<string, unknown>): string | null

  getFieldMapping(config: Record<string, unknown>): FieldMapping

  getActions(config: Record<string, unknown>): PluginAction[]

  importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult>

  exportUpdate(
    task: TaskRecord,
    changedFields: Record<string, unknown>,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<void>

  executeAction(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ActionResult>

  getUsers?(
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<SourceUser[]>

  reassignTask?(
    task: TaskRecord,
    userIds: string[],
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ReassignResult>
}
