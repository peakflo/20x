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
  confidence?: number
  version?: number
  uses?: number
  lastUsed?: string | null
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface WorkfloOrgNodeDetail {
  node: WorkfloOrgNode
  mcpServers: WorkfloMcpServer[]
  taskSources: WorkfloTaskSource[]
}

// ── Sync types ──────────────────────────────────────────────────────────

export interface WorkfloSyncEvent {
  eventType: string
  entityType: string
  entityId: string
  entityTitle?: string
  previousValue?: string
  newValue?: string
  eventData?: Record<string, unknown>
  userName?: string
  occurredAt?: string
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
    const result = await this.auth.apiRequest(
      'GET',
      '/api/skills'
    )
    // Handle both { skills: [...] } (new) and bare array (legacy) response formats
    if (Array.isArray(result)) return result as WorkfloSkill[]
    return (result as { skills: WorkfloSkill[] }).skills ?? []
  }

  /**
   * Create a new skill on the server
   */
  async createSkill(data: {
    name: string
    description: string
    content: string
    confidence?: number
    tags?: string[]
    uses?: number
    lastUsed?: string | null
  }): Promise<WorkfloSkill> {
    const result = (await this.auth.apiRequest(
      'POST',
      '/api/skills',
      data
    )) as WorkfloSkill
    return result
  }

  /**
   * Update an existing skill on the server
   */
  async updateSkill(
    skillId: string,
    data: {
      name?: string
      description?: string
      content?: string
      confidence?: number
      tags?: string[]
      usesDelta?: number
      lastUsed?: string | null
    }
  ): Promise<WorkfloSkill> {
    const result = (await this.auth.apiRequest(
      'PATCH',
      `/api/skills/${skillId}`,
      data
    )) as WorkfloSkill
    return result
  }

  /**
   * Delete a skill from the server
   */
  async deleteSkill(skillId: string): Promise<void> {
    await this.auth.apiRequest('DELETE', `/api/skills/${skillId}`)
  }

  /**
   * Batch sync skills — push multiple skills in a single API call.
   * The server upserts by name and returns ALL tenant skills after sync.
   * Max 200 skills per request; caller must chunk if more.
   */
  async batchSyncSkills(skills: Array<{
    name: string
    description: string
    content: string
    confidence?: number
    uses?: number
    lastUsed?: string | null
    tags?: string[]
  }>): Promise<{ created: number; updated: number; skills: WorkfloSkill[] }> {
    const result = (await this.auth.apiRequest(
      'POST',
      '/api/skills/batch-sync',
      { skills }
    )) as { created: number; updated: number; skills: WorkfloSkill[] }
    return result
  }

  /**
   * Clean up duplicate skills on the server (keeps oldest per name)
   */
  async cleanupDuplicateSkills(): Promise<{ deleted: number; kept: number }> {
    const result = (await this.auth.apiRequest(
      'POST',
      '/api/skills/cleanup-duplicates'
    )) as { deleted: number; kept: number }
    return result
  }

  // ── Org Nodes (update) ──────────────────────────────────────────────

  /**
   * Update an org node (e.g. to assign skillIds)
   */
  async updateOrgNode(
    nodeId: string,
    data: {
      skillIds?: string[]
      agents?: WorkfloAgent[]
    }
  ): Promise<WorkfloOrgNode> {
    const result = (await this.auth.apiRequest(
      'PUT',
      `/api/org-nodes/${nodeId}`,
      data
    )) as { node: WorkfloOrgNode }
    return result.node
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

  // ── Sync (heartbeat + events + stats) ──────────────────────────────────

  /**
   * Send a heartbeat ping to Workflo.
   * Should be called every ~1 minute when enterprise mode is active.
   */
  async sendHeartbeat(data?: {
    appVersion?: string
    userEmail?: string
    userName?: string
  }): Promise<{ ok: boolean; timestamp: string }> {
    const result = (await this.auth.apiRequest(
      'POST',
      '/api/20x/sync/heartbeat',
      data || {}
    )) as { ok: boolean; timestamp: string }
    return result
  }

  /**
   * Send a batch of changelog events to Workflo.
   * Events include task status changes, agent completions, etc.
   */
  async sendSyncEvents(
    events: WorkfloSyncEvent[]
  ): Promise<{ ok: boolean; inserted: number }> {
    if (events.length === 0) return { ok: true, inserted: 0 }

    const result = (await this.auth.apiRequest(
      'POST',
      '/api/20x/sync/events',
      { events }
    )) as { ok: boolean; inserted: number }
    return result
  }

}
