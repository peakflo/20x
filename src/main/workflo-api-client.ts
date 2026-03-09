/**
 * WorkfloApiClient — Phase 2.1
 *
 * Wraps Workflo REST API calls using enterprise JWT auth.
 * Provides typed methods for tasks, org nodes, skills, agents, MCP servers.
 *
 * All requests go through EnterpriseAuth.apiRequest() which handles:
 *   - JWT injection
 *   - Auto-refresh on 401
 *   - Base URL resolution
 */
import type { EnterpriseAuth } from './enterprise-auth'

// ── Response types ──────────────────────────────────────────────────────

export interface WorkfloTask {
  id: string
  tenantId: string
  workflowId: string | null
  executionId: string | null
  taskId: string
  title: string
  description: string | null
  status: string
  communicationChannel: string
  dueDate: string | null
  priority: string | null
  taskData: Record<string, unknown> | null
  response: Record<string, unknown> | null
  orgTaskSourceId: string | null
  externalId: string | null
  sourceType: string | null
  createdAt: string
  updatedAt: string
  assignees: Array<{
    id: string
    assigneeType: string
    assigneeValue: string
  }>
}

export interface WorkfloPagination {
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface WorkfloTasksResponse {
  tasks: WorkfloTask[]
  pagination: WorkfloPagination
}

export interface WorkfloOrgNode {
  id: string
  tenantId: string
  name: string
  description: string | null
  parentId: string | null
  position: number
  userIds: string[]
  skillIds: string[]
  agents: WorkfloAgent[]
  createdAt: string
  updatedAt: string
}

export interface WorkfloAgent {
  id: string
  name: string
  systemPrompt?: string
  mcpServerIds: string[]
  skillIds: string[]
  config: Record<string, unknown>
}

export interface WorkfloMcpServer {
  id: string
  tenantId: string
  orgNodeId: string
  name: string
  type: 'local' | 'remote'
  config: {
    command?: string
    args?: string[]
    environment?: Record<string, string>
    url?: string
    headers?: Record<string, string>
  }
  tools: Array<{
    name: string
    description?: string
    inputSchema?: Record<string, unknown>
  }>
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface WorkfloTaskSource {
  id: string
  tenantId: string
  orgNodeId: string
  name: string
  type: string
  integrationId: string | null
  mcpServerId: string | null
  config: Record<string, unknown>
  syncConfig: Record<string, unknown>
  enabled: boolean
  lastSyncedAt: string | null
  lastSyncError: string | null
  syncTaskCount: number
  createdAt: string
  updatedAt: string
}

export interface WorkfloSkill {
  id: string
  name: string
  description: string
  content: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface WorkfloOrgNodeDetail {
  node: WorkfloOrgNode
  mcpServers: WorkfloMcpServer[]
  taskSources: WorkfloTaskSource[]
}

// ── Client ──────────────────────────────────────────────────────────────

export class WorkfloApiClient {
  constructor(private auth: EnterpriseAuth) {}

  // ── Tasks ─────────────────────────────────────────────────────────────

  /**
   * List tasks with optional filters
   */
  async listTasks(filters?: {
    status?: string
    priority?: string
    page?: number
    pageSize?: number
    sortBy?: string
    sortOrder?: 'asc' | 'desc'
    myTasks?: boolean
  }): Promise<WorkfloTasksResponse> {
    const params = new URLSearchParams()
    if (filters) {
      if (filters.status) params.set('status', filters.status)
      if (filters.priority) params.set('priority', filters.priority)
      if (filters.page) params.set('page', String(filters.page))
      if (filters.pageSize) params.set('pageSize', String(filters.pageSize))
      if (filters.sortBy) params.set('sortBy', filters.sortBy)
      if (filters.sortOrder) params.set('sortOrder', filters.sortOrder)
      if (filters.myTasks) params.set('myTasks', 'true')
    }
    const qs = params.toString()
    const path = `/api/tasks${qs ? `?${qs}` : ''}`

    const result = (await this.auth.apiRequest('GET', path)) as WorkfloTasksResponse
    return result
  }

  /**
   * Get a single task by ID
   */
  async getTask(taskId: string): Promise<WorkfloTask> {
    const result = (await this.auth.apiRequest('GET', `/api/tasks/${taskId}`)) as { task: WorkfloTask }
    return result.task
  }

  /**
   * Update a task
   */
  async updateTask(
    taskId: string,
    data: {
      title?: string
      description?: string | null
      priority?: string | null
      dueDate?: string | null
      status?: string
      assignees?: Array<{ assigneeType: string; assigneeValue: string }>
    }
  ): Promise<void> {
    await this.auth.apiRequest('PATCH', `/api/tasks/${taskId}`, data)
  }

  /**
   * Execute an action on a task (approve, reject, etc.)
   */
  async executeAction(
    taskId: string,
    outputs: Record<string, unknown>
  ): Promise<void> {
    await this.auth.apiRequest('POST', `/api/tasks/${taskId}/action`, {
      outputs
    })
  }

  // ── Org Nodes ─────────────────────────────────────────────────────────

  /**
   * List all org nodes (flat list)
   */
  async listOrgNodes(): Promise<WorkfloOrgNode[]> {
    const result = (await this.auth.apiRequest(
      'GET',
      '/api/org-nodes'
    )) as { nodes: WorkfloOrgNode[] }
    return result.nodes
  }

  /**
   * Get a single org node with its MCP servers and task sources
   */
  async getOrgNode(nodeId: string): Promise<WorkfloOrgNodeDetail> {
    const result = (await this.auth.apiRequest(
      'GET',
      `/api/org-nodes/${nodeId}`
    )) as WorkfloOrgNodeDetail
    return result
  }

  // ── Skills ────────────────────────────────────────────────────────────

  /**
   * List all skills
   */
  async listSkills(): Promise<WorkfloSkill[]> {
    const result = (await this.auth.apiRequest(
      'GET',
      '/api/skills'
    )) as { skills: WorkfloSkill[] }
    return result.skills
  }

  // ── File download ───────────────────────────────────────────────────

  /**
   * Download a file from Workflo storage.
   * The path is the storage path from FileDataTypeValue (e.g. "uploads/1234-file.pdf").
   * Returns the raw buffer + metadata.
   */
  async downloadFile(
    filePath: string
  ): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    return this.auth.downloadFile(`/api/files/${filePath}`)
  }

  // ── Sync trigger ──────────────────────────────────────────────────────

  /**
   * Trigger a sync for a specific task source
   */
  async triggerSync(
    nodeId: string,
    sourceId: string
  ): Promise<{
    imported: number
    updated: number
    unchanged: number
    errors: string[]
    totalFromSource: number
  }> {
    const result = (await this.auth.apiRequest(
      'POST',
      `/api/org-nodes/${nodeId}/task-sources/${sourceId}/sync`
    )) as { result: { imported: number; updated: number; unchanged: number; errors: string[]; totalFromSource: number } }
    return result.result
  }
}
