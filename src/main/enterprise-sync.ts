/**
 * EnterpriseSyncManager — Phase 2.3 / 2.4
 *
 * Syncs agents, skills, MCP servers from Workflo org nodes into the local
 * 20x SQLite database. Runs:
 *   1. On enterprise connect (selectTenant success)
 *   2. On every task re-sync (before fetching tasks)
 *
 * Flow:
 *   GET /api/org-nodes          → fetch all nodes
 *   For user's node(s):
 *     node.agents[]             → upsert into local agents table
 *     node.skillIds[]           → fetch GET /api/skills, upsert into local skills table
 *     node.mcpServers[]         → upsert into local mcp_servers table (remote type)
 *     node.taskSources[]        → auto-create matching local task_sources entries
 */
import type { DatabaseManager } from './database'
import type { WorkfloApiClient, WorkfloOrgNode, WorkfloMcpServer, WorkfloSkill, WorkfloAgent } from './workflo-api-client'

// ── Types ───────────────────────────────────────────────────────────────

export interface EnterpriseSyncResult {
  agents: { created: number; updated: number }
  skills: { created: number; updated: number }
  mcpServers: { created: number; updated: number }
  taskSources: { created: number; updated: number }
  errors: string[]
}

// Prefix for enterprise-synced resources to avoid conflicts
const ENTERPRISE_PREFIX = 'wf_'

// ── Sync Manager ────────────────────────────────────────────────────────

export class EnterpriseSyncManager {
  constructor(
    private db: DatabaseManager,
    private apiClient: WorkfloApiClient
  ) {}

  /**
   * Full sync: fetch org nodes, find user's nodes, sync all resources
   */
  async syncAll(userId: string): Promise<EnterpriseSyncResult> {
    const result: EnterpriseSyncResult = {
      agents: { created: 0, updated: 0 },
      skills: { created: 0, updated: 0 },
      mcpServers: { created: 0, updated: 0 },
      taskSources: { created: 0, updated: 0 },
      errors: []
    }

    try {
      // 1. Fetch all org nodes
      const nodes = await this.apiClient.listOrgNodes()

      // 2. Find nodes where this user is assigned
      const userNodes = nodes.filter(
        (n) => n.userIds && n.userIds.includes(userId)
      )

      if (userNodes.length === 0) {
        // If no specific assignment, sync from all nodes (admin mode)
        console.log(
          '[EnterpriseSyncManager] User not assigned to specific nodes, syncing all'
        )
        for (const node of nodes) {
          await this.syncNode(node, result)
        }
      } else {
        for (const node of userNodes) {
          await this.syncNode(node, result)
        }
      }

      // 3. Fetch and sync skills (global, not per-node)
      try {
        const skills = await this.apiClient.listSkills()
        await this.syncSkills(skills, result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`Skills sync failed: ${msg}`)
      }

      console.log(
        '[EnterpriseSyncManager] Sync complete:',
        JSON.stringify(result)
      )
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Sync failed: ${msg}`)
      return result
    }
  }

  /**
   * Sync a single org node's resources
   */
  private async syncNode(
    node: WorkfloOrgNode,
    result: EnterpriseSyncResult
  ): Promise<void> {
    // Sync agents from node
    if (node.agents && node.agents.length > 0) {
      await this.syncAgents(node.agents, result)
    }

    // Fetch node details to get MCP servers and task sources
    try {
      const detail = await this.apiClient.getOrgNode(node.id)

      // Sync MCP servers
      if (detail.mcpServers && detail.mcpServers.length > 0) {
        await this.syncMcpServers(detail.mcpServers, result)
      }

      // Sync task sources (auto-create local Peakflo task sources)
      if (detail.taskSources && detail.taskSources.length > 0) {
        await this.syncTaskSources(detail.taskSources, result)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Node ${node.name} detail fetch failed: ${msg}`)
    }
  }

  // ── Agent Sync ────────────────────────────────────────────────────────

  private async syncAgents(
    agents: WorkfloAgent[],
    result: EnterpriseSyncResult
  ): Promise<void> {
    const localAgents = this.db.getAgents()

    for (const agent of agents) {
      try {
        const enterpriseName = `[Workflo] ${agent.name}`
        const existing = localAgents.find(
          (a) => a.name === enterpriseName || (a.config as Record<string, unknown>)?.enterprise_agent_id === agent.id
        )

        // Build agent config with MCP server references
        const config: Record<string, unknown> = {
          ...agent.config,
          enterprise_source: true,
          enterprise_agent_id: agent.id,
          mcp_servers: agent.mcpServerIds.map(
            (sid) => `${ENTERPRISE_PREFIX}${sid}`
          )
        }

        if (agent.systemPrompt) {
          config.system_prompt = agent.systemPrompt
        }

        if (existing) {
          this.db.updateAgent(existing.id, {
            name: enterpriseName,
            config
          })
          result.agents.updated++
        } else {
          this.db.createAgent({
            name: enterpriseName,
            config
          })
          result.agents.created++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`Agent ${agent.name}: ${msg}`)
      }
    }
  }

  // ── Skill Sync ────────────────────────────────────────────────────────

  private async syncSkills(
    skills: WorkfloSkill[],
    result: EnterpriseSyncResult
  ): Promise<void> {
    const localSkills = this.db.getSkills()

    for (const skill of skills) {
      try {
        const enterpriseName = `[Workflo] ${skill.name}`
        const existing = localSkills.find(
          (s) => s.name === enterpriseName
        )

        if (existing) {
          // Only update if remote is newer
          const remoteUpdated = new Date(skill.updatedAt).getTime()
          const localUpdated = new Date(existing.updated_at).getTime()

          if (remoteUpdated > localUpdated) {
            this.db.updateSkill(existing.id, {
              name: enterpriseName,
              description: skill.description,
              content: skill.content,
              tags: skill.tags
            })
            result.skills.updated++
          }
        } else {
          this.db.createSkill({
            name: enterpriseName,
            description: skill.description,
            content: skill.content,
            tags: skill.tags
          })
          result.skills.created++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`Skill ${skill.name}: ${msg}`)
      }
    }
  }

  // ── MCP Server Sync ───────────────────────────────────────────────────

  private async syncMcpServers(
    servers: WorkfloMcpServer[],
    result: EnterpriseSyncResult
  ): Promise<void> {
    const localServers = this.db.getMcpServers()

    for (const server of servers) {
      try {
        if (!server.isActive) continue

        // Map Workflo MCP server to local format
        const serverData = this.mapMcpServer(server)
        const existing = localServers.find(
          (s) => s.name === serverData.name
        )

        if (existing) {
          const remoteUpdated = new Date(server.updatedAt).getTime()
          const localUpdated = new Date(existing.updated_at).getTime()

          if (remoteUpdated > localUpdated) {
            this.db.updateMcpServer(existing.id, serverData)
            result.mcpServers.updated++
          }
        } else {
          this.db.createMcpServer(serverData)
          result.mcpServers.created++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`MCP Server ${server.name}: ${msg}`)
      }
    }
  }

  private mapMcpServer(
    server: WorkfloMcpServer
  ): {
    name: string
    type: 'local' | 'remote'
    command: string
    args: string[]
    url: string
    headers: Record<string, string>
    environment: Record<string, string>
  } {
    if (server.type === 'remote') {
      const config = server.config as { url?: string; headers?: Record<string, string> }
      return {
        name: `[Workflo] ${server.name}`,
        type: 'remote',
        command: '',
        args: [],
        url: config.url || '',
        headers: config.headers || {},
        environment: {}
      }
    } else {
      const config = server.config as {
        command?: string
        args?: string[]
        environment?: Record<string, string>
      }
      return {
        name: `[Workflo] ${server.name}`,
        type: 'local',
        command: config.command || '',
        args: config.args || [],
        url: '',
        headers: {},
        environment: config.environment || {}
      }
    }
  }

  // ── Task Source Sync ───────────────────────────────────────────────────

  private async syncTaskSources(
    sources: Array<{
      id: string
      name: string
      type: string
      config: Record<string, unknown>
      enabled: boolean
    }>,
    result: EnterpriseSyncResult
  ): Promise<void> {
    const localSources = this.db.getTaskSources()

    for (const source of sources) {
      try {
        if (!source.enabled) continue

        const enterpriseName = `[Workflo] ${source.name}`
        const existing = localSources.find(
          (s) => s.name === enterpriseName || (s.config as Record<string, unknown>)?.enterprise_source_id === source.id
        )

        if (!existing) {
          // Auto-create local task source pointing to Peakflo plugin (enterprise mode)
          this.db.createTaskSource({
            mcp_server_id: null,
            name: enterpriseName,
            plugin_id: 'peakflo',
            config: {
              enterprise_mode: true,
              enterprise_source_id: source.id,
              source_type: source.type
            },
            list_tool: '',
            list_tool_args: {},
            update_tool: '',
            update_tool_args: {}
          })
          result.taskSources.created++
        }
        // Don't update existing — user may have customized locally
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`Task Source ${source.name}: ${msg}`)
      }
    }
  }
}
