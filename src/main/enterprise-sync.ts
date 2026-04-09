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
  private syncInProgress: Promise<EnterpriseSyncResult> | null = null
  private lastSyncTime = 0
  // Minimum interval between full syncs (30 seconds)
  private static readonly SYNC_COOLDOWN_MS = 30_000

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
      const hasUsesAtLastSync = columns.some((c) => c.name === 'uses_at_last_sync')
      if (!hasUsesAtLastSync) {
        console.log('[EnterpriseSyncManager] Adding missing uses_at_last_sync column to skills table')
        this.db.db.exec(
          'ALTER TABLE skills ADD COLUMN uses_at_last_sync INTEGER NOT NULL DEFAULT 0'
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
    // Deduplicate concurrent/rapid calls — return existing promise if sync is in progress
    if (this.syncInProgress) {
      console.log('[EnterpriseSyncManager] Sync already in progress, reusing existing run')
      return this.syncInProgress
    }

    // Cooldown — skip if we just synced recently
    const now = Date.now()
    if (now - this.lastSyncTime < EnterpriseSyncManager.SYNC_COOLDOWN_MS) {
      console.log('[EnterpriseSyncManager] Skipping sync — cooldown active (last sync was', Math.round((now - this.lastSyncTime) / 1000), 's ago)')
      return {
        agents: { created: 0, updated: 0 },
        skills: { created: 0, updated: 0, pushed: 0 },
        mcpServers: { created: 0, updated: 0 },
        taskSources: { created: 0, updated: 0 },
        errors: []
      }
    }

    this.syncInProgress = this._doSync(userId)
    try {
      return await this.syncInProgress
    } finally {
      this.syncInProgress = null
      this.lastSyncTime = Date.now()
    }
  }

  private async _doSync(userId: string): Promise<EnterpriseSyncResult> {
    const syncStartTime = Date.now()
    const result: EnterpriseSyncResult = {
      agents: { created: 0, updated: 0 },
      skills: { created: 0, updated: 0, pushed: 0 },
      mcpServers: { created: 0, updated: 0 },
      taskSources: { created: 0, updated: 0 },
      errors: []
    }

    // 0. Ensure enterprise_skill_id column exists (safety net for missed migration)
    this.ensureSkillColumn()

    // Declare outside try so skills sync can use them even if listOrgNodes fails
    let nodes: WorkfloOrgNode[] = []
    let userNodes: WorkfloOrgNode[] = []

    // ── Phase 1: Node-dependent sync (agents, MCP servers, task sources) ──
    try {
      // 1. Fetch all org nodes
      nodes = await this.apiClient.listOrgNodes()

      // 2. Find nodes where this user is assigned
      userNodes = nodes.filter(
        (n) => n.userIds && n.userIds.includes(userId)
      )

      if (nodes.length === 0) {
        console.log(
          '[EnterpriseSyncManager] No org nodes found in workflow-builder — skipping node resource sync'
        )
      } else if (userNodes.length === 0) {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Org node sync failed: ${msg}`)
      console.warn(
        '[EnterpriseSyncManager] Org node sync failed, continuing with skills sync:',
        msg
      )
    }

    // ── Phase 2: Skills 2-way sync (runs independently of org node availability) ──
    try {
      const skillSyncStart = Date.now()

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

      // Step A0: Collect locally-deleted skill IDs (to exclude from node assignment)
      const removedSkillIds = this.getLocallyRemovedSkillIds()

      // Step A+C combined: Batch sync local skills and receive all tenant skills back
      const { pushedSkillIds, allServerSkills } = await this.batchSyncSkills(result)

      // Step B: Assign all skill IDs to user's node(s), excluding locally-deleted ones
      const targetNodes = userNodes.length > 0 ? userNodes : nodes
      if (targetNodes.length === 0) {
        console.log(
          '[EnterpriseSyncManager] No org nodes available — skipping skill-to-node assignment (skills still synced at tenant level)'
        )
      } else {
        for (const node of targetNodes) {
          await this.assignSkillsToNode(node.id, pushedSkillIds, removedSkillIds, result)
        }
      }

      // Step C: Pull server skills into local DB (using batch-sync response — no extra API call)
      console.log(
        `[EnterpriseSyncManager] pullServerSkills: ${allServerSkills.length} server skills from batch-sync response`,
        allServerSkills.map((s) => ({ id: s.id, name: s.name }))
      )
      if (allServerSkills.length > 0) {
        await this.pullServerSkills(allServerSkills, result)
      } else {
        console.log('[EnterpriseSyncManager] No server skills to pull (batch-sync returned empty)')
      }

      const skillSyncMs = Date.now() - skillSyncStart
      console.log(`[EnterpriseSyncManager] Skills sync completed in ${skillSyncMs}ms`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Skills 2-way sync failed: ${msg}`)
    }

    const totalSyncMs = Date.now() - syncStartTime
    console.log(
      `[EnterpriseSyncManager] Sync complete in ${totalSyncMs}ms:`,
      JSON.stringify(result)
    )
    return result
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
   * Collect enterprise skill IDs that were soft-deleted locally.
   * These should be unassigned from the node (but NOT deleted from server).
   * Hard-deletes the local rows after collecting.
   */
  private getLocallyRemovedSkillIds(): Set<string> {
    const deletedSkills = this.db.getDeletedEnterpriseSkills()
    const removedIds = new Set<string>()

    for (const skill of deletedSkills) {
      if (skill.enterprise_skill_id) {
        removedIds.add(skill.enterprise_skill_id)
      }
      // Hard-delete locally — the skill stays on server but won't be assigned to this node
      this.db.hardDeleteSkill(skill.id)
    }

    if (removedIds.size > 0) {
      console.log(
        `[EnterpriseSyncManager] ${removedIds.size} locally-deleted skills will be unassigned from node`
      )
    }

    return removedIds
  }

  /**
   * Maximum number of skills per batch-sync request (server limit).
   */
  private static readonly BATCH_SYNC_MAX_SKILLS = 200

  /**
   * Maximum number of retry attempts for batch-sync API calls.
   */
  private static readonly BATCH_SYNC_MAX_RETRIES = 3

  /**
   * Base delay for exponential backoff (ms).
   */
  private static readonly BATCH_SYNC_BASE_DELAY_MS = 500

  /**
   * Batch sync local skills to the server using the batch-sync endpoint.
   * Replaces per-skill sequential push with a single (or chunked) API call.
   *
   * Returns:
   *   - pushedSkillIds: server skill IDs for node assignment
   *   - allServerSkills: ALL tenant skills from batch-sync response (for pull phase)
   */
  private async batchSyncSkills(
    result: EnterpriseSyncResult
  ): Promise<{ pushedSkillIds: string[]; allServerSkills: WorkfloSkill[] }> {
    const localSkills = this.db.getSkills()

    console.log(
      `[EnterpriseSyncManager] batchSyncSkills: ${localSkills.length} local skills found`,
      localSkills.map((s) => ({ name: s.name, enterprise_skill_id: s.enterprise_skill_id }))
    )

    // Filter and prepare skills for batch sync
    const skillsToSync: Array<{
      localId: string
      payload: {
        name: string
        description: string
        content: string
        confidence?: number
        uses?: number
        lastUsed?: string | null
        tags?: string[]
      }
    }> = []

    for (const skill of localSkills) {
      // Skip built-in system skills
      if (this.isBuiltInSkill(skill)) continue

      // Skip [Workflo]-prefixed skills — these were pulled from the server
      if (skill.name.startsWith(WORKFLO_SKILL_PREFIX)) continue

      const localName = this.stripWorkfloPrefix(skill.name)

      // Include the skill in the batch — server does upsert by name
      skillsToSync.push({
        localId: skill.id,
        payload: {
          name: localName,
          description: skill.description,
          content: skill.content,
          confidence: skill.confidence,
          uses: skill.uses,
          lastUsed: this.normalizeDateTime(skill.last_used),
          tags: skill.tags
        }
      })
    }

    console.log(
      `[EnterpriseSyncManager] batchSyncSkills: ${skillsToSync.length} skills to sync (${localSkills.length - skillsToSync.length} skipped)`
    )

    // Send skills in chunks of BATCH_SYNC_MAX_SKILLS
    let allServerSkills: WorkfloSkill[] = []
    let totalCreated = 0
    let totalUpdated = 0

    const chunks = this.chunkArray(
      skillsToSync,
      EnterpriseSyncManager.BATCH_SYNC_MAX_SKILLS
    )

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const payloads = chunk.map((s) => s.payload)

      try {
        const batchResult = await this.batchSyncWithRetry(payloads)
        totalCreated += batchResult.created
        totalUpdated += batchResult.updated
        // Last chunk's response has the full tenant skill set
        allServerSkills = batchResult.skills
        console.log(
          `[EnterpriseSyncManager] Batch chunk ${i + 1}/${chunks.length}: created=${batchResult.created}, updated=${batchResult.updated}, total_skills=${batchResult.skills.length}`
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`Batch sync chunk ${i + 1}/${chunks.length} failed: ${msg}`)
        console.error(`[EnterpriseSyncManager] Batch sync chunk ${i + 1} failed after retries:`, msg)
      }
    }

    // If no skills to sync but we still need the server skill list (for pull),
    // do a single empty batch or fall back to listSkills
    if (skillsToSync.length === 0) {
      try {
        // Send empty batch — server returns all tenant skills
        const batchResult = await this.batchSyncWithRetry([])
        allServerSkills = batchResult.skills
      } catch {
        // Fall back to listSkills if batch-sync with empty payload fails
        try {
          allServerSkills = await this.apiClient.listSkills() ?? []
        } catch (listErr) {
          const msg = listErr instanceof Error ? listErr.message : String(listErr)
          result.errors.push(`Fallback listSkills failed: ${msg}`)
        }
      }
    }

    result.skills.pushed = totalCreated + totalUpdated

    // Build a name→server skill map for linking local skills
    const serverSkillByName = new Map<string, WorkfloSkill>()
    for (const s of allServerSkills) {
      if (!serverSkillByName.has(s.name)) {
        serverSkillByName.set(s.name, s)
      }
    }

    // Link local skills to their server counterparts and collect IDs for node assignment
    const pushedSkillIds: string[] = []
    for (const { localId, payload } of skillsToSync) {
      const serverSkill = serverSkillByName.get(payload.name)
      if (serverSkill) {
        // Update local record with server ID and sync baseline
        const localSkill = localSkills.find((s) => s.id === localId)
        if (localSkill) {
          this.db.updateSkill(localId, {
            enterprise_skill_id: serverSkill.id,
            uses_at_last_sync: localSkill.uses
          })
        }
        pushedSkillIds.push(serverSkill.id)
      }
    }

    console.log(
      `[EnterpriseSyncManager] batchSyncSkills complete: pushed=${result.skills.pushed}, linked=${pushedSkillIds.length}, server_total=${allServerSkills.length}`
    )

    return { pushedSkillIds, allServerSkills }
  }

  /**
   * Call batchSyncSkills API with exponential backoff retry.
   */
  private async batchSyncWithRetry(
    skills: Array<{
      name: string
      description: string
      content: string
      confidence?: number
      uses?: number
      lastUsed?: string | null
      tags?: string[]
    }>
  ): Promise<{ created: number; updated: number; skills: WorkfloSkill[] }> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < EnterpriseSyncManager.BATCH_SYNC_MAX_RETRIES; attempt++) {
      try {
        return await this.apiClient.batchSyncSkills(skills)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))

        // Don't retry on 400 (validation error) — it won't succeed
        if (lastError.message.includes('400') || lastError.message.includes('validation')) {
          throw lastError
        }

        if (attempt < EnterpriseSyncManager.BATCH_SYNC_MAX_RETRIES - 1) {
          const delay = EnterpriseSyncManager.BATCH_SYNC_BASE_DELAY_MS * Math.pow(2, attempt)
          console.log(
            `[EnterpriseSyncManager] Batch sync attempt ${attempt + 1} failed, retrying in ${delay}ms...`
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError!
  }

  /**
   * Split an array into chunks of the given size.
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size))
    }
    // Ensure at least one empty chunk so the caller still fires a request
    if (chunks.length === 0) chunks.push([])
    return chunks
  }

  /**
   * Assign skill IDs to an org node on the server.
   * Merges the pushed skill IDs with any existing node skill IDs.
   */
  private async assignSkillsToNode(
    nodeId: string,
    pushedSkillIds: string[],
    removedSkillIds: Set<string>,
    result: EnterpriseSyncResult
  ): Promise<void> {
    try {
      // pushedSkillIds already represents ALL skills this node should have
      // (every local skill that was pushed or already linked).
      // Just exclude locally-deleted ones and deduplicate.
      const finalIds = [...new Set(
        pushedSkillIds.filter((id) => !removedSkillIds.has(id))
      )]

      console.log(
        `[EnterpriseSyncManager] assignSkillsToNode: node=${nodeId}, skills=${finalIds.length}, removed=${removedSkillIds.size}`
      )

      await this.apiClient.updateOrgNode(nodeId, {
        skillIds: finalIds
      })

      console.log(
        `[EnterpriseSyncManager] Assigned ${finalIds.length} skills to node ${nodeId}`
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
          // Already linked — update only if server content actually differs
          const contentChanged =
            linkedSkill.description !== skill.description ||
            linkedSkill.content !== skill.content ||
            linkedSkill.confidence !== skill.confidence ||
            JSON.stringify(linkedSkill.tags) !== JSON.stringify(skill.tags)

          if (contentChanged) {
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
   * Normalize a date string to ISO 8601 datetime format.
   * SQLite may store dates as "2026-03-14" without time — the server
   * schema requires full datetime format like "2026-03-14T00:00:00.000Z".
   */
  private normalizeDateTime(value: string | null): string | null {
    if (!value) return null
    // Already has time component
    if (value.includes('T')) return value
    // Date-only (e.g. "2026-03-14") → append midnight UTC
    try {
      return new Date(value).toISOString()
    } catch {
      return null
    }
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
