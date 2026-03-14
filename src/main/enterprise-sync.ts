/**
 * EnterpriseSyncManager — Phase 2.3 / 2.4 + Skills 2-Way Sync
 *
 * Syncs agents, skills, MCP servers from Workflo org nodes into the local
 * 20x SQLite database. Runs:
 *   1. On enterprise connect (selectTenant success)
 *   2. On every task re-sync (before fetching tasks)
 *
 * Skills 2-way sync flow:
 *   1. Push local skills → server (create or update)
 *   2. Assign all skill IDs to this user's org node
 *   3. Pull server skills → local (from other nodes/users)
 *
 * Other resource flow:
 *   GET /api/org-nodes          → fetch all nodes
 *   For user's node(s):
 *     node.agents[]             → upsert into local agents table
 *     node.mcpServers[]         → upsert into local mcp_servers table (remote type)
 *     node.taskSources[]        → auto-create matching local task_sources entries
 */
import type { DatabaseManager, SkillRecord } from './database'
import type { WorkfloApiClient, WorkfloOrgNode, WorkfloMcpServer, WorkfloSkill, WorkfloAgent } from './workflo-api-client'

// ── Types ───────────────────────────────────────────────────────────────

export interface EnterpriseSyncResult {
  agents: { created: number; updated: number }
  skills: { created: number; updated: number; pushed: number }
  mcpServers: { created: number; updated: number }
  taskSources: { created: number; updated: number }
  errors: string[]
}

// Prefix for enterprise-synced resources to avoid conflicts
const ENTERPRISE_PREFIX = 'wf_'

// Skills with this prefix were originally pulled from the server
const WORKFLO_SKILL_PREFIX = '[Workflo] '

// ── Sync Manager ────────────────────────────────────────────────────────

export class EnterpriseSyncManager {
  private migrationChecked = false

  constructor(
    private db: DatabaseManager,
    private apiClient: WorkfloApiClient
  ) {}

  /**
   * Ensure the enterprise_skill_id column exists before syncing.
   * This is a safety net in case the database migration didn't run.
   */
  private ensureSkillColumn(): void {
    if (this.migrationChecked) return
    try {
      const columns = this.db.db.pragma('table_info(skills)') as { name: string }[]
      const hasColumn = columns.some((c) => c.name === 'enterprise_skill_id')
      if (!hasColumn) {
        console.log('[EnterpriseSyncManager] Adding missing enterprise_skill_id column to skills table')
        this.db.db.exec(
          'ALTER TABLE skills ADD COLUMN enterprise_skill_id TEXT DEFAULT NULL'
        )
      }
      this.migrationChecked = true
    } catch (err) {
      console.error('[EnterpriseSyncManager] Failed to ensure skill column:', err)
    }
  }

  /**
   * Full sync: fetch org nodes, find user's nodes, sync all resources
   */
  async syncAll(userId: string): Promise<EnterpriseSyncResult> {
    const result: EnterpriseSyncResult = {
      agents: { created: 0, updated: 0 },
      skills: { created: 0, updated: 0, pushed: 0 },
      mcpServers: { created: 0, updated: 0 },
      taskSources: { created: 0, updated: 0 },
      errors: []
    }

    try {
      // 0. Ensure enterprise_skill_id column exists (safety net for missed migration)
      this.ensureSkillColumn()

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

      // 3. Skills 2-way sync
      try {
        // Step 0: Clean up server-side duplicates (one-time fix for prior sync bugs)
        try {
          const cleanup = await this.apiClient.cleanupDuplicateSkills()
          if (cleanup.deleted > 0) {
            console.log(
              `[EnterpriseSyncManager] Cleaned up ${cleanup.deleted} duplicate server skills, kept ${cleanup.kept}`
            )
          }
        } catch (cleanupErr) {
          // Non-fatal — endpoint may not exist yet on older servers
          console.log('[EnterpriseSyncManager] Cleanup endpoint not available, skipping')
        }

        // Step A: Push local skills to server
        const pushedSkillIds = await this.pushLocalSkills(result)

        // Step B: Assign all skill IDs to user's node(s)
        const targetNodes = userNodes.length > 0 ? userNodes : nodes
        for (const node of targetNodes) {
          await this.assignSkillsToNode(node.id, pushedSkillIds, result)
        }

        // Step C: Pull server skills back (picks up skills from other nodes)
        // Re-fetch to include any skills we just created
        const freshServerSkills = await this.apiClient.listSkills() ?? []
        console.log(
          `[EnterpriseSyncManager] pullServerSkills: ${freshServerSkills.length} server skills fetched`,
          freshServerSkills.map((s) => ({ id: s.id, name: s.name }))
        )
        if (freshServerSkills.length > 0) {
          await this.pullServerSkills(freshServerSkills, result)
        } else {
          console.log('[EnterpriseSyncManager] No server skills to pull (listSkills returned empty)')
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`Skills 2-way sync failed: ${msg}`)
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

  // ── Skill 2-Way Sync ───────────────────────────────────────────────

  /**
   * Push local skills to the server. Returns array of server skill IDs
   * that should be assigned to this node.
   *
   * - Skills with enterprise_skill_id: update on server if locally newer
   * - Skills without enterprise_skill_id (local-only): create on server
   * - Skips built-in skills (e.g. Mastermind)
   */
  private async pushLocalSkills(
    result: EnterpriseSyncResult
  ): Promise<string[]> {
    const localSkills = this.db.getSkills()
    const serverSkillIds: string[] = []

    console.log(
      `[EnterpriseSyncManager] pushLocalSkills: ${localSkills.length} local skills found`,
      localSkills.map((s) => ({ name: s.name, enterprise_skill_id: s.enterprise_skill_id }))
    )

    for (const skill of localSkills) {
      try {
        // Skip built-in system skills
        if (this.isBuiltInSkill(skill)) {
          // If it already has an enterprise ID, keep it in the node assignment
          if (skill.enterprise_skill_id) {
            serverSkillIds.push(skill.enterprise_skill_id)
          }
          continue
        }

        if (skill.enterprise_skill_id) {
          // Already linked to server — push update if locally newer
          try {
            const serverSkill = await this.apiClient.updateSkill(
              skill.enterprise_skill_id,
              {
                name: this.stripWorkfloPrefix(skill.name),
                description: skill.description,
                content: skill.content,
                confidence: skill.confidence,
                tags: skill.tags
              }
            )
            serverSkillIds.push(serverSkill.id)
            result.skills.pushed++
          } catch (updateErr) {
            // If 404 (skill deleted on server), re-create it
            const msg = updateErr instanceof Error ? updateErr.message : String(updateErr)
            if (msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')) {
              console.log(`[EnterpriseSyncManager] Skill ${skill.name} deleted on server, re-creating...`)
              const created = await this.apiClient.createSkill({
                name: this.stripWorkfloPrefix(skill.name),
                description: skill.description,
                content: skill.content,
                confidence: skill.confidence,
                tags: skill.tags
              })
              this.db.updateSkill(skill.id, { enterprise_skill_id: created.id })
              serverSkillIds.push(created.id)
              result.skills.pushed++
            } else {
              throw updateErr
            }
          }
        } else {
          // New local skill — create on server
          const created = await this.apiClient.createSkill({
            name: this.stripWorkfloPrefix(skill.name),
            description: skill.description,
            content: skill.content,
            confidence: skill.confidence,
            tags: skill.tags
          })

          // Store the server ID locally for future syncs
          this.db.updateSkill(skill.id, { enterprise_skill_id: created.id })
          serverSkillIds.push(created.id)
          result.skills.pushed++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`Push skill ${skill.name}: ${msg}`)
        // Still include the enterprise_skill_id if we have one
        if (skill.enterprise_skill_id) {
          serverSkillIds.push(skill.enterprise_skill_id)
        }
      }
    }

    return serverSkillIds
  }

  /**
   * Assign skill IDs to an org node on the server.
   * Merges the pushed skill IDs with any existing node skill IDs.
   */
  private async assignSkillsToNode(
    nodeId: string,
    pushedSkillIds: string[],
    result: EnterpriseSyncResult
  ): Promise<void> {
    try {
      // Get valid server skill IDs to filter out stale references
      const serverSkills = await this.apiClient.listSkills() ?? []
      const validSkillIds = new Set(serverSkills.map((s) => s.id))

      // Get current node and filter existing IDs to only valid ones
      const detail = await this.apiClient.getOrgNode(nodeId)
      const existingSkillIds = (detail.node?.skillIds || []).filter(
        (id) => validSkillIds.has(id)
      )

      // Merge: existing valid IDs + newly pushed IDs, deduplicated
      const mergedIds = [...new Set([...existingSkillIds, ...pushedSkillIds])]

      console.log(
        `[EnterpriseSyncManager] assignSkillsToNode: node=${nodeId}, validExisting=${existingSkillIds.length}, pushed=${pushedSkillIds.length}, merged=${mergedIds.length}`
      )

      // Always update to clean up stale references even if pushedSkillIds is empty
      await this.apiClient.updateOrgNode(nodeId, {
        skillIds: mergedIds
      })

      console.log(
        `[EnterpriseSyncManager] Assigned ${mergedIds.length} skills to node ${nodeId}`
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Assign skills to node ${nodeId}: ${msg}`)
    }
  }

  /**
   * Pull skills from the server into the local database.
   * - Skills already linked via enterprise_skill_id: update if server is newer
   * - Skills not linked: match by name (with [Workflo] prefix) or create new
   */
  private async pullServerSkills(
    serverSkills: WorkfloSkill[],
    result: EnterpriseSyncResult
  ): Promise<void> {
    for (const skill of serverSkills) {
      try {
        // First, check if we already have this skill linked by enterprise_skill_id
        const linkedSkill = this.db.getSkillByEnterpriseId(skill.id)

        if (linkedSkill) {
          // Already linked — update if server is newer
          const remoteUpdated = new Date(skill.updatedAt).getTime()
          const localUpdated = new Date(linkedSkill.updated_at).getTime()

          if (remoteUpdated > localUpdated) {
            this.db.updateSkill(linkedSkill.id, {
              description: skill.description,
              content: skill.content,
              confidence: skill.confidence,
              tags: skill.tags
            })
            result.skills.updated++
          }
          continue
        }

        // Check by [Workflo] prefixed name (backward compatibility)
        const enterpriseName = `${WORKFLO_SKILL_PREFIX}${skill.name}`
        const existingByName = this.db.getSkillByName(enterpriseName)

        if (existingByName) {
          // Link it and update if server is newer
          this.db.updateSkill(existingByName.id, {
            enterprise_skill_id: skill.id
          })

          const remoteUpdated = new Date(skill.updatedAt).getTime()
          const localUpdated = new Date(existingByName.updated_at).getTime()

          if (remoteUpdated > localUpdated) {
            this.db.updateSkill(existingByName.id, {
              description: skill.description,
              content: skill.content,
              confidence: skill.confidence,
              tags: skill.tags
            })
            result.skills.updated++
          }
          continue
        }

        // Also check by exact name (no prefix)
        const existingByExactName = this.db.getSkillByName(skill.name)
        if (existingByExactName) {
          // Link it and update if server is newer
          this.db.updateSkill(existingByExactName.id, {
            enterprise_skill_id: skill.id
          })

          const remoteUpdated = new Date(skill.updatedAt).getTime()
          const localUpdated = new Date(existingByExactName.updated_at).getTime()

          if (remoteUpdated > localUpdated) {
            this.db.updateSkill(existingByExactName.id, {
              description: skill.description,
              content: skill.content,
              confidence: skill.confidence,
              tags: skill.tags
            })
            result.skills.updated++
          }
          continue
        }

        // New skill from server — create locally with [Workflo] prefix
        this.db.createSkill({
          name: enterpriseName,
          description: skill.description,
          content: skill.content,
          confidence: skill.confidence,
          tags: skill.tags,
          enterprise_skill_id: skill.id
        })
        result.skills.created++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`Pull skill ${skill.name}: ${msg}`)
      }
    }
  }

  /**
   * Check if a skill is a built-in system skill that shouldn't be synced
   */
  private isBuiltInSkill(skill: SkillRecord): boolean {
    const builtInNames = ['Mastermind', 'mastermind']
    return builtInNames.includes(skill.name)
  }

  /**
   * Strip the [Workflo] prefix from a skill name if present
   */
  private stripWorkfloPrefix(name: string): string {
    if (name.startsWith(WORKFLO_SKILL_PREFIX)) {
      return name.slice(WORKFLO_SKILL_PREFIX.length)
    }
    return name
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
