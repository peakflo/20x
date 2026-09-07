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
import type { WorkfloApiClient, WorkfloOrgNode, WorkfloMcpServer, WorkfloSkill, WorkfloAgent, BatchSyncSkillsResult } from './workflo-api-client'

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

  /** Shorthand for the enterprise cloud domain (for error logs). */
  private get domain(): string {
    return this.apiClient.getDomain()
  }

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
      console.error(`[EnterpriseSyncManager] Failed to ensure skill column (domain: ${this.domain}):`, err)
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
      result.errors.push(`Org node sync failed (domain: ${this.domain}): ${msg}`)
      console.warn(
        `[EnterpriseSyncManager] Org node sync failed (domain: ${this.domain}), continuing with skills sync:`,
        msg
      )
    }

    // ── Phase 2: Skills 2-way sync (runs independently of org node availability) ──
    try {
      const skillSyncStart = Date.now()

      // NOTE: this used to call POST /api/skills/cleanup-duplicates on every
      // single sync. That endpoint deletes tenant rows, needs an admin
      // permission (so it 403s for ordinary users on every run), and was only
      // ever a mop-up for duplicates created by name-based identity. Skills are
      // now pushed with their server id, so duplicates are not created in the
      // first place. Cleanup stays available as an explicit admin action.

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
          await this.assignSkillsToNode(node, pushedSkillIds, removedSkillIds, result)
        }
      }

      // Step C: Pull server skills into local DB (using batch-sync response — no extra API call)
      console.log(
        `[EnterpriseSyncManager] pullServerSkills: ${allServerSkills.length} server skills from batch-sync response`,
        allServerSkills.map((s) => ({ id: s.id, name: s.name }))
      )
      if (allServerSkills.length > 0) {
        await this.pullServerSkills(allServerSkills, result, removedSkillIds)
      } else {
        console.log('[EnterpriseSyncManager] No server skills to pull (batch-sync returned empty)')
      }

      const skillSyncMs = Date.now() - skillSyncStart
      console.log(`[EnterpriseSyncManager] Skills sync completed in ${skillSyncMs}ms`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Skills 2-way sync failed (domain: ${this.domain}): ${msg}`)
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
      result.errors.push(`Node ${node.name} detail fetch failed (domain: ${this.domain}): ${msg}`)
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
        result.errors.push(`Agent ${agent.name} (domain: ${this.domain}): ${msg}`)
      }
    }
  }

  // ── Skill 2-Way Sync ───────────────────────────────────────────────

  /**
   * Collect enterprise skill IDs that were soft-deleted locally.
   * These are unassigned from the node, but NOT deleted from the server —
   * one user removing a skill from their machine must not destroy it for the
   * whole tenant.
   *
   * The soft-deleted rows are kept as TOMBSTONES. They are what tells the pull
   * phase "I deleted this on purpose, do not re-create it". Hard-deleting them
   * here would make the very next pull re-create the skill, because the server
   * still returns it in the tenant skill set.
   */
  private getLocallyRemovedSkillIds(): Set<string> {
    const deletedSkills = this.db.getDeletedEnterpriseSkills()
    const removedIds = new Set<string>()

    for (const skill of deletedSkills) {
      if (skill.enterprise_skill_id) {
        removedIds.add(skill.enterprise_skill_id)
      }
    }

    if (removedIds.size > 0) {
      console.log(
        `[EnterpriseSyncManager] ${removedIds.size} locally-deleted skills will be unassigned from the node and skipped on pull`
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
        id?: string
        name: string
        description: string
        content: string
        confidence?: number
        uses?: number
        lastUsed?: string | null
        updatedAt?: string
        tags?: string[]
        usesDelta?: number
      }
    }> = []

    for (const skill of localSkills) {
      // Skip built-in system skills
      if (this.isBuiltInSkill(skill)) continue

      // A [Workflo]-prefixed skill came from the server. It is still pushed
      // back when it is linked, so that a local edit to an enterprise skill
      // reaches the server instead of silently diverging. The server decides
      // who wins from the timestamps below. An UNLINKED prefixed skill is
      // skipped — it has no identity yet and would create a duplicate.
      const isPrefixed = skill.name.startsWith(WORKFLO_SKILL_PREFIX)
      if (isPrefixed && !skill.enterprise_skill_id) continue

      const localName = this.stripWorkfloPrefix(skill.name)

      // Skip skills with empty name, description, or content (server requires min 1 char)
      if (!localName || localName.trim().length === 0) {
        console.warn(`[EnterpriseSyncManager] Skipping skill with empty name: "${skill.name}"`)
        continue
      }
      if (!skill.description || skill.description.trim().length === 0) {
        console.warn(`[EnterpriseSyncManager] Skipping skill with empty description: "${skill.name}"`)
        continue
      }
      if (!skill.content || skill.content.trim().length === 0) {
        console.warn(`[EnterpriseSyncManager] Skipping skill with empty content: "${skill.name}"`)
        continue
      }

      // Include the skill in the batch. The server resolves identity from `id`
      // when we have one (so a local rename stays a rename), and uses
      // `updatedAt` to refuse a stale overwrite.
      skillsToSync.push({
        localId: skill.id,
        payload: {
          id: skill.enterprise_skill_id ?? undefined,
          name: localName,
          updatedAt: this.normalizeDateTime(skill.updated_at) ?? undefined,
          // Truncate description to server max (1024 chars)
          description: skill.description.slice(0, 1024),
          // Truncate content to server max (500KB)
          content: skill.content.slice(0, 500_000),
          confidence: typeof skill.confidence === 'number'
            ? Math.max(0, Math.min(1, skill.confidence))
            : undefined,
          uses: typeof skill.uses === 'number' && skill.uses >= 0
            ? Math.floor(skill.uses)
            : undefined,
          // What this machine accrued since its own last sync. The server ADDS
          // this, so two machines each using a skill sum correctly. Sending the
          // absolute count instead loses the smaller side, because the server
          // can only take the max of two absolute numbers.
          usesDelta: this.usesSinceLastSync(skill),
          lastUsed: this.normalizeDateTime(skill.last_used),
          tags: Array.isArray(skill.tags) ? skill.tags : undefined
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
    let batchFailed = false

    // Server ids and names the server refused. Their usage delta was NOT
    // applied, so the local usage baseline must not advance for them, or the
    // usage they represent is lost for good.
    const conflictedIds = new Set<string>()
    const conflictedNames = new Set<string>()
    const noteConflicts = (r: { conflicts?: Array<{ id?: string; name: string; reason: string }> }): void => {
      for (const c of r.conflicts ?? []) {
        if (c.id) conflictedIds.add(c.id)
        conflictedNames.add(c.name)
        console.log(
          `[EnterpriseSyncManager] Server refused "${c.name}": ${c.reason}`
        )
      }
    }

    if (skillsToSync.length > 0) {
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
          noteConflicts(batchResult)
          console.log(
            `[EnterpriseSyncManager] Batch chunk ${i + 1}/${chunks.length}: created=${batchResult.created}, updated=${batchResult.updated}, total_skills=${batchResult.skills.length}`
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[EnterpriseSyncManager] Batch chunk ${i + 1} failed (${msg}), falling back to one-by-one upload`)

          // Batch failed (likely validation) — try each skill individually
          // so valid ones still get uploaded and only truly invalid ones are skipped
          for (const singlePayload of payloads) {
            try {
              const singleResult = await this.apiClient.batchSyncSkills([singlePayload])
              totalCreated += singleResult.created
              totalUpdated += singleResult.updated
              allServerSkills = singleResult.skills
              noteConflicts(singleResult)
            } catch (singleErr) {
              batchFailed = true
              const singleMsg = singleErr instanceof Error ? singleErr.message : String(singleErr)
              result.errors.push(`Skill "${singlePayload.name}" failed to upload: ${singleMsg}`)
              console.warn(`[EnterpriseSyncManager] Skill "${singlePayload.name}" upload failed: ${singleMsg}`)
            }
          }
        }
      }
    }

    // If we have no server skills yet (either no local skills to push, or batch
    // sync failed), fall back to listSkills so the pull phase still works.
    if (allServerSkills.length === 0) {
      console.log(
        `[EnterpriseSyncManager] No server skills from batch sync (batchFailed=${batchFailed}, localCount=${skillsToSync.length}), falling back to listSkills`
      )
      try {
        allServerSkills = await this.apiClient.listSkills() ?? []
        console.log(
          `[EnterpriseSyncManager] listSkills fallback returned ${allServerSkills.length} skills`
        )
      } catch (listErr) {
        const msg = listErr instanceof Error ? listErr.message : String(listErr)
        result.errors.push(`Fallback listSkills failed (domain: ${this.domain}): ${msg}`)
      }
    }

    result.skills.pushed = totalCreated + totalUpdated

    // Build id→ and name→server skill maps for linking local skills
    const serverSkillById = new Map<string, WorkfloSkill>()
    const serverSkillByName = new Map<string, WorkfloSkill>()
    for (const s of allServerSkills) {
      serverSkillById.set(s.id, s)
      if (!serverSkillByName.has(s.name)) {
        serverSkillByName.set(s.name, s)
      }
    }

    // Link local skills to their server counterparts and collect IDs for node
    // assignment. Resolve by id first so that a renamed skill stays linked to
    // the same server row instead of adopting a same-named stranger.
    const pushedSkillIds: string[] = []
    for (const { localId, payload } of skillsToSync) {
      const serverSkill =
        (payload.id ? serverSkillById.get(payload.id) : undefined) ??
        serverSkillByName.get(payload.name)
      if (serverSkill) {
        // Update local record with server ID and sync baseline. This is a
        // metadata-only write, so it must not disturb `updated_at` — that
        // timestamp is the conflict token for the next sync.
        const localSkill = localSkills.find((s) => s.id === localId)
        if (localSkill) {
          const refused =
            conflictedIds.has(serverSkill.id) ||
            conflictedNames.has(payload.name)

          this.db.updateSkill(localId, {
            enterprise_skill_id: serverSkill.id,
            // Only move the usage baseline when the server actually accepted
            // the item. Advancing it after a refusal would discard the usage
            // this machine reported but the server never added.
            ...(refused ? {} : { uses_at_last_sync: localSkill.uses })
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
      id?: string
      name: string
      description: string
      content: string
      confidence?: number
      uses?: number
      usesDelta?: number
      lastUsed?: string | null
      updatedAt?: string
      tags?: string[]
    }>
  ): Promise<BatchSyncSkillsResult> {
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
    node: WorkfloOrgNode,
    pushedSkillIds: string[],
    removedSkillIds: Set<string>,
    result: EnterpriseSyncResult
  ): Promise<void> {
    const nodeId = node.id
    try {
      // The org node is shared by every member of the node, and the API replaces
      // `skillIds` wholesale. This client only knows about its OWN skills, so it
      // must MERGE into the node's current set — sending only what this client
      // pushed would delete every skill that another member or an admin added.
      const currentIds = Array.isArray(node.skillIds) ? node.skillIds : []

      const finalIds = [...new Set([...currentIds, ...pushedSkillIds])].filter(
        (id) => !removedSkillIds.has(id)
      )

      // Nothing to add and nothing to remove — don't write at all. This keeps
      // the sync idempotent and avoids pointless writes on every run.
      const unchanged =
        finalIds.length === currentIds.length &&
        finalIds.every((id) => currentIds.includes(id))

      if (unchanged) {
        console.log(
          `[EnterpriseSyncManager] assignSkillsToNode: node=${nodeId} already up to date (${currentIds.length} skills)`
        )
        return
      }

      console.log(
        `[EnterpriseSyncManager] assignSkillsToNode: node=${nodeId}, current=${currentIds.length}, final=${finalIds.length}, removed=${removedSkillIds.size}`
      )

      await this.apiClient.updateOrgNode(nodeId, {
        skillIds: finalIds
      })

      // Keep the in-memory node consistent with what the server now holds so a
      // second pass in the same run does not re-send the same write.
      node.skillIds = finalIds

      console.log(
        `[EnterpriseSyncManager] Assigned ${finalIds.length} skills to node ${nodeId}`
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Assign skills to node ${nodeId} (domain: ${this.domain}): ${msg}`)
    }
  }

  /**
   * Pull skills from the server into the local database.
   * - Skills already linked via enterprise_skill_id: update if server is newer
   * - Skills not linked: match by name (with [Workflo] prefix) or create new
   */
  private async pullServerSkills(
    serverSkills: WorkfloSkill[],
    result: EnterpriseSyncResult,
    tombstonedSkillIds: Set<string> = new Set()
  ): Promise<void> {
    for (const skill of serverSkills) {
      try {
        // Respect a local delete. Without this the skill is re-created on the
        // very next pull and the user's delete silently undoes itself.
        if (tombstonedSkillIds.has(skill.id)) continue

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
        result.errors.push(`Pull skill ${skill.name} (domain: ${this.domain}): ${msg}`)
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
   * Usage this machine has accrued since its last successful sync.
   *
   * `uses_at_last_sync` is the count at the moment the server last confirmed a
   * push. Anything above that has not been reported yet. Clamped at zero — a
   * negative would mean the local counter went backwards (a restore from an
   * older copy), and re-reporting nothing is safer than subtracting.
   */
  private usesSinceLastSync(skill: SkillRecord): number | undefined {
    const current = typeof skill.uses === 'number' ? skill.uses : 0
    const baseline =
      typeof skill.uses_at_last_sync === 'number' ? skill.uses_at_last_sync : 0
    const delta = Math.floor(current - baseline)
    return delta > 0 ? delta : undefined
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
        result.errors.push(`MCP Server ${server.name} (domain: ${this.domain}): ${msg}`)
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
    source: 'enterprise'
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
        environment: {},
        source: 'enterprise'
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
        environment: config.environment || {},
        source: 'enterprise'
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
        result.errors.push(`Task Source ${source.name} (domain: ${this.domain}): ${msg}`)
      }
    }
  }
}
