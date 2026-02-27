// ── Settings types ──────────────────────────────────────────

export enum SettingsTab {
  GENERAL = 'general',
  AGENTS = 'agents',
  TOOLS_MCP = 'tools-mcp',
  INTEGRATIONS = 'integrations',
  ADVANCED = 'advanced'
}

export const SETTINGS_TABS: { value: SettingsTab; label: string; icon: string }[] = [
  { value: SettingsTab.GENERAL, label: 'General', icon: 'Settings' },
  { value: SettingsTab.AGENTS, label: 'Agents', icon: 'Users' },
  { value: SettingsTab.TOOLS_MCP, label: 'Tools & MCP', icon: 'Server' },
  { value: SettingsTab.INTEGRATIONS, label: 'Integrations', icon: 'Workflow' },
  { value: SettingsTab.ADVANCED, label: 'Advanced', icon: 'Wrench' }
]

// ── Agent types ─────────────────────────────────────────────

export enum CodingAgentType {
  OPENCODE = 'opencode',
  CLAUDE_CODE = 'claude-code',
  CODEX = 'codex'
}

export const CODING_AGENTS: { value: CodingAgentType; label: string }[] = [
  { value: CodingAgentType.OPENCODE, label: 'OpenCode' },
  { value: CodingAgentType.CLAUDE_CODE, label: 'Claude Code' },
  { value: CodingAgentType.CODEX, label: 'Codex' }
]

export enum ClaudeModel {
  SONNET_4_5 = 'claude-sonnet-4-5',
  OPUS_4_6 = 'claude-opus-4-6',
  HAIKU_4_5 = 'claude-haiku-4-5',
  SONNET_3_7 = 'claude-3-7-sonnet-20250219',
  SONNET_3_5_OCT = 'claude-3-5-sonnet-20241022',
  SONNET_3_5_JUN = 'claude-3-5-sonnet-20240620'
}

export const CLAUDE_MODELS: { id: ClaudeModel; name: string }[] = [
  { id: ClaudeModel.SONNET_4_5, name: 'Claude Sonnet 4.5' },
  { id: ClaudeModel.OPUS_4_6, name: 'Claude Opus 4.6' },
  { id: ClaudeModel.HAIKU_4_5, name: 'Claude Haiku 4.5' },
  { id: ClaudeModel.SONNET_3_7, name: 'Claude 3.7 Sonnet' },
  { id: ClaudeModel.SONNET_3_5_OCT, name: 'Claude 3.5 Sonnet (Oct)' },
  { id: ClaudeModel.SONNET_3_5_JUN, name: 'Claude 3.5 Sonnet (Jun)' }
]

export enum CodexModel {
  GPT_5_2_CODEX = 'gpt-5.2-codex',
  GPT_5_1_CODEX_MAX = 'gpt-5.1-codex-max',
  GPT_5_1_CODEX = 'gpt-5.1-codex',
  GPT_5_1_CODEX_MINI = 'gpt-5.1-codex-mini',
  GPT_5_CODEX = 'gpt-5-codex',
  GPT_5 = 'gpt-5',
  GPT_5_MINI = 'gpt-5-mini'
}

export const CODEX_MODELS: { id: CodexModel; name: string }[] = [
  { id: CodexModel.GPT_5_2_CODEX, name: 'GPT-5.2 Codex (Recommended)' },
  { id: CodexModel.GPT_5_1_CODEX_MAX, name: 'GPT-5.1 Codex Max' },
  { id: CodexModel.GPT_5_1_CODEX, name: 'GPT-5.1 Codex' },
  { id: CodexModel.GPT_5_1_CODEX_MINI, name: 'GPT-5.1 Codex Mini' },
  { id: CodexModel.GPT_5_CODEX, name: 'GPT-5 Codex' },
  { id: CodexModel.GPT_5, name: 'GPT-5' },
  { id: CodexModel.GPT_5_MINI, name: 'GPT-5 Mini (Fastest)' }
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
  skill_ids?: string[]
  max_parallel_sessions?: number  // Default: 1, range: 1-10
  api_keys?: {
    openai?: string  // For Codex
    anthropic?: string  // For Claude Code
  }
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

// ── Re-export shared constants & types ──────────────────────
import { TaskStatus, TASK_STATUSES } from '@shared/constants'
export { TaskStatus, TASK_STATUSES }
export type { SourceUser, ReassignResult } from '@shared/types'

// ── Task types ──────────────────────────────────────────────

export type TaskType = 'coding' | 'manual' | 'review' | 'approval' | 'general'

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low'

export interface FileAttachment {
  id: string
  filename: string
  size: number
  mime_type: string
  added_at: string
}

export interface RecurrencePatternObject {
  type: 'daily' | 'weekly' | 'monthly' | 'custom'
  interval: number
  time: string
  weekdays?: number[]
  monthDay?: number
  endDate?: string
  maxOccurrences?: number
}

/** A cron expression string OR a legacy JSON object */
export type RecurrencePattern = RecurrencePatternObject | string

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
  attachments: FileAttachment[]
  repos: string[]
  output_fields: OutputField[]
  agent_id: string | null
  session_id: string | null
  external_id: string | null
  source_id: string | null
  source: string
  skill_ids: string[] | null
  snoozed_until: string | null
  resolution: string | null
  feedback_rating: number | null
  feedback_comment: string | null
  is_recurring: boolean
  recurrence_pattern: RecurrencePattern | null
  recurrence_parent_id: string | null
  last_occurrence_at: string | null
  next_occurrence_at: string | null
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
  attachments?: FileAttachment[]
  repos?: string[]
  output_fields?: OutputField[]
  is_recurring?: boolean
  recurrence_pattern?: RecurrencePattern | null
  recurrence_parent_id?: string | null
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
  attachments?: FileAttachment[]
  repos?: string[]
  output_fields?: OutputField[]
  resolution?: string | null
  agent_id?: string | null
  skill_ids?: string[] | null
  snoozed_until?: string | null
  feedback_rating?: number | null
  feedback_comment?: string | null
  is_recurring?: boolean
  recurrence_pattern?: RecurrencePattern | null
  last_occurrence_at?: string | null
  next_occurrence_at?: string | null
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
  mcp_server_id: string | null
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

// ── Skill types ──────────────────────────────────────────────

export interface Skill {
  id: string
  name: string
  description: string
  content: string
  version: number
  confidence: number
  uses: number
  last_used: string | null
  tags: string[]
  created_at: string
  updated_at: string
}

export interface CreateSkillDTO {
  name: string
  description: string
  content: string
  confidence?: number
  uses?: number
  last_used?: string | null
  tags?: string[]
}

export interface UpdateSkillDTO {
  name?: string
  description?: string
  content?: string
  confidence?: number
  uses?: number
  last_used?: string | null
  tags?: string[]
}

// ── Plugin types ─────────────────────────────────────────────

export interface PluginMeta {
  id: string
  displayName: string
  description: string
  icon: string
  requiresMcpServer: boolean
  requiresOAuth?: boolean
  oauthProvider?: string
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
  multiSelect?: boolean
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

// ── OAuth types ──────────────────────────────────────────────

export type OAuthProvider = 'linear'

export interface OAuthToken {
  id: string
  provider: OAuthProvider
  source_id: string
  access_token: string
  refresh_token: string | null
  expires_at: string
  scope: string | null
  token_type: string
  created_at: string
  updated_at: string
}
