// ── Agent types ─────────────────────────────────────────────

export type CodingAgentType = 'opencode'

export const CODING_AGENTS: { value: CodingAgentType; label: string }[] = [
  { value: 'opencode', label: 'Opencode' }
]

export interface McpServerConfig {
  name: string
  command: string
  args: string[]
}

export interface McpServerTool {
  name: string
  description: string
}

export interface McpServer {
  id: string
  name: string
  type: 'local' | 'remote'
  command: string
  args: string[]
  url: string
  headers: Record<string, string>
  environment: Record<string, string>
  tools: McpServerTool[]
  created_at: string
  updated_at: string
}

export interface AgentMcpServerEntry {
  serverId: string
  enabledTools?: string[]
}

export interface CreateMcpServerDTO {
  name: string
  type?: 'local' | 'remote'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  environment?: Record<string, string>
}

export interface UpdateMcpServerDTO {
  name?: string
  type?: 'local' | 'remote'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  environment?: Record<string, string>
}

export interface AgentConfig {
  coding_agent?: CodingAgentType
  model?: string
  system_prompt?: string
  mcp_servers?: Array<string | AgentMcpServerEntry>
}

export interface Agent {
  id: string
  name: string
  server_url: string
  config: AgentConfig
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface CreateAgentDTO {
  name: string
  server_url?: string
  config?: AgentConfig
  is_default?: boolean
}

export interface UpdateAgentDTO {
  name?: string
  server_url?: string
  config?: AgentConfig
  is_default?: boolean
}

// ── Output field types ──────────────────────────────────────

export type OutputFieldType =
  | 'text'
  | 'number'
  | 'email'
  | 'textarea'
  | 'list'
  | 'date'
  | 'file'
  | 'boolean'
  | 'country'
  | 'currency'
  | 'url'

export interface OutputField {
  id: string
  name: string
  type: OutputFieldType
  multiple?: boolean
  options?: string[]
  required?: boolean
  value?: unknown
}

export const OUTPUT_FIELD_TYPES: { value: OutputFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'email', label: 'Email' },
  { value: 'textarea', label: 'Textarea' },
  { value: 'list', label: 'List' },
  { value: 'date', label: 'Date' },
  { value: 'file', label: 'File' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'country', label: 'Country' },
  { value: 'currency', label: 'Currency' },
  { value: 'url', label: 'URL' }
]

// ── Re-export shared constants ──────────────────────────────
export { TaskStatus, TASK_STATUSES } from '@shared/constants'

// ── Task types ──────────────────────────────────────────────

export type TaskType = 'coding' | 'manual' | 'review' | 'approval' | 'general'

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low'

export interface ChecklistItem {
  id: string
  text: string
  completed: boolean
}

export interface FileAttachment {
  id: string
  filename: string
  size: number
  mime_type: string
  added_at: string
}

export interface WorkfloTask {
  id: string
  title: string
  description: string
  type: TaskType
  priority: TaskPriority
  status: TaskStatus
  assignee: string
  due_date: string | null
  labels: string[]
  checklist: ChecklistItem[]
  attachments: FileAttachment[]
  repos: string[]
  output_fields: OutputField[]
  agent_id: string | null
  external_id: string | null
  source_id: string | null
  source: string
  created_at: string
  updated_at: string
}

export interface CreateTaskDTO {
  title: string
  description?: string
  type?: TaskType
  priority?: TaskPriority
  status?: TaskStatus
  assignee?: string
  due_date?: string | null
  labels?: string[]
  checklist?: ChecklistItem[]
  attachments?: FileAttachment[]
  repos?: string[]
  output_fields?: OutputField[]
}

export interface UpdateTaskDTO {
  title?: string
  description?: string
  type?: TaskType
  priority?: TaskPriority
  status?: TaskStatus
  assignee?: string
  due_date?: string | null
  labels?: string[]
  checklist?: ChecklistItem[]
  attachments?: FileAttachment[]
  repos?: string[]
  output_fields?: OutputField[]
  agent_id?: string | null
}

export const TASK_TYPES: { value: TaskType; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'coding', label: 'Coding' },
  { value: 'manual', label: 'Manual' },
  { value: 'review', label: 'Review' },
  { value: 'approval', label: 'Approval' }
]

export const TASK_PRIORITIES: { value: TaskPriority; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' }
]


// ── Task Source types ────────────────────────────────────────

export interface TaskSource {
  id: string
  mcp_server_id: string
  name: string
  plugin_id: string
  config: Record<string, unknown>
  list_tool: string
  list_tool_args: Record<string, unknown>
  update_tool: string
  update_tool_args: Record<string, unknown>
  last_synced_at: string | null
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface CreateTaskSourceDTO {
  mcp_server_id: string
  name: string
  plugin_id: string
  config?: Record<string, unknown>
  list_tool?: string
  list_tool_args?: Record<string, unknown>
  update_tool?: string
  update_tool_args?: Record<string, unknown>
}

export interface UpdateTaskSourceDTO {
  name?: string
  plugin_id?: string
  config?: Record<string, unknown>
  mcp_server_id?: string
  list_tool?: string
  list_tool_args?: Record<string, unknown>
  update_tool?: string
  update_tool_args?: Record<string, unknown>
  enabled?: boolean
}

export interface SyncResult {
  source_id: string
  imported: number
  updated: number
  errors: string[]
}

// ── Plugin types ─────────────────────────────────────────────

export interface PluginMeta {
  id: string
  displayName: string
  description: string
  icon: string
  requiresMcpServer: boolean
}

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
  optionsResolver?: string
  dependsOn?: { field: string; value: unknown }
}

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
  taskUpdate?: Record<string, unknown>
}
