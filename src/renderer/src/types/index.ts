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

// ── Task types ──────────────────────────────────────────────

export type TaskType = 'coding' | 'manual' | 'review' | 'approval' | 'general'

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low'

export type TaskStatus =
  | 'inbox'
  | 'accepted'
  | 'in_progress'
  | 'pending_review'
  | 'completed'
  | 'cancelled'

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
  agent_id: string | null
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

export const TASK_STATUSES: { value: TaskStatus; label: string }[] = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'pending_review', label: 'Pending Review' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' }
]
