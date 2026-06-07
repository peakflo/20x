import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import type { DatabaseManager, AgentMcpServerEntry, McpServerSource, OutputFieldRecord, SecretRecord, SkillRecord, TaskRecord } from './database'
import { TaskStatus, SessionStatus, PluginActionId } from '../shared/constants'
import type { WorktreeManager } from './worktree-manager'
import type { GitHubManager } from './github-manager'
import type { GitLabManager } from './gitlab-manager'
import { OpencodeAdapter } from './adapters/opencode-adapter'
import { ClaudeCodeAdapter } from './adapters/claude-code-adapter'
import { AcpAdapter } from './adapters/acp-adapter'
import type { CodingAgentAdapter, SessionConfig, MessagePart, SessionMessage, McpServerConfig } from './adapters/coding-agent-adapter'
import { SessionStatusType, MessagePartType, MessageRole } from './adapters/coding-agent-adapter'
import { getTaskApiPort, waitForTaskApiServer } from './task-api-server'
import { randomUUID } from 'crypto'
import { registerSecretSession, unregisterSecretSession, getSecretBrokerPort, writeSecretShellWrapper } from './secret-broker'
import { registerMcpProxyTarget, getMcpAuthProxyPort } from './mcp-auth-proxy'

// Coding agent backend type enum
enum CodingAgentType {
  OPENCODE = 'opencode',
  CLAUDE_CODE = 'claude-code',
  CODEX = 'codex'
}

// Default OpenCode server URL (matches database default)
const DEFAULT_SERVER_URL = 'http://localhost:4096'
const WORKFLO_MCP_DEV_PATH = '/api/mcp/dev/mcp'

interface TodoItem {
  content: string
  status: string
}

interface AgentSession {
  id: string
  agentId: string
  taskId: string
  workspaceDir?: string
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
  createdAt: Date
  seenMessageIds: Set<string>
  seenPartIds: Set<string>
  partContentLengths: Map<string, string>
  learningMode?: boolean
  isTriageSession?: boolean
  lastAssistantText?: string
  /** Latest todo list captured from todowrite tool calls during polling. */
  todos?: TodoItem[]
  adapter?: CodingAgentAdapter
  secretSessionToken?: string
  pollingStarted?: boolean
}

function normalizeUrlPath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/'
}

function isWorkfloMcpDevServerUrl(serverUrl?: string): boolean {
  if (!serverUrl) return false

  try {
    return normalizeUrlPath(new URL(serverUrl).pathname) === WORKFLO_MCP_DEV_PATH
  } catch {
    return false
  }
}

function hasUserSuppliedAuthHeader(headers?: Record<string, string>): boolean {
  if (!headers) return false
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization' && headers[key]) return true
  }
  return false
}

/**
 * The MCP server that 20x should auto-manage (URL canonicalisation + JWT
 * injection via mcp-auth-proxy) is exactly: an enterprise-sourced row whose
 * URL points at the Workflo MCP Dev endpoint.
 *
 * Identification is by the `source` column (set by EnterpriseSyncManager
 * when the row is created — see enterprise-sync.ts and database.ts). This
 * is deterministic and immune to user-chosen names, name collisions, or
 * future renames of the canonical entry.
 *
 * The header-based defence-in-depth (`hasUserSuppliedAuthHeader`) is kept
 * for the unusual case where a row gets mislabelled as 'enterprise' but
 * the user has manually pasted in their own credential — we still honour
 * their explicit intent.
 */
function isEnterpriseMcpDevServer(mcpServer: {
  source?: McpServerSource
  url?: string | null
  headers?: Record<string, string>
}): boolean {
  if (mcpServer.source !== 'enterprise') return false
  if (hasUserSuppliedAuthHeader(mcpServer.headers)) return false
  return isWorkfloMcpDevServerUrl(mcpServer.url ?? undefined)
}

function resolveEnterpriseMcpDevUrl(currentUrl: string | undefined, enterpriseApiUrl: string): string {
  if (!currentUrl) return `${enterpriseApiUrl}${WORKFLO_MCP_DEV_PATH}`

  try {
    const current = new URL(currentUrl)
    const enterprise = new URL(enterpriseApiUrl)
    if (normalizeUrlPath(current.pathname) === WORKFLO_MCP_DEV_PATH && current.origin !== enterprise.origin) {
      return `${enterpriseApiUrl}${WORKFLO_MCP_DEV_PATH}`
    }
  } catch {
    return currentUrl
  }

  return currentUrl
}

/** Entry tracked by the centralized polling coordinator */
interface PollingEntry {
  sessionId: string
  adapter: CodingAgentAdapter
  config: SessionConfig
  seenMessageIds: Set<string>
  seenPartIds: Set<string>
  partContentLengths: Map<string, string>
  initialPromptSent?: boolean
  createdAt: number  // Timestamp to enforce grace period before IDLE transition
  hasSeenWork?: boolean  // True once we've seen at least one non-IDLE status
  lastPartReceivedAt?: number  // Timestamp of last received data — used for secondary grace period
  /** How many times the tillDone nudge has been sent for this polling cycle.
   *  Capped at MAX_TILLDONE_NUDGES to prevent infinite nudge loops. */
  tillDoneNudgeCount?: number
  /** True once the stuck-session watchdog has fired for this polling cycle.
   *  Prevents the abort message from spamming every poll tick while the
   *  backend is still transitioning from BUSY → IDLE after the abort. */
  watchdogFired?: boolean
  /** Count of consecutive poll cycles containing garbled model output
   *  (e.g. hallucinated `<｜DSML｜` tool-call markup as plain text).
   *  Once it exceeds the threshold the session is aborted immediately
   *  instead of waiting for the full watchdog timeout. */
  garbledOutputCount?: number
  /** Tracks when a tool part was first seen in "running" state (partId → timestamp).
   *  Used by the fast stuck-tool detector to abort tools that hang without producing
   *  data (e.g. cross-workspace file reads that OpenCode silently blocks). */
  runningToolFirstSeen?: Map<string, number>
}

interface MessageAttachmentRef {
  id: string
  filename: string
  size: number
  mime_type: string
}

export class AgentManager extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map()
  /** Maps old (temp) session IDs to their re-keyed (real) IDs so that
   *  stale IDs from the renderer still resolve after pollSingleSession re-keys. */
  private sessionIdRedirects: Map<string, string> = new Map()
  private db: DatabaseManager
  private mainWindow: BrowserWindow | null = null
  private adapters: Map<string, CodingAgentAdapter> = new Map()  // Adapter instances
  private worktreeManager: WorktreeManager | null = null
  private githubManager: GitHubManager | null = null
  private gitlabManager: GitLabManager | null = null
  private oauthManager: import('./oauth/oauth-manager').OAuthManager | null = null
  private enterpriseAuth: import('./enterprise-auth').EnterpriseAuth | null = null
  private externalListeners: Array<(channel: string, data: unknown) => void> = []
  private enterpriseStateSync: import('./enterprise-state-sync').EnterpriseStateSync | null = null
  private syncManager: import('./sync-manager').SyncManager | null = null

  // ── Centralized Polling Coordinator ──
  // Instead of N independent setTimeout loops (one per session),
  // a single timer sequentially polls all active sessions, preventing
  // simultaneous sync DB calls from stacking up and starving the event loop.
  private pollingEntries: Map<string, PollingEntry> = new Map()
  private pollingTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly POLL_INTERVAL_MS = 2000
  // Maximum number of entries in dedup structures (seenMessageIds, seenPartIds,
  // partContentLengths) before pruning.  These grow by 1-4+ entries per poll
  // cycle per session and are never cleaned during a session's lifetime, leading
  // to OOM crashes (heap exhaustion at ~2.9 GB) after extended sessions.
  private static readonly MAX_DEDUP_ENTRIES = 5_000
  // Maximum number of session ID redirects to keep (old temp IDs → real IDs).
  // Without a cap these grow forever across many session start/stop cycles.
  private static readonly MAX_SESSION_REDIRECTS = 200
  /** Maximum number of tillDone idle nudges per session before giving up. */
  private static readonly MAX_TILLDONE_NUDGES = 5

  /** Maximum time (ms) a session can stay BUSY with no new data before we abort it.
   *  Prevents sessions from being stuck indefinitely when a tool call hangs inside
   *  the agent process (20x is just a spectator on the HTTP prompt call). */
  private static readonly STUCK_SESSION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

  /** Maximum time (ms) a single tool can stay in "running" state before it's
   *  considered stuck. This is much shorter than the session watchdog because
   *  a single hung tool (e.g. cross-workspace file read that OpenCode silently
   *  blocks) should be aborted quickly so the agent can recover. */
  private static readonly STUCK_TOOL_TIMEOUT_MS = 90 * 1000 // 90 seconds

  // ── Event-driven nudge ──
  // When an adapter buffers new stream data it calls onDataAvailable().
  // We debounce that into a short nudge timer so the coordinator delivers
  // the data to the UI within ~50ms instead of waiting up to 2 seconds.
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly NUDGE_DELAY_MS = 50
  private pollingInProgress = false  // Prevents overlapping tick() calls
  private pollTickFn: (() => Promise<void>) | null = null  // Reference to the tick function

  // Track last sent status per session to detect transitions for OS notifications
  private lastSentStatus: Map<string, string> = new Map()

  /**
   * Maximum total characters allowed in partContentLengths values per session.
   * Exceeding this triggers pruning of the oldest entries, even if the number of
   * entries is below MAX_DEDUP_ENTRIES. This prevents OOM when message parts (e.g.
   * tool outputs) are very large.  Limit is ~10MB per session (was 100MB which
   * allowed a single session to consume most of the V8 heap).
   */
  private static readonly MAX_VALUE_CHARS_PER_SESSION = 10_000_000

  constructor(db: DatabaseManager) {
    super()
    this.db = db
  }

  /**
   * Set the enterprise state sync manager for recording agent events.
   * Called when enterprise auth succeeds.
   */
  setEnterpriseStateSync(stateSync: import('./enterprise-state-sync').EnterpriseStateSync | null): void {
    this.enterpriseStateSync = stateSync
  }

  /**
   * Set the enterprise auth instance for injecting JWT tokens into MCP Dev Server requests.
   * Called when enterprise auth succeeds.
   */
  setEnterpriseAuth(auth: import('./enterprise-auth').EnterpriseAuth | null): void {
    this.enterpriseAuth = auth
  }

  /**
   * Set the sync manager for executing enterprise actions (e.g. completing tasks on Workflo).
   * Called after both AgentManager and SyncManager are created.
   */
  setSyncManager(syncManager: import('./sync-manager').SyncManager): void {
    this.syncManager = syncManager
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  setManagers(githubManager: GitHubManager, worktreeManager: WorktreeManager, gitlabManager?: GitLabManager): void {
    this.githubManager = githubManager
    this.worktreeManager = worktreeManager
    this.gitlabManager = gitlabManager ?? null
  }

  setOAuthManager(manager: import('./oauth/oauth-manager').OAuthManager): void {
    this.oauthManager = manager
  }

  /**
   * Sets up git worktrees for a task's repos if needed.
   * Skips for mastermind sessions or tasks without repos.
   */
  private async setupWorktreeIfNeeded(taskId: string): Promise<string | undefined> {
    if (taskId === 'mastermind-session' || taskId.startsWith('heartbeat-')) return undefined

    if (!this.worktreeManager) return undefined

    const gitProvider = this.db.getSetting('git_provider') || 'github'
    const configuredOrg = this.db.getSetting('github_org')

    const task = this.db.getTask(taskId)
    if (!task) return undefined
    if (!task.repos || !Array.isArray(task.repos) || task.repos.length === 0) return undefined

    const workspaceDir = this.db.getWorkspaceDir(taskId)
    const missingRepoFolders = task.repos.some((repo) => {
      const repoName = repo.split('/').pop() || repo
      return !existsSync(join(workspaceDir, repoName))
    })

    // Triage sessions normally should not allocate worktrees, but if the user
    // starts the real agent before the task status flips out of Triaging and the
    // repo folders are missing, repair the workspace on demand.
    if (task.status === TaskStatus.Triaging && !task.session_id && !missingRepoFolders) return undefined

    try {
      console.log(`[AgentManager] setupWorktreeIfNeeded: provider=${gitProvider}, configuredOrg=${configuredOrg || 'unset'}, taskRepos=${task.repos.join(', ')}`)

      if (gitProvider === 'gitlab' && !this.gitlabManager) {
        console.warn(`[AgentManager] No ${gitProvider} manager available, skipping worktree setup`)
        return undefined
      }
      if (gitProvider !== 'gitlab' && !this.githubManager) {
        console.warn(`[AgentManager] No ${gitProvider} manager available, skipping worktree setup`)
        return undefined
      }

      const reposByOrg = new Map<string, string[]>()
      for (const repoName of task.repos) {
        const org = repoName.includes('/') ? repoName.split('/')[0] : configuredOrg
        if (!org) {
          console.warn(`[AgentManager] Skipping repo without org and no configured github_org: ${repoName}`)
          continue
        }
        const fullName = repoName.includes('/') ? repoName : `${org}/${repoName}`
        const existing = reposByOrg.get(org) || []
        existing.push(fullName)
        reposByOrg.set(org, existing)
      }

      if (reposByOrg.size === 0) return undefined

      let resolvedWorkspaceDir: string | undefined

      for (const [org, repoNames] of reposByOrg.entries()) {
        let orgRepos: Array<{ fullName: string; defaultBranch: string; cloneUrl?: string }> = []

        try {
          if (gitProvider === 'gitlab' && this.gitlabManager) {
            orgRepos = await this.gitlabManager.fetchOrgRepos(org)
          } else if (this.githubManager) {
            orgRepos = await this.githubManager.fetchOrgRepos(org)
          }
        } catch (error) {
          console.warn(`[AgentManager] Failed to fetch repo metadata for org "${org}", falling back to task repo names:`, error)
        }

        const branchByRepo = new Map(orgRepos.map((repo) => [repo.fullName, repo.defaultBranch]))
        const cloneUrlByRepo = new Map(orgRepos.map((repo) => [repo.fullName, repo.cloneUrl]))
        const reposForSetup = repoNames.map((fullName) => ({
          fullName,
          defaultBranch: branchByRepo.get(fullName) || 'main',
          cloneUrl: cloneUrlByRepo.get(fullName)
        }))

        console.log(`[AgentManager] Setting up ${reposForSetup.length} repo(s) for org "${org}": ${reposForSetup.map((repo) => repo.fullName).join(', ')}`)

        const workspaceDirForOrg = await this.worktreeManager.setupWorkspaceForTask(
          taskId,
          reposForSetup,
          org,
          gitProvider
        )
        resolvedWorkspaceDir = resolvedWorkspaceDir || workspaceDirForOrg
      }

      return resolvedWorkspaceDir
    } catch (error) {
      console.error(`[AgentManager] Worktree setup failed for ${gitProvider}:`, error)
      return undefined
    }
  }

  /**
   * Gets or creates the appropriate adapter for an agent based on its coding_agent config.
   * Returns null if agent uses OpenCode (handled by legacy code path).
   */
  private getAdapter(agentId: string): CodingAgentAdapter | null {
    const agent = this.db.getAgent(agentId)
    if (!agent) return null

    const backendType = (agent.config?.coding_agent as string) || CodingAgentType.OPENCODE
    console.log('[AgentManager] getAdapter - backendType:', backendType)

    // Return cached adapter
    if (this.adapters.has(backendType)) {
      console.log('[AgentManager] getAdapter - returning cached adapter for', backendType)
      return this.adapters.get(backendType)!
    }

    // Create new adapter
    let adapter: CodingAgentAdapter

    switch (backendType) {
      case CodingAgentType.OPENCODE:
        console.log('[AgentManager] Creating new OpencodeAdapter')
        adapter = new OpencodeAdapter(this.db)
        break
      case CodingAgentType.CLAUDE_CODE:
        console.log('[AgentManager] Creating new ClaudeCodeAdapter')
        adapter = new ClaudeCodeAdapter()
        break
      case CodingAgentType.CODEX:
        console.log('[AgentManager] Creating new AcpAdapter for Codex')
        adapter = new AcpAdapter('codex')
        break
      default:
        console.warn(`[AgentManager] Unknown coding agent type: ${backendType}`)
        return null
    }

    this.adapters.set(backendType, adapter)
    console.log('[AgentManager] Cached adapter for', backendType)
    return adapter
  }

  /**
   * Builds MCP servers config for adapters (Claude Code, etc.)
   * Converts from database format to adapter format
   */
  private async buildMcpServersForAdapter(agentId: string, opts?: { ensureTaskManagement?: boolean; taskScope?: { taskId: string; parentTaskId: string } }): Promise<Record<string, McpServerConfig>> {
    const agent = this.db.getAgent(agentId)
    const mcpEntries = agent?.config?.mcp_servers || []
    const result: Record<string, McpServerConfig> = {}
    // Ensure the task API server is ready before building MCP configs
    // (startTaskApiServer is fire-and-forget during DB init, may not be done yet)
    await waitForTaskApiServer()

    // Yield after waitForTaskApiServer + db.getAgent (sync) so the event
    // loop can process rendering before we enter the MCP server loop.
    await new Promise<void>((r) => setImmediate(r))

    for (const entry of mcpEntries) {
      const serverId = typeof entry === 'string' ? entry : (entry as AgentMcpServerEntry).serverId
      const mcpServer = this.db.getMcpServer(serverId)
      if (!mcpServer) continue

      if (mcpServer.type === 'local') {
        // Inject TASK_API_URL for the task-management MCP server
        let env = { ...mcpServer.environment }
        if (mcpServer.name === 'task-management') {
          const apiPort = getTaskApiPort()
          if (apiPort) {
            env = { ...env, TASK_API_URL: `http://127.0.0.1:${apiPort}` }
          } else {
            console.warn(`[AgentManager] buildMcpServersForAdapter - task API port is null for task-management server`)
          }
          // Inject task scope for subtask agents (restricts access to parent + siblings only)
          if (opts?.taskScope) {
            env = { ...env, TASK_SCOPE_PARENT_ID: opts.taskScope.parentTaskId, TASK_SCOPE_TASK_ID: opts.taskScope.taskId }
          }
        }

        result[mcpServer.name] = {
          type: 'stdio',
          command: mcpServer.command,
          args: mcpServer.args,
          env
        }
      } else if (mcpServer.type === 'remote') {
        // Inject OAuth Bearer token if the server has one
        let finalHeaders = { ...mcpServer.headers }
        if (this.oauthManager && mcpServer.oauth_metadata && 'resource_url' in mcpServer.oauth_metadata) {
          const token = await this.oauthManager.getValidMcpServerToken(mcpServer.id)
          if (token) {
            finalHeaders = { ...finalHeaders, Authorization: `Bearer ${token}` }
          }
        }

        // Inject enterprise JWT for Workflo MCP Dev Server — route through auth proxy
        let finalUrl = mcpServer.url
        if (
          this.enterpriseAuth &&
          isEnterpriseMcpDevServer({ source: mcpServer.source, url: mcpServer.url, headers: finalHeaders })
        ) {
          finalUrl = resolveEnterpriseMcpDevUrl(mcpServer.url, this.enterpriseAuth.getApiUrl())
          const proxyPort = getMcpAuthProxyPort()
          const proxyUrl = proxyPort ? registerMcpProxyTarget(finalUrl, mcpServer.name) : null
          if (proxyUrl) {
            finalUrl = proxyUrl
            // Don't send static Authorization — proxy injects fresh JWT per request
            delete finalHeaders['Authorization']
            console.log(`[AgentManager] MCP Dev Server routed through auth proxy: ${proxyUrl} -> ${resolveEnterpriseMcpDevUrl(mcpServer.url, this.enterpriseAuth.getApiUrl())}`)
          } else {
            // Fallback: static JWT (proxy not running)
            try {
              const jwt = await this.enterpriseAuth.getJwt()
              finalHeaders = { ...finalHeaders, Authorization: `Bearer ${jwt}` }
              console.log('[AgentManager] MCP Dev Server using static JWT (proxy not available)')
            } catch (err) {
              console.warn('[AgentManager] Failed to inject enterprise JWT for MCP Dev Server:', err)
            }
          }
        }

        result[mcpServer.name] = {
          type: 'http',
          url: finalUrl,
          headers: finalHeaders
        }
      }
    }

    // Always include task-management for mastermind/triage sessions
    if (opts?.ensureTaskManagement && !result['task-management']) {
      const allServers = this.db.getMcpServers()
      const tmServer = allServers.find(s => s.name === 'task-management')
      if (tmServer && tmServer.type === 'local') {
        const apiPort = getTaskApiPort()
        if (!apiPort) {
          console.warn('[AgentManager] buildMcpServersForAdapter - task API port is null! MCP server may fail to start')
        }
        const env: Record<string, string> = { ...tmServer.environment, ...(apiPort ? { TASK_API_URL: `http://127.0.0.1:${apiPort}` } : {}) }
        if (opts?.taskScope) {
          env.TASK_SCOPE_PARENT_ID = opts.taskScope.parentTaskId
          env.TASK_SCOPE_TASK_ID = opts.taskScope.taskId
        }
        result['task-management'] = {
          type: 'stdio',
          command: tmServer.command,
          args: tmServer.args,
          env
        }
        // force-included task-management MCP
      } else {
        console.warn(`[AgentManager] buildMcpServersForAdapter - task-management server not found in DB`)
      }
    }

    return result
  }

  private async buildSessionConfig(agentId: string, taskId: string, workspaceDir?: string): Promise<SessionConfig> {
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const isMastermind = taskId === 'mastermind-session'
    const task = this.db.getTask(taskId)
    const isTriageSession = this.isTriageSessionTask(taskId, task)
    const isSubtask = !!task?.parent_task_id
    const taskScope = isSubtask && task?.parent_task_id ? { taskId, parentTaskId: task.parent_task_id } : undefined
    const mcpServers = await this.buildMcpServersForAdapter(agentId, { ensureTaskManagement: isMastermind || isTriageSession || isSubtask, taskScope })

    // Build system prompt with task context so follow-up messages after idle
    // retain awareness of what task the agent is working on. Without this,
    // doSendAdapterMessage sends a bare prompt and the agent loses context.
    const baseSystemPrompt = agent.config?.system_prompt || ''
    const taskContext = task
      ? `\n\n[Task Context]\nTask: "${task.title}"\n${task.description || ''}`
      : ''

    const config: SessionConfig = {
      agentId,
      taskId,
      workspaceDir: workspaceDir || this.db.getWorkspaceDir(taskId),
      model: agent.config?.model,
      systemPrompt: baseSystemPrompt + taskContext,
      mcpServers,
      authMethod: agent.config?.auth_method,
      permissionMode: agent.config?.permission_mode,
      apiKeys: agent.config?.api_keys,
      tillDone: this.shouldEnableTillDone(taskId, task)
    }

    // Attach secret broker info if agent session has an active secret token
    const session = this.findSessionByTask(agentId, taskId)
    if (session?.secretSessionToken) {
      const brokerPort = getSecretBrokerPort()
      if (brokerPort) {
        config.secretBrokerPort = brokerPort
        config.secretSessionToken = session.secretSessionToken
        config.secretShellPath = writeSecretShellWrapper()
      }
    }

    // Populate secret env vars and system prompt awareness
    const secretIds = agent.config?.secret_ids
    // secretIds checked for agent config
    if (secretIds && secretIds.length > 0) {
      const secretRecords = this.db.getSecretsByIds(secretIds)
      const secretsWithValues = this.db.getSecretsWithValues(secretIds)

      // Attach decrypted values for injection (hooks or direct env)
      if (secretsWithValues.length > 0) {
        config.secretEnvVars = {}
        for (const s of secretsWithValues) {
          config.secretEnvVars[s.env_var_name] = s.value
        }
      }

      // Append secret awareness to system prompt so the agent knows what's available
      if (secretRecords.length > 0) {
        config.systemPrompt = (config.systemPrompt || '') + this.buildSecretsSystemPrompt(secretRecords)
      }
    }

    return config
  }

  private shouldEnableTillDone(taskId: string, task?: TaskRecord | null): boolean {
    if (taskId === 'mastermind-session') return false
    if (taskId.startsWith('heartbeat-')) return false
    if (this.isTriageSessionTask(taskId, task)) return false
    if (task?.status === TaskStatus.AgentLearning) return false
    return true
  }

  private isTriageSessionTask(taskId: string, task?: TaskRecord | null): boolean {
    if (!task) return false
    if (taskId === 'mastermind-session') return false
    if (taskId.startsWith('heartbeat-')) return false
    return task.status === TaskStatus.Triaging ||
      (Object.prototype.hasOwnProperty.call(task, 'agent_id') && !task.agent_id)
  }

  /**
   * Returns the memory file name for an agent based on its type.
   * Claude Code agents use CLAUDE.md; all other agents use AGENTS.md.
   */
  /**
   * Syncs task attachments from the database storage directory into the workspace.
   * Returns an array of relative path references (e.g., "- attachments/file.pdf")
   * for use in prompts. Safe to call multiple times — already-copied files are
   * overwritten (cheap for small attachments, guarantees freshness).
   */
  private syncAttachmentsToWorkspace(taskId: string, workspaceDir: string): string[] {
    const task = this.db.getTask(taskId)
    const refs: string[] = []
    if (!task?.attachments?.length) return refs

    const attachDir = this.db.getAttachmentsDir(taskId)
    const destDir = join(workspaceDir, 'attachments')
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

    for (const att of task.attachments) {
      const srcPath = join(attachDir, `${att.id}-${att.filename}`)
      if (!existsSync(srcPath)) continue
      const destPath = join(destDir, att.filename)
      try {
        copyFileSync(srcPath, destPath)
        refs.push(`- attachments/${att.filename}`)
      } catch {
        continue
      }
    }
    return refs
  }

  private getMemoryFileName(agentId: string): string {
    const agent = this.db.getAgent(agentId)
    const backendType = (agent?.config?.coding_agent as string) || CodingAgentType.OPENCODE
    return backendType === CodingAgentType.CLAUDE_CODE ? 'CLAUDE.md' : 'AGENTS.md'
  }

  private formatAttachmentSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  private isTextAttachment(mimeType: string, filename: string): boolean {
    if (mimeType.startsWith('text/')) return true
    const lower = filename.toLowerCase()
    return (
      lower.endsWith('.md') ||
      lower.endsWith('.txt') ||
      lower.endsWith('.json') ||
      lower.endsWith('.yaml') ||
      lower.endsWith('.yml') ||
      lower.endsWith('.xml') ||
      lower.endsWith('.csv') ||
      lower.endsWith('.ts') ||
      lower.endsWith('.tsx') ||
      lower.endsWith('.js') ||
      lower.endsWith('.jsx') ||
      lower.endsWith('.py') ||
      lower.endsWith('.java') ||
      lower.endsWith('.go') ||
      lower.endsWith('.rb') ||
      lower.endsWith('.rs') ||
      lower.endsWith('.sql')
    )
  }

  private buildMessageWithAttachmentContext(
    session: AgentSession,
    message: string,
    attachments?: MessageAttachmentRef[]
  ): string {
    if (!attachments || attachments.length === 0) return message

    const capped = attachments.slice(0, 10)
    const omittedCount = attachments.length - capped.length
    const refs = capped.map(
      (att) => `- attachments/${att.filename} (${att.mime_type || 'application/octet-stream'}, ${this.formatAttachmentSize(att.size)})`
    )

    const previewBlocks: string[] = []
    const MAX_PREVIEWS = 3
    const MAX_PREVIEW_FILE_SIZE = 24 * 1024
    const MAX_PREVIEW_CHARS = 1200
    const workspaceDir = session.workspaceDir

    if (workspaceDir) {
      for (const att of capped) {
        if (previewBlocks.length >= MAX_PREVIEWS) break
        if (!this.isTextAttachment(att.mime_type || '', att.filename)) continue
        if (att.size > MAX_PREVIEW_FILE_SIZE) continue

        const absPath = join(workspaceDir, 'attachments', att.filename)
        if (!existsSync(absPath)) continue

        try {
          const text = readFileSync(absPath, 'utf-8')
          const truncated = text.slice(0, MAX_PREVIEW_CHARS)
          const suffix = text.length > MAX_PREVIEW_CHARS ? '\n...[truncated]' : ''
          previewBlocks.push(`### attachments/${att.filename}\n\`\`\`\n${truncated}${suffix}\n\`\`\``)
        } catch {
          continue
        }
      }
    }

    let attachmentContext = '\n\nMessage attachments (already available in your workspace):\n'
    attachmentContext += refs.join('\n')
    if (omittedCount > 0) {
      attachmentContext += `\n- ... and ${omittedCount} more attachment(s) omitted to keep context focused`
    }
    attachmentContext += '\n\nContext loading guidance:'
    attachmentContext += '\n- Start with only the listed files relevant to the user request.'
    attachmentContext += '\n- Do not load full file contents unless necessary.'
    attachmentContext += '\n- For large/binary files, inspect metadata or selective excerpts first.'

    if (previewBlocks.length > 0) {
      attachmentContext += '\n\nSmall text previews (use only if relevant):\n'
      attachmentContext += previewBlocks.join('\n\n')
    }

    return `${message}${attachmentContext}`
  }

  private buildDisplayMessage(message: string, attachments?: MessageAttachmentRef[]): string {
    if (!attachments || attachments.length === 0) return message
    const capped = attachments.slice(0, 10)
    const omittedCount = attachments.length - capped.length
    const refs = capped.map((att) => `- ${att.filename}`)
    const omitted = omittedCount > 0 ? `\n- ... and ${omittedCount} more` : ''
    return `${message}\n\nAttached to this message:\n${refs.join('\n')}${omitted}`
  }

  /**
   * Builds a system prompt snippet describing available secrets.
   * Tells the agent which env vars exist and how to use them in bash commands.
   */
  private buildSecretsSystemPrompt(secrets: SecretRecord[]): string {
    let prompt = '\n\n## Available Secrets\n\n'
    prompt += 'The following environment variables are automatically injected into every bash command you run. '
    prompt += 'Use them with `$VAR_NAME` in bash — do NOT hardcode, echo, or log their values.\n\n'
    for (const s of secrets) {
      prompt += `- \`$${s.env_var_name}\` — ${s.name}`
      if (s.description) prompt += `: ${s.description}`
      prompt += '\n'
    }
    return prompt
  }

  /**
   * Sets up a secret broker session for an agent, registering its secrets.
   * Returns the token, or undefined if no secrets are configured.
   */
  private setupSecretSession(agentId: string): string | undefined {
    const agent = this.db.getAgent(agentId)
    const secretIds = agent?.config?.secret_ids
    if (!secretIds || secretIds.length === 0) return undefined

    const brokerPort = getSecretBrokerPort()
    if (!brokerPort) {
      console.warn('[AgentManager] Secret broker not running — secrets will not be injected')
      return undefined
    }

    const token = randomUUID()
    registerSecretSession(token, agentId, secretIds)
    console.log(`[AgentManager] Secret session registered for agent ${agentId} with ${secretIds.length} secret(s)`)
    return token
  }

  /** Find an active session by agentId and taskId */
  private findSessionByTask(agentId: string, taskId: string): AgentSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.agentId === agentId && session.taskId === taskId) {
        return session
      }
    }
    return undefined
  }

  /**
   * Sanitizes a string for safe use as a YAML double-quoted scalar.
   * Escapes backslashes and double quotes so the value can be wrapped in
   * double quotes in the frontmatter template.  This avoids the class of
   * bugs where colons, brackets, or other YAML-special characters in skill
   * names/descriptions cause "mapping values are not allowed" parse errors
   * (e.g. a description containing "latest: true" or a name like "[Workflo] foo").
   */
  private static sanitizeYamlValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim()
  }

  /**
   * Resolves and writes SKILL.md files to the workspace directory.
   * Priority: task.skill_ids > agent.config.skill_ids > all skills.
   * Also generates AGENTS.md and CLAUDE.md with skill directory.
   */
  private async writeSkillFiles(taskId: string, agentId: string, workspaceDir: string): Promise<void> {
    try {
      const task = this.db.getTask(taskId)
      const agent = this.db.getAgent(agentId)
      const agentConfig = agent?.config

      // Resolve which skill IDs to use
      let skillIds: string[] | undefined
      if (task?.skill_ids !== null && task?.skill_ids !== undefined) {
        skillIds = task.skill_ids
      } else if (agentConfig?.skill_ids !== undefined) {
        skillIds = agentConfig.skill_ids
      }
      // undefined = all skills

      const skills = skillIds === undefined
        ? this.db.getSkills()
        : this.db.getSkillsByIds(skillIds)

      // Write individual SKILL.md files using async I/O so the event loop
      // can process IPC/rendering between writes (avoids startup UI freeze).
      // Claude Code agent: .claude/skills/<name>/SKILL.md
      // Other agents: .agents/skills/<name>/SKILL.md
      if (skills.length > 0) {
        const backendType = (agentConfig?.coding_agent as string) || CodingAgentType.OPENCODE
        const isClaudeCode = backendType === CodingAgentType.CLAUDE_CODE
        const skillsDir = isClaudeCode
          ? join(workspaceDir, '.claude', 'skills')
          : join(workspaceDir, '.agents', 'skills')
        for (const skill of skills) {
          const dir = join(skillsDir, skill.name)
          await mkdir(dir, { recursive: true })
          const safeName = AgentManager.sanitizeYamlValue(skill.name)
          const desc = skill.description || skill.name
          const safeDesc = AgentManager.sanitizeYamlValue(desc)
          const content = `---\nname: "${safeName}"\ndescription: "${safeDesc}"\n---\n\n${skill.content}`
          await writeFile(join(dir, 'SKILL.md'), content, 'utf-8')
        }
        console.log(`[AgentManager] Wrote ${skills.length} SKILL.md file(s) to ${skillsDir}`)
      }

      // Generate AGENTS.md and CLAUDE.md with skill directory
      await this.writeAgentsDocumentation(workspaceDir, skills, task?.repos || [], agentId)
    } catch (error) {
      console.error('[AgentManager] Error writing skill files:', error)
    }
  }

  /**
   * Generates AGENTS.md and CLAUDE.md with skill directory and metadata.
   * Both files are written to the workspace root directory.
   */
  private async writeAgentsDocumentation(
    workspaceDir: string,
    skills: SkillRecord[],
    repos: string[],
    agentId?: string
  ): Promise<void> {
    try {
      // Sort skills by confidence (high to low)
      const sortedSkills = [...skills].sort((a, b) => b.confidence - a.confidence)

      // Generate AGENTS.md — write to workspace root (async to avoid blocking)
      const agentsMd = this.generateAgentsMd(sortedSkills, repos, workspaceDir, agentId)
      await writeFile(join(workspaceDir, 'AGENTS.md'), agentsMd, 'utf-8')

      // Generate CLAUDE.md — write to workspace root
      const claudeMd = this.generateClaudeMd(sortedSkills, repos, workspaceDir, agentId)
      await writeFile(join(workspaceDir, 'CLAUDE.md'), claudeMd, 'utf-8')

      console.log('[AgentManager] Generated AGENTS.md and CLAUDE.md in workspace root')
    } catch (error) {
      console.error('[AgentManager] Error writing agent documentation:', error)
    }
  }

  /**
   * Generates AGENTS.md content with skill directory.
   */
  private generateAgentsMd(skills: SkillRecord[], repos: string[], workspaceDir: string, agentId?: string): string {
    const now = new Date().toISOString()

    let md = `# Agent Session Configuration\n\n`
    md += `**Generated:** ${now}\n`
    md += `---\n\n`

    // Add MCP Servers section
    if (agentId) {
      const agent = this.db.getAgent(agentId)
      if (agent?.config?.mcp_servers && agent.config.mcp_servers.length > 0) {
        md += `## Available MCP Servers & Tools\n\n`
        md += `This session has access to the following Model Context Protocol (MCP) servers and their tools:\n\n`

        for (const entry of agent.config.mcp_servers) {
          const serverId = typeof entry === 'string' ? entry : (entry as AgentMcpServerEntry).serverId
          const enabledTools = typeof entry === 'string' ? undefined : (entry as AgentMcpServerEntry).enabledTools
          const mcpServer = this.db.getMcpServer(serverId)
          if (!mcpServer) continue

          md += `### ${mcpServer.name}\n\n`
          md += `**Type:** ${mcpServer.type === 'local' ? 'Local (stdio)' : 'Remote (HTTP)'}\n\n`

          if (mcpServer.type === 'local') {
            md += `**Command:** \`${mcpServer.command} ${mcpServer.args.join(' ')}\`\n\n`
          } else {
            md += `**URL:** \`${mcpServer.url}\`\n\n`
          }

          if (mcpServer.tools && mcpServer.tools.length > 0) {
            const toolsToShow = enabledTools
              ? mcpServer.tools.filter(t => enabledTools.includes(t.name))
              : mcpServer.tools

            md += `**Available Tools (${toolsToShow.length}):**\n\n`
            for (const tool of toolsToShow) {
              md += `- **\`${tool.name}\`** - ${tool.description}\n`
            }
            md += `\n`
          }

          md += `---\n\n`
        }
      }
    }

    // Add secrets section — name and description only, never the value
    if (agentId) {
      const agent2 = this.db.getAgent(agentId)
      const secretIds = agent2?.config?.secret_ids
      if (secretIds && secretIds.length > 0) {
        const secrets = this.db.getSecretsByIds(secretIds)
        if (secrets.length > 0) {
          md += `## Available Secrets\n\n`
          md += `The following secrets are automatically injected as environment variables into every shell/bash command you run.\n`
          md += `They are managed by the user and securely provided at runtime — you MUST NOT hardcode, echo, log, or ask the user for these values.\n\n`
          md += `### How to use\n\n`
          md += `Reference them with \`$VAR_NAME\` in any bash command. Examples:\n\n`
          md += `\`\`\`bash\n`
          md += `# Connect to a database\n`
          md += `psql "$DATABASE_URL"\n\n`
          md += `# Use an API key in a curl request\n`
          md += `curl -H "Authorization: Bearer $API_KEY" https://api.example.com\n\n`
          md += `# Pass to a script\n`
          md += `python deploy.py --token "$DEPLOY_TOKEN"\n`
          md += `\`\`\`\n\n`
          md += `**Important:** Secrets are ONLY available inside bash/shell commands. They are not in your process environment or accessible via tool arguments.\n\n`
          md += `### Available secrets\n\n`
          for (const secret of secrets) {
            md += `- **\`$${secret.env_var_name}\`** — ${secret.name}`
            if (secret.description) md += `: ${secret.description}`
            md += `\n`
          }
          md += `\n---\n\n`
        }
      }
    }

    // Add repository information
    if (repos.length > 0) {
      md += `## Repositories\n\n`
      md += `This task has ${repos.length} repository/repositories checked out in the workspace:\n\n`
      for (const repo of repos) {
        const repoName = repo.split('/').pop() || repo
        const repoPath = `${repoName}/`
        md += `- **${repo}** → \`${repoPath}\`\n`
      }
      md += `\n`
      md += `**Workspace Directory:** \`${workspaceDir}\`\n\n`
      md += `**Important:** All repository code is in subdirectories. For example, to access files in ${repos[0].split('/').pop()}, use \`${repos[0].split('/').pop()}/src/...\` as paths.\n\n`
      md += `---\n\n`
    }

    md += `## Available Skills\n\n`

    if (skills.length === 0) {
      md += `No skills configured for this session.\n\n`
    } else {
      md += `This session has access to ${skills.length} skill(s), sorted by confidence level:\n\n`

      for (const skill of skills) {
        const confidencePercent = (skill.confidence * 100).toFixed(0)
        const lastUsed = skill.last_used ? new Date(skill.last_used).toISOString().split('T')[0] : 'Never'
        const tags = skill.tags && skill.tags.length > 0 ? skill.tags.join(', ') : 'none'

        md += `### [${skill.name}](.agents/skills/${skill.name}/SKILL.md)\n\n`
        md += `**Confidence:** ${confidencePercent}% | **Uses:** ${skill.uses} | **Last Used:** ${lastUsed}\n\n`
        md += `**Tags:** ${tags}\n\n`
        md += `${skill.description}\n\n`
        md += `---\n\n`
      }
    }

    return md
  }

  /**
   * Generates CLAUDE.md content with skill directory.
   */
  private generateClaudeMd(skills: SkillRecord[], repos: string[], workspaceDir: string, agentId?: string): string {
    const now = new Date().toISOString()

    let md = `# Claude Code Configuration\n\n`
    md += `**Session Started:** ${now}\n`
    md += `---\n\n`

    // Add MCP Servers section
    if (agentId) {
      const agent = this.db.getAgent(agentId)
      if (agent?.config?.mcp_servers && agent.config.mcp_servers.length > 0) {
        md += `## MCP Tools Available\n\n`
        md += `You have access to the following tools through Model Context Protocol (MCP) servers:\n\n`

        for (const entry of agent.config.mcp_servers) {
          const serverId = typeof entry === 'string' ? entry : (entry as AgentMcpServerEntry).serverId
          const enabledTools = typeof entry === 'string' ? undefined : (entry as AgentMcpServerEntry).enabledTools
          const mcpServer = this.db.getMcpServer(serverId)
          if (!mcpServer) continue

          if (mcpServer.tools && mcpServer.tools.length > 0) {
            const toolsToShow = enabledTools
              ? mcpServer.tools.filter(t => enabledTools.includes(t.name))
              : mcpServer.tools

            md += `### ${mcpServer.name} (${toolsToShow.length} tools)\n\n`

            for (const tool of toolsToShow) {
              md += `#### \`${tool.name}\`\n\n`
              md += `${tool.description}\n\n`
            }
          }
        }

        md += `---\n\n`
      }
    }

    // Add secrets section — name and description only, never the value
    if (agentId) {
      const agentForSecrets = this.db.getAgent(agentId)
      const secretIds = agentForSecrets?.config?.secret_ids
      if (secretIds && secretIds.length > 0) {
        const secrets = this.db.getSecretsByIds(secretIds)
        if (secrets.length > 0) {
          md += `## Available Secrets\n\n`
          md += `The following secrets are automatically injected as environment variables into every bash command you execute.\n`
          md += `They are securely managed — you MUST NOT hardcode, echo, print, log, or ask the user for these values.\n\n`
          md += `### Usage\n\n`
          md += `Use \`$VAR_NAME\` directly in any bash command:\n\n`
          md += `\`\`\`bash\n`
          md += `# They are already set — just reference them\n`
          md += `psql "$DATABASE_URL"\n`
          md += `curl -H "Authorization: Bearer $API_KEY" https://api.example.com\n`
          md += `python deploy.py --token "$DEPLOY_TOKEN"\n`
          md += `\`\`\`\n\n`
          md += `**Important:** Secrets are ONLY available inside bash/shell commands (the Bash tool). They are not accessible in your own process environment, tool arguments, or file contents.\n\n`
          md += `### Available secrets\n\n`
          for (const secret of secrets) {
            md += `- **\`$${secret.env_var_name}\`** — ${secret.name}`
            if (secret.description) md += `: ${secret.description}`
            md += `\n`
          }
          md += `\n---\n\n`
        }
      }
    }

    // Add repository information
    if (repos.length > 0) {
      md += `## Workspace Structure\n\n`
      md += `Your working directory is \`${workspaceDir}\`\n\n`
      md += `This task has ${repos.length} repository/repositories checked out:\n\n`
      for (const repo of repos) {
        const repoName = repo.split('/').pop() || repo
        md += `- **${repo}** is checked out in \`./${repoName}/\`\n`
      }
      md += `\n`
      md += `**IMPORTANT:** All repository code is in subdirectories, not in the root workspace directory. When reading or editing files, use paths like \`${repos[0].split('/').pop()}/src/...\`, not just \`src/...\`\n\n`
      md += `---\n\n`
    }

    md += `## Skills Reference\n\n`

    if (skills.length === 0) {
      md += `No skills are available for this session.\n\n`
    } else {
      md += `You have access to ${skills.length} specialized skill(s). Each skill contains proven patterns and approaches from previous successful sessions.\n\n`
      md += `### Quick Reference\n\n`

      for (const skill of skills) {
        const confidencePercent = (skill.confidence * 100).toFixed(0)
        md += `- **[${skill.name}](.claude/skills/${skill.name}/SKILL.md)** (${confidencePercent}% confidence)\n`
        md += `  ${skill.description}\n\n`
      }

      md += `### Detailed Skills\n\n`

      for (const skill of skills) {
        const confidencePercent = (skill.confidence * 100).toFixed(0)
        const lastUsed = skill.last_used ? new Date(skill.last_used).toISOString().split('T')[0] : 'Never'

        md += `#### ${skill.name}\n\n`
        md += `**Path:** [.claude/skills/${skill.name}/SKILL.md](.claude/skills/${skill.name}/SKILL.md)\n\n`
        md += `**Confidence:** ${confidencePercent}%\n\n`
        md += `**Description:** ${skill.description}\n\n`
        md += `**Usage Stats:** ${skill.uses} uses | Last used: ${lastUsed}\n\n`

        if (skill.tags && skill.tags.length > 0) {
          md += `**Tags:** ${skill.tags.map((t: string) => `\`${t}\``).join(', ')}\n\n`
        }

        md += `---\n\n`
      }
    }

    md += `## Usage Notes\n\n`
    md += `- Skills are sorted by confidence level (highest first)\n`
    md += `- Confidence indicates how well the skill has performed in past sessions\n`
    md += `- Higher usage count suggests more battle-tested approaches\n`
    md += `- Check the SKILL.md files for detailed implementation guidance\n\n`

    return md
  }

  async stopServer(): Promise<void> {
    // Delegate to the OpenCode adapter if it exists
    const adapter = this.adapters.get(CodingAgentType.OPENCODE)
    if (adapter && 'stopServer' in adapter && typeof (adapter as { stopServer: () => Promise<void> }).stopServer === 'function') {
      console.log('[AgentManager] Delegating server stop to OpencodeAdapter')
      await (adapter as { stopServer: () => Promise<void> }).stopServer()
    }
  }

  /**
   * Starts a session using a coding agent adapter (Claude Code, etc.)
   */
  private async startAdapterSession(
    adapter: CodingAgentAdapter,
    agentId: string,
    taskId: string,
    workspaceDir?: string,
    skipInitialPrompt?: boolean
  ): Promise<string> {
    // Helper: yield event loop between bursts of synchronous DB / FS calls
    // so the renderer can process IPC and paint frames during session setup.
    const yieldEL = (): Promise<void> => new Promise((r) => setImmediate(r))

    const agent = this.db.getAgent(agentId)!

    // Always use a dedicated workspace directory
    if (!workspaceDir) {
      workspaceDir = this.db.getWorkspaceDir(taskId)
    }

    // Write SKILL.md files to workspace (async to avoid blocking the event loop)
    await this.writeSkillFiles(taskId, agentId, workspaceDir)

    // Check if this is a triage session or subtask
    const task = this.db.getTask(taskId)
    const isTriageSession = this.isTriageSessionTask(taskId, task)
    const isSubtask = !!task?.parent_task_id
    const taskScope = isSubtask && task?.parent_task_id ? { taskId, parentTaskId: task.parent_task_id } : undefined
    await yieldEL()

    // Build MCP servers config for adapter
    // Real task sessions always get task-management access so they can triage,
    // orchestrate subtasks, and inspect live task state without depending on
    // per-agent MCP configuration.
    const isMastermind = taskId === 'mastermind-session'
    const ensureTaskManagement = isMastermind || isTriageSession || isSubtask || !!task
    const mcpServers = await this.buildMcpServersForAdapter(agentId, { ensureTaskManagement, taskScope })

    // Build session config
    const sessionConfig: SessionConfig = {
      agentId,
      taskId,
      workspaceDir,
      model: agent.config?.model,
      systemPrompt: agent.config?.system_prompt,
      mcpServers,
      authMethod: agent.config?.auth_method,
      permissionMode: agent.config?.permission_mode,
      apiKeys: agent.config?.api_keys,
      tillDone: this.shouldEnableTillDone(taskId, task)
    }

    // Setup secret broker session if agent has secrets
    const secretToken = this.setupSecretSession(agentId)
    if (secretToken) {
      const brokerPort = getSecretBrokerPort()
      if (brokerPort) {
        sessionConfig.secretBrokerPort = brokerPort
        sessionConfig.secretSessionToken = secretToken
        sessionConfig.secretShellPath = writeSecretShellWrapper()
      }
    }

    // Populate secret env vars + system prompt awareness
    const secretIds = agent.config?.secret_ids
    if (secretIds && secretIds.length > 0) {
      const secretRecords = this.db.getSecretsByIds(secretIds)
      const secretsWithValues = this.db.getSecretsWithValues(secretIds)
      if (secretsWithValues.length > 0) {
        sessionConfig.secretEnvVars = {}
        for (const s of secretsWithValues) {
          sessionConfig.secretEnvVars[s.env_var_name] = s.value
        }
      }
      if (secretRecords.length > 0) {
        sessionConfig.systemPrompt = (sessionConfig.systemPrompt || '') + this.buildSecretsSystemPrompt(secretRecords)
      }
    }
    await yieldEL()

    // Refresh the AI gateway virtual key before building the provider config
    // so the adapter gets the latest key from the backend (handles key rotation,
    // admin plan changes, etc.). Best-effort — fall back to the cached key.
    // Note: we do NOT call adapter.notifyConfigChanged() here because that would
    // push config to the OpenCode server and abort all running sessions. The config
    // is already pushed once on first server connection (ensureServerRunning), and
    // the key rarely rotates mid-session. If it does, the retry mechanism handles
    // transient auth errors, and the next server reconnection picks up the new key.
    if (this.enterpriseAuth) {
      try {
        await this.enterpriseAuth.refreshAiGatewayVirtualKey()
      } catch (err) {
        console.warn('[AgentManager] AI gateway key refresh failed (will use cached key):', err)
      }
    }

    // Initialize adapter
    console.log(`[AgentManager] startAdapterSession: agent=${agent.name}, coding_agent=${agent.config?.coding_agent || 'opencode'}, model=${agent.config?.model}, adapter=${adapter.constructor.name}`)
    await adapter.initialize()

    // Create session via adapter
    const adapterSessionId = await adapter.createSession(sessionConfig)
    console.log(`[AgentManager] Session created: ${adapterSessionId}, workspaceDir=${workspaceDir}`)

    // Store session in sessions map
    this.sessions.set(adapterSessionId, {
      id: adapterSessionId,
      agentId,
      taskId,
      workspaceDir,
      status: 'working',
      createdAt: new Date(),
      seenMessageIds: new Set(),
      seenPartIds: new Set(),
      partContentLengths: new Map(),
      adapter,
      isTriageSession,
      secretSessionToken: secretToken
    })

    // Store session ID in database
    this.db.updateTask(taskId, { session_id: adapterSessionId })
    console.log(`[SessionTracker] CREATED session=${adapterSessionId} task=${taskId} agent=${agentId} reason=new_session`)

    // Update task status (preserve Triaging status for triage sessions)
    if (!isTriageSession) {
      this.db.updateTask(taskId, { status: TaskStatus.AgentWorking })

      // Notify renderer about task status change
      this.sendToRenderer('task:updated', {
        taskId,
        updates: { status: TaskStatus.AgentWorking }
      })
    }
    await yieldEL()

    // Notify renderer
    this.sendToRenderer('agent:status', {
      sessionId: adapterSessionId,
      agentId,
      taskId,
      status: 'working'
    })

    // Record enterprise sync event: agent run started
    if (this.enterpriseStateSync && task && !isTriageSession && taskId !== 'mastermind-session' && !taskId.startsWith('heartbeat-')) {
      this.enterpriseStateSync.recordAgentRunStarted(task, agent.name)
    }

    // Start polling adapter for messages.
    // Pass initialPromptSent=true BEFORE starting the poller so the first
    // tick() won't forward the duplicate user message echoed by the adapter.
    this.startAdapterPolling(adapterSessionId, adapter, sessionConfig, !skipInitialPrompt)

    // Send initial prompt if not skipped
    if (!skipInitialPrompt) {
      let promptText: string

      if (isTriageSession && task) {
        // Use triage-specific prompt
        promptText = this.buildTriagePrompt(task)
      } else {
        // Reuse the task we already fetched above instead of hitting the DB again
        const currentTask = task || this.db.getTask(taskId)
        promptText = currentTask
          ? `Work on task: "${currentTask.title}"\n\n${currentTask.description || ''}`
          : `Work on task: ${taskId}`

        // Add subtask context: if this is a subtask, include parent and sibling info
        if (currentTask?.parent_task_id) {
          const parentTask = this.db.getTask(currentTask.parent_task_id)
          if (parentTask) {
            promptText += `\n\n## Parent Task Context\nThis is a subtask of: "${parentTask.title}" (id: ${parentTask.id})\nParent description: ${parentTask.description || '(none)'}\nParent status: ${parentTask.status}`
            if (parentTask.output_fields && parentTask.output_fields.length > 0) {
              promptText += '\nParent output fields:'
              for (const field of parentTask.output_fields) {
                const val = (field as unknown as { value?: string }).value ?? '(not set)'
                promptText += `\n  - ${field.name}: ${val}`
              }
            }

            // Include sibling subtasks for coordination
            const siblings = this.db.getSubtasks(currentTask.parent_task_id)
            const otherSubtasks = siblings.filter(s => s.id !== currentTask.id)
            if (otherSubtasks.length > 0) {
              promptText += '\n\n## Sibling Subtasks'
              for (const sibling of otherSubtasks) {
                const resolution = sibling.resolution ? ` | Resolution: ${sibling.resolution}` : ''
                const outputSummary = sibling.output_fields && sibling.output_fields.length > 0
                  ? ` | Outputs: ${sibling.output_fields.length} field(s)`
                  : ''
                promptText += `\n- "${sibling.title}" (id: ${sibling.id}, status: ${sibling.status}${resolution}${outputSummary})`
              }
              promptText += '\n\nCoordinate with sibling subtasks — avoid duplicating work and ensure compatibility.'
              promptText += '\nUse `get_task` with a sibling ID to read its full output fields and resolution.'
            }
          }
          promptText += '\n\nYou can call `list_subtasks` or `get_task` via the `task-management` MCP server at any time for live data on parent and sibling tasks.'
          promptText += '\nIMPORTANT: For all task operations (update_task, get_task, list_subtasks), use ONLY the `task-management` MCP server tools. Do NOT use integration tools like `pf-workflo-integrations` — those are for external system sync only.'
        }

        // If this task has subtasks, mention them
        if (currentTask) {
          const subtasks = this.db.getSubtasks(currentTask.id)
          if (subtasks.length > 0) {
            promptText += '\n\n## Subtasks'
            for (const sub of subtasks) {
              const subResolution = sub.resolution ? ` | Resolution: ${sub.resolution}` : ''
              promptText += `\n- "${sub.title}" (id: ${sub.id}, status: ${sub.status}, agent: ${sub.agent_id || 'unassigned'}${subResolution})`
            }
            promptText += '\n\nThis task has subtasks. Each subtask has its own agent. Focus on coordination and any work not covered by subtasks.'
            promptText += '\nUse `list_subtasks` or `get_task` via MCP tools to check live subtask status and outputs.'
          }

          promptText += '\n\nYou can use the `task-management` MCP server to orchestrate execution instead of doing everything yourself.'
          promptText += '\n- Use `create_subtask` to break work down.'
          promptText += '\n- Use `start_task` to triage+start an unassigned task, start an assigned task, or start a specific subtask by ID.'
          promptText += '\n- Use `wait_for_subtasks` to block until subtasks reach `ready_for_review` or `completed` before continuing coordination.'
        }

        // Append output field instructions
        if (currentTask?.output_fields && Array.isArray(currentTask.output_fields) && currentTask.output_fields.length > 0) {
          promptText += this.buildOutputFieldInstructions(currentTask.output_fields)
        }

        // Copy attachments and build references
        const attachmentRefs = workspaceDir ? this.syncAttachmentsToWorkspace(taskId, workspaceDir) : []
        if (attachmentRefs.length > 0) {
          promptText += `\n\nAttached files (relative to your working directory):\n${attachmentRefs.join('\n')}`
        }
      }

      // Append heartbeat monitoring instructions
      promptText += `\n\n## Heartbeat Monitoring (Optional)

If this task involves something that should be monitored after your work is done (e.g., a PR awaiting review, a deployment to verify, an issue to track), create a \`heartbeat.md\` file in the working directory.

Example heartbeat.md:
\`\`\`markdown
# Heartbeat Checks
- [ ] Check if PR https://github.com/org/repo/pull/123 has new review comments or requested changes
- [ ] Verify CI pipeline passed on the latest commit
- [ ] Check if linked issue #456 has new updates
\`\`\`

Only create this file when there's genuinely useful monitoring to do. Do not create it for tasks that are fully self-contained.`

      // Append memory file read instruction to user message
      // (user messages are more reliably followed than system prompt instructions)
      const memoryFileName = this.getMemoryFileName(agentId)
      promptText += `\n\nIMPORTANT: First, read the \`${memoryFileName}\` file in the working directory — it has workspace config, skills, and project context.`

      // Show the full prompt in the UI so the user can see the complete
      // context sent to the agent (repos, skills, secrets, heartbeat, etc.)
      this.sendToRenderer('agent:output', {
        sessionId: adapterSessionId,
        taskId,
        type: 'message',
        data: {
          id: `user-initial-${Date.now()}`,
          role: 'user',
          content: promptText,
          partType: 'text'
        }
      })

      // initialPromptSent was pre-set in startAdapterPolling() to prevent
      // the race where the first tick() runs before we get here and forwards
      // the duplicate user message echoed by the adapter.

      // Send prompt via adapter
      const parts: MessagePart[] = [
        { type: MessagePartType.TEXT, text: promptText }
      ]
      try {
        await adapter.sendPrompt(adapterSessionId, parts, sessionConfig)
      } catch (sendError) {
        console.error(`[AgentManager] sendPrompt FAILED:`, sendError)
        // Write to crash log for visibility
        const fs = await import('fs')
        const logPath = join(process.env.APPDATA || '', '20x', 'logs', 'agent-error.log')
        fs.appendFileSync(logPath, `\n[${new Date().toISOString()}] sendPrompt error: ${sendError}\n${(sendError as Error).stack || ''}\n`)
        throw sendError
      }
    }

    return adapterSessionId
  }

  /**
   * Prunes dedup structures (seenMessageIds, seenPartIds, partContentLengths)
   * when they exceed MAX_DEDUP_ENTRIES.  Keeps only the most recent half of
   * entries to avoid immediate re-growth.  Sets preserve insertion order so
   * deleting from the front discards the oldest entries first.
   */
  private pruneDedup(
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>
  ): void {
    const max = AgentManager.MAX_DEDUP_ENTRIES
    const pruneToSize = Math.floor(max / 2)

    if (seenMessageIds.size > max) {
      let toDelete = seenMessageIds.size - pruneToSize
      for (const id of seenMessageIds) {
        if (toDelete-- <= 0) break
        seenMessageIds.delete(id)
      }
    }

    if (seenPartIds.size > max) {
      let toDelete = seenPartIds.size - pruneToSize
      for (const id of seenPartIds) {
        if (toDelete-- <= 0) break
        seenPartIds.delete(id)
      }
    }

    // Prune partContentLengths based on entry count AND total value size.
    // When the size limit is hit, prune 50% (was 10% which was too conservative —
    // with large tool outputs re-growth is fast and 10% barely frees memory).
    let totalChars = 0
    for (const val of partContentLengths.values()) {
      totalChars += val.length
    }

    if (partContentLengths.size > max || totalChars > AgentManager.MAX_VALUE_CHARS_PER_SESSION) {
      const toDelete = partContentLengths.size > max
        ? partContentLengths.size - pruneToSize
        : Math.ceil(partContentLengths.size * 0.5) // Delete 50% when size limit hit

      let deleted = 0
      for (const key of partContentLengths.keys()) {
        if (deleted >= toDelete) break
        partContentLengths.delete(key)
        deleted++
      }
    }
  }

  // ── Centralized Polling Coordinator ──────────────────────────────
  //
  // Instead of N independent setTimeout loops (one per session that can fire
  // simultaneously, stacking sync DB calls and starving the event loop),
  // a SINGLE timer sequentially polls all registered sessions.

  /**
   * Registers a session for centralized polling and starts the coordinator
   * if it isn't already running.
   */
  private startAdapterPolling(
    initialSessionId: string,
    adapter: CodingAgentAdapter,
    config: SessionConfig,
    initialPromptSent?: boolean,
    existingSession?: AgentSession
  ): void {
    const entry: PollingEntry = {
      sessionId: initialSessionId,
      adapter,
      config,
      seenMessageIds: existingSession?.seenMessageIds ?? new Set<string>(),
      seenPartIds: existingSession?.seenPartIds ?? new Set<string>(),
      partContentLengths: existingSession?.partContentLengths ?? new Map<string, string>(),
      createdAt: Date.now(),
      // Always start fresh: each call to startAdapterPolling corresponds to a
      // newly-sent (fire-and-forget) prompt.  The IDLE grace period must apply
      // to every new prompt — not only to brand-new sessions — because the
      // backend can briefly report IDLE after a follow-up prompt while it is
      // still ingesting the request.  Pre-setting this to true when resuming
      // with an existing session caused follow-up messages (especially on
      // opencode) to transition to idle before any response was produced.
      hasSeenWork: false,
      initialPromptSent: initialPromptSent || false
    }

    this.pollingEntries.set(initialSessionId, entry)
    console.log(`[AgentManager] Registered session ${initialSessionId} for polling (${this.pollingEntries.size} active)`)

    // Wire up event-driven nudge so the adapter can trigger an immediate
    // poll cycle when new stream data is buffered (instead of waiting for
    // the 2-second heartbeat).
    if (!adapter.onDataAvailable) {
      adapter.onDataAvailable = (_sessionId: string) => {
        this.nudgePollingCoordinator()
      }
    }

    // Start the coordinator if not already running
    this.ensurePollingCoordinator()
  }

  /**
   * Unregisters a session from the polling coordinator.
   */
  private stopAdapterPolling(sessionId: string): void {
    this.pollingEntries.delete(sessionId)
    console.log(`[AgentManager] Unregistered session ${sessionId} from polling (${this.pollingEntries.size} remaining)`)

    // Stop coordinator if no sessions left
    if (this.pollingEntries.size === 0) {
      if (this.pollingTimer) {
        clearTimeout(this.pollingTimer)
        this.pollingTimer = null
      }
      if (this.nudgeTimer) {
        clearTimeout(this.nudgeTimer)
        this.nudgeTimer = null
      }
      console.log('[AgentManager] Polling coordinator stopped (no active sessions)')
    }
  }

  /**
   * Ensures the single polling coordinator timer is running.
   */
  private ensurePollingCoordinator(): void {
    if (this.pollingTimer || this.pollingInProgress) return // Already running or executing

    const tick = async (): Promise<void> => {
      // Prevent overlapping tick() calls from nudge + heartbeat firing together
      if (this.pollingInProgress) return
      this.pollingInProgress = true

      // Clear the timer reference — this tick is now executing, not pending.
      // ensurePollingCoordinator checks this to know whether to start a new loop.
      this.pollingTimer = null

      try {
        // Snapshot current entries (entries may be removed during iteration)
        const entries = [...this.pollingEntries.values()]

        // Poll each session SEQUENTIALLY — never concurrently — to avoid
        // stacking sync DB calls that starve the event loop.
        for (const entry of entries) {
          // Check if entry was removed while we were iterating
          if (!this.pollingEntries.has(entry.sessionId)) continue

          await this.pollSingleSession(entry)

          // Yield the event loop between sessions so IPC, timers, and
          // rendering callbacks can run between polls.
          await new Promise<void>((r) => setImmediate(r))
        }
      } catch (error) {
        console.error('[AgentManager] Polling coordinator error:', error)
      } finally {
        this.pollingInProgress = false
      }

      // ALWAYS reschedule if there are active sessions (even after errors).
      if (this.pollingEntries.size > 0) {
        this.pollingTimer = setTimeout(tick, AgentManager.POLL_INTERVAL_MS)
      }
    }

    // Store reference so nudgePollingCoordinator can invoke it
    this.pollTickFn = tick

    // Start after a short initial delay
    this.pollingTimer = setTimeout(tick, 1000)
    console.log('[AgentManager] Polling coordinator started')
  }

  /**
   * Nudges the polling coordinator to run a poll cycle within NUDGE_DELAY_MS
   * instead of waiting for the next 2-second heartbeat.  Called by adapters
   * (via onDataAvailable) when new stream data is buffered.
   *
   * The short debounce (50ms) batches rapid-fire stream events so we don't
   * run a poll cycle for every single streaming chunk.
   */
  private nudgePollingCoordinator(): void {
    // Already have a nudge scheduled, no need to double-schedule
    if (this.nudgeTimer) return

    // If a tick is already running, it will pick up the new data — no nudge needed
    if (this.pollingInProgress) return

    // No active sessions → nothing to nudge
    if (this.pollingEntries.size === 0) return

    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null

      // Guard: still have sessions and tick isn't already running
      if (this.pollingEntries.size === 0 || this.pollingInProgress) return

      // Cancel the pending heartbeat timer — the nudge replaces it.
      // tick() will reschedule the heartbeat after it finishes.
      if (this.pollingTimer) {
        clearTimeout(this.pollingTimer)
        this.pollingTimer = null
      }

      // Run a poll cycle immediately (catch to avoid unhandled rejection on OOM)
      if (this.pollTickFn) {
        this.pollTickFn().catch((err) => {
          console.error('[AgentManager] Nudge tick error:', err)
        })
      }
    }, AgentManager.NUDGE_DELAY_MS)
  }

  /**
   * Polls a single session for new messages and status changes.
   * Extracted from the old per-session polling loop.
   */
  private async pollSingleSession(entry: PollingEntry): Promise<void> {
    const { adapter, config } = entry

    try {
      // Resolve current session ID (might have changed due to re-keying)
      let sessionId = entry.sessionId
      const sessionByOldId = this.sessions.get(sessionId)
      if (!sessionByOldId) {
        // Session might have been re-keyed, find it by taskId
        for (const [sid, sess] of this.sessions.entries()) {
          if (sess.taskId === config.taskId) {
            sessionId = sid
            // Re-key the polling entry
            this.pollingEntries.delete(entry.sessionId)
            entry.sessionId = sid
            this.pollingEntries.set(sid, entry)
            break
          }
        }
      }

      // Early exit if session was destroyed (e.g. by stopSession)
      const activeSession = this.sessions.get(sessionId)
      if (!activeSession) {
        console.log(`[AgentManager] Session ${sessionId} no longer exists, removing from polling`)
        this.stopAdapterPolling(entry.sessionId)
        return
      }

      // Poll for new messages
      const newParts = await adapter.pollMessages(
        sessionId,
        entry.seenMessageIds,
        entry.seenPartIds,
        entry.partContentLengths,
        config
      )

      // Prune dedup structures to prevent unbounded memory growth (OOM)
      this.pruneDedup(entry.seenMessageIds, entry.seenPartIds, entry.partContentLengths)

      // Check if the real session ID has been provided by the adapter
      const realSessionId = newParts.find(p => p.realSessionId)?.realSessionId
      if (realSessionId && realSessionId !== sessionId) {
        console.log(`[AgentManager] Session ID updated: ${sessionId} -> ${realSessionId}`)
        console.log(`[SessionTracker] REKEYED old=${sessionId} new=${realSessionId} task=${config.taskId} reason=adapter_provided_real_id`)

        // Update database with real session ID
        this.db.updateTask(config.taskId, { session_id: realSessionId })

        // Re-key the sessions map
        const session = this.sessions.get(sessionId)
        if (session) {
          this.sessions.delete(sessionId)
          this.sessions.set(realSessionId, session)

          // Record redirect so stale IDs from the renderer still resolve.
          // Cap the redirects map to prevent unbounded growth across many sessions.
          if (this.sessionIdRedirects.size >= AgentManager.MAX_SESSION_REDIRECTS) {
            // Evict oldest entries (Maps preserve insertion order)
            const toEvict = Math.ceil(AgentManager.MAX_SESSION_REDIRECTS * 0.5)
            let evicted = 0
            for (const oldKey of this.sessionIdRedirects.keys()) {
              if (evicted >= toEvict) break
              this.sessionIdRedirects.delete(oldKey)
              evicted++
            }
          }
          this.sessionIdRedirects.set(sessionId, realSessionId)

          // Re-key the polling entry
          this.pollingEntries.delete(sessionId)
          entry.sessionId = realSessionId
          this.pollingEntries.set(realSessionId, entry)

          sessionId = realSessionId
        }
      }

      // Update last activity timestamp when new parts arrive. This supports
      // the secondary grace period for models with brief idle gaps.
      if (newParts.length > 0) {
        entry.lastPartReceivedAt = Date.now()
        // Reset watchdog flag — new data means the session is alive again.
        // If a follow-up message also gets stuck, the watchdog can re-fire.
        entry.watchdogFired = false
      }

      // ── Garbled output detection ──
      // Some models hallucinate tool-call markup as plain text (e.g. outputting
      // `<｜DSML｜tool_calls>` character-by-character). This wastes tokens and
      // never resolves. Detect the pattern and abort early instead of waiting
      // for the full watchdog timeout (which can be 5+ minutes).
      if (newParts.length > 0) {
        const GARBLED_PATTERNS = ['<｜DSML｜', '<│DSML│', 'DSML｜tool_calls', 'DSML｜invoke']
        let hasGarbled = false
        for (const part of newParts) {
          const text = part.content || part.text || ''
          if (text.length > 50 && GARBLED_PATTERNS.some(p => text.includes(p))) {
            hasGarbled = true
            break
          }
        }
        if (hasGarbled) {
          entry.garbledOutputCount = (entry.garbledOutputCount || 0) + 1
          // Abort after 2 consecutive detections to avoid false positives
          if (entry.garbledOutputCount >= 2 && !entry.watchdogFired) {
            entry.watchdogFired = true
            console.warn(
              `[AgentManager] Session ${sessionId}: garbled model output detected (${entry.garbledOutputCount} cycles). Aborting to prevent token waste.`
            )
            this.sendToRenderer('agent:output', {
              sessionId,
              taskId: config.taskId,
              type: 'message',
              data: {
                id: `garbled-abort-${Date.now()}`,
                role: 'system',
                content: 'Session aborted: model is producing garbled output (hallucinated tool-call markup). You can send a new message to continue.',
                partType: 'error'
              }
            })
            try {
              await adapter.abortPrompt(sessionId, config)
            } catch (abortErr) {
              console.error(`[AgentManager] Failed to abort garbled session ${sessionId}:`, abortErr)
            }
            return
          }
        } else {
          // Reset counter when output looks normal
          entry.garbledOutputCount = 0
        }
      }

      // hasSeenWork is set exclusively in the BUSY / WAITING_APPROVAL status
      // handler below — not here.  Message content is unreliable (user echoes,
      // stale fingerprint updates from previous turns can produce non-user parts
      // before the backend has started processing the new prompt).

      // Collect all parts into a batch instead of sending individually.
      // This avoids flooding the renderer with N separate IPC messages
      // that each trigger a Zustand state update + React re-render.
      const batchMessages: Array<{ id: string; role: string; content: string; partType?: string; tool?: unknown; update?: boolean; taskProgress?: unknown }> = []
      for (const part of newParts) {
        // Skip ALL user/human messages from polling — we already show them in the UI
        // via sendToRenderer in startAdapterSession (initial) and doSendAdapterMessage (follow-ups).
        // The adapter echoes them back with different IDs so seenPartIds won't catch duplicates.
        if (part.role === 'user' || (part.role as string) === 'human') {
          continue
        }
        batchMessages.push({
          id: part.id || `part-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: part.role || 'assistant',
          content: part.content || part.text || '',
          partType: part.type,
          tool: part.tool,
          update: part.update,
          taskProgress: part.taskProgress
        })
      }

      // Check for pending approval (ACP + OpenCode adapters) — include in same batch
      if ('getPendingApproval' in adapter && typeof adapter.getPendingApproval === 'function') {
        const approval = (adapter as unknown as AcpAdapter).getPendingApproval(sessionId)
        if (approval && !entry.seenPartIds.has(`approval-${approval.toolCallId}`)) {
          entry.seenPartIds.add(`approval-${approval.toolCallId}`)

          batchMessages.push({
            id: `question-${approval.toolCallId}`,
            role: 'assistant',
            content: approval.question,
            partType: 'question',
            tool: {
              name: 'permission',
              questions: [{
                header: 'Permission Required',
                question: approval.question,
                options: approval.options.map((opt: { name: string }) => ({
                  label: opt.name
                }))
              }]
            }
          })
        }
      }

      // Capture last assistant text (used by HeartbeatScheduler to read results)
      // Concatenate all text parts from this batch to avoid missing tokens
      // that appear in earlier parts
      const currentSession = this.sessions.get(sessionId)
      if (currentSession) {
        const assistantTexts: string[] = []
        for (const msg of batchMessages) {
          if (msg.role === 'assistant' && msg.partType === 'text' && msg.content) {
            assistantTexts.push(msg.content)
          }
          // Capture todo list from todowrite tool calls — used to nudge the
          // agent when it goes idle with incomplete items.  Works for all
          // coding agents (Claude Code, OpenCode, etc.) without adapter-specific hooks.
          const toolObj = msg.tool as { todos?: unknown } | undefined
          if (toolObj?.todos && Array.isArray(toolObj.todos)) {
            currentSession.todos = (toolObj.todos as Array<Record<string, unknown>>)
              .filter(Boolean)
              .map((t) => ({
                content: String(t.content || t.text || t.title || ''),
                status: String(t.status || 'pending')
              }))
          }
        }
        if (assistantTexts.length > 0) {
          // Replace (not append) and cap at 50 KB to prevent unbounded string growth
          const joined = assistantTexts.join('\n')
          currentSession.lastAssistantText = joined.length > 50_000
            ? joined.slice(-50_000)
            : joined
        }
      }

      // Send all parts in a single IPC call
      if (batchMessages.length > 0) {
        this.sendToRenderer('agent:output-batch', {
          sessionId,
          taskId: config.taskId,
          messages: batchMessages
        })
      }

      // Check status
      const status = await adapter.getStatus(sessionId, config)
      const session = this.sessions.get(sessionId)

      // Check for errors first (higher priority than idle)
      if (status.type === SessionStatusType.ERROR) {
        if (status.message?.includes('INCOMPATIBLE_SESSION_ID')) {
          console.warn('[AgentManager] Incompatible session detected during polling:', sessionId)
          this.db.updateTask(config.taskId, { session_id: null })
          this.sendToRenderer('agent:incompatible-session', {
            taskId: config.taskId,
            agentId: config.agentId,
            error: status.message.replace('INCOMPATIBLE_SESSION_ID: ', '')
          })
          this.stopAdapterPolling(sessionId)
          return
        }

        if (status.message?.includes('Client not found')) {
          console.log(`[AgentManager] Client not found for session ${sessionId}, stopping polling`)
          this.stopAdapterPolling(sessionId)
          return
        }

        // Regular error (e.g., rate limit)
        this.sendToRenderer('agent:output', {
          sessionId,
          taskId: config.taskId,
          type: 'message',
          data: {
            id: `error-${Date.now()}`,
            role: 'system',
            content: status.message || 'An unexpected error occurred. Check logs for details.',
            partType: 'error'
          }
        })

        if (session) {
          session.status = 'error'
          session.pollingStarted = false
          this.sendToRenderer('agent:status', {
            sessionId,
            agentId: config.agentId,
            taskId: config.taskId,
            status: 'error'
          })

          // Record enterprise sync event: agent run failed
          const task = this.db.getTask(config.taskId)
          if (this.enterpriseStateSync && task && !session.isTriageSession && session.taskId !== 'mastermind-session' && !session.taskId.startsWith('heartbeat-')) {
            const durationMinutes = (Date.now() - session.createdAt.getTime()) / (1000 * 60)
            const agent = this.db.getAgent(session.agentId)
            this.enterpriseStateSync.recordAgentRunCompleted(task, {
              agentName: agent?.name,
              durationMinutes: Math.round(durationMinutes * 10) / 10,
              success: false
            })
          }
        }
        this.stopAdapterPolling(sessionId)
        return
      } else if (status.type === SessionStatusType.WAITING_APPROVAL && session) {
        // Backend is actively processing — disable the IDLE grace period.
        const peWA = this.pollingEntries.get(sessionId)
        if (peWA && !peWA.hasSeenWork) {
          peWA.hasSeenWork = true
        }
        if (session.status !== 'waiting_approval') {
          session.status = 'waiting_approval'
          this.sendToRenderer('agent:status', {
            sessionId,
            agentId: config.agentId,
            taskId: config.taskId,
            status: 'waiting_approval'
          })
        }
        return
      } else if (status.type === SessionStatusType.BUSY && session) {
        // Backend is actively processing — disable the IDLE grace period.
        const peBusy = this.pollingEntries.get(sessionId)
        if (peBusy) {
          if (!peBusy.hasSeenWork) peBusy.hasSeenWork = true
          // Agent resumed work (possibly after a tillDone nudge) — reset the
          // nudge counter so the next idle cycle gets a fresh allowance.
          if (peBusy.tillDoneNudgeCount) peBusy.tillDoneNudgeCount = 0

          // ── Fast stuck-tool detector ──
          // Some tools (notably `read` on cross-workspace files) silently hang
          // without producing any output or asking for permission. The general
          // watchdog below waits 5 minutes, which is far too long for a single
          // tool. Here we check for tools stuck in "running" state for >90s.
          if (!peBusy.watchdogFired && 'getRunningTools' in adapter && typeof adapter.getRunningTools === 'function') {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const getRunningToolsFn = (adapter as any).getRunningTools.bind(adapter)
              const runningTools: Array<{ partId: string; toolName: string; startTime?: number; input?: Record<string, unknown> }> = await getRunningToolsFn(sessionId, config)
              const now = Date.now()
              for (const tool of runningTools) {
                if (!tool.startTime) continue
                const elapsed = now - tool.startTime
                if (elapsed > AgentManager.STUCK_TOOL_TIMEOUT_MS) {
                  // Build a descriptive reason
                  let reason = `Tool "${tool.toolName}" has been running for ${Math.round(elapsed / 1000)}s with no output`
                  const filePath = tool.input?.filePath as string | undefined
                  if (filePath && config.workspaceDir && !filePath.startsWith(config.workspaceDir)) {
                    reason = `Tool "${tool.toolName}" stuck trying to access file outside workspace: ${filePath}`
                  }

                  peBusy.watchdogFired = true
                  console.warn(`[AgentManager] Session ${sessionId}: ${reason}. Aborting.`)

                  this.sendToRenderer('agent:output', {
                    sessionId,
                    taskId: config.taskId,
                    type: 'message',
                    data: {
                      id: `stuck-tool-${Date.now()}`,
                      role: 'system',
                      content: `Session auto-aborted: ${reason}. You can send a new message to continue.`,
                      partType: 'error'
                    }
                  })
                  try {
                    await adapter.abortPrompt(sessionId, config)
                  } catch (abortErr) {
                    console.error(`[AgentManager] Failed to abort stuck-tool session ${sessionId}:`, abortErr)
                  }
                  return
                }
              }
            } catch {
              // Non-fatal — fall through to the general watchdog
            }
          }

          // ── Stuck session watchdog ──
          // If the session has been BUSY but hasn't received any new data for
          // STUCK_SESSION_TIMEOUT_MS, a tool call is likely hung inside the agent
          // process. Abort the prompt so the session can recover instead of
          // staying stuck indefinitely.
          //
          // Exception: if the last polled message is a `question` tool in running
          // state, the session is waiting for user input — not stuck. This can
          // happen when the OpenCode question.list() check fails silently and
          // getStatus() reports BUSY instead of WAITING_APPROVAL.
          const lastDataAt = peBusy.lastPartReceivedAt || peBusy.createdAt
          const silentDuration = Date.now() - lastDataAt
          if (silentDuration > AgentManager.STUCK_SESSION_TIMEOUT_MS && !peBusy.watchdogFired) {
            // Check if the session is actually waiting for user input.
            // This can happen when OpenCode's question.list() check fails silently
            // and getStatus() reports BUSY instead of WAITING_APPROVAL, even though
            // the agent is just waiting for the user to answer a question.
            //
            // We check three signals:
            // 1. Session was in waiting_approval from a previous poll cycle
            // 2. Current batch has a question/permission tool
            // 3. Adapter has pending permissions (SSE-based)
            let isWaitingForInput = false

            // Signal 1: session was previously in waiting_approval
            if (session.status === 'waiting_approval') {
              isWaitingForInput = true
            }

            // Signal 2: current batch has question/permission tool
            if (!isWaitingForInput) {
              for (const msg of batchMessages) {
                const tool = msg.tool as { name?: string; questions?: unknown[] } | undefined
                if (tool?.name === 'question' || tool?.name === 'permission') {
                  isWaitingForInput = true
                  break
                }
              }
            }

            // Signal 3: adapter has pending permissions from SSE events
            if (!isWaitingForInput && 'getPendingApproval' in adapter && typeof adapter.getPendingApproval === 'function') {
              const pending = (adapter as unknown as { getPendingApproval: (sid: string) => unknown }).getPendingApproval(sessionId)
              if (pending) isWaitingForInput = true
            }

            if (isWaitingForInput) {
              console.log(
                `[AgentManager] Session ${sessionId} BUSY for ${Math.round(silentDuration / 1000)}s but has pending user input — not aborting`
              )
            } else {
              // Mark the watchdog as fired BEFORE sending the message/abort.
              // This prevents the abort notification from spamming every poll
              // tick while the backend transitions from BUSY → IDLE.
              peBusy.watchdogFired = true
              console.warn(
                `[AgentManager] Session ${sessionId} stuck: BUSY for ${Math.round(silentDuration / 1000)}s with no new data. Aborting prompt.`
              )
              // Notify the user that the session was auto-aborted
              this.sendToRenderer('agent:output', {
                sessionId,
                taskId: config.taskId,
                type: 'message',
                data: {
                  id: `stuck-abort-${Date.now()}`,
                  role: 'system',
                  content: `Session auto-aborted: no activity for ${Math.round(silentDuration / 1000)}s. A tool call may have hung. You can send a new message to continue.`,
                  partType: 'error'
                }
              })
              // Abort the prompt — this will cause executePromptWithRetry to exit,
              // and the next poll cycle will detect IDLE status.
              try {
                await adapter.abortPrompt(sessionId, config)
              } catch (abortErr) {
                console.error(`[AgentManager] Failed to abort stuck session ${sessionId}:`, abortErr)
              }
              return
            }
          }
        }
        if (session.status !== 'working') {
          session.status = 'working'
          this.sendToRenderer('agent:status', {
            sessionId,
            agentId: config.agentId,
            taskId: config.taskId,
            status: 'working'
          })
        }
      } else if (status.type === SessionStatusType.IDLE && session) {
        // Grace period: don't transition to IDLE within the first 15 seconds of
        // session creation. The prompt is sent asynchronously (fire-and-forget) and
        // the backend may not have started processing it yet. Without this grace
        // period, polling sees IDLE immediately, stops permanently, and the agent
        // appears stuck showing only the system prompt.
        const pollingEntry = this.pollingEntries.get(sessionId)
        const sessionAge = pollingEntry ? Date.now() - pollingEntry.createdAt : Infinity
        const IDLE_GRACE_PERIOD_MS = 15_000

        if (!pollingEntry?.hasSeenWork && sessionAge < IDLE_GRACE_PERIOD_MS) {
          return
        }

        // Secondary grace period: after receiving data, don't immediately declare
        // IDLE. Models like featherless kimi k2.5 may have brief idle gaps between
        // tool call rounds where the status API momentarily reports idle before the
        // next tool execution starts. Wait at least 5 seconds after the last
        // received data before allowing IDLE transition.
        const POST_DATA_GRACE_MS = 5_000
        if (pollingEntry?.lastPartReceivedAt) {
          const timeSinceLastData = Date.now() - pollingEntry.lastPartReceivedAt
          if (timeSinceLastData < POST_DATA_GRACE_MS) {
            return
          }
        }

        // ── TillDone nudge: if the agent created a todo list (via todowrite)
        // and went idle with incomplete items, prompt it to continue instead
        // of transitioning to idle. Works for ALL coding agents — todos are
        // captured from polled messages, not from adapter-specific state files.
        if (pollingEntry && session.todos && session.todos.length > 0) {
          const DONE_STATUSES = ['completed', 'cancelled', 'done', 'removed']
          const incomplete = session.todos.filter(t => !DONE_STATUSES.includes(t.status))
          const nudgeCount = pollingEntry.tillDoneNudgeCount || 0

          if (incomplete.length > 0 && nudgeCount < AgentManager.MAX_TILLDONE_NUDGES) {
            const completed = session.todos.length - incomplete.length
            const lines = [
              `TillDone: you went idle but your to-do list is NOT finished (${completed}/${session.todos.length} completed).`,
              '',
              'Remaining items:'
            ]
            for (const t of incomplete) {
              lines.push(`- [${t.status}] ${t.content}`)
            }
            lines.push('')
            lines.push('Continue working on the remaining items above. Update todowrite as you progress and only stop once every item is completed or explicitly removed.')
            const nudgeText = lines.join('\n')

            pollingEntry.tillDoneNudgeCount = nudgeCount + 1
            console.log(`[AgentManager] TillDone nudge #${nudgeCount + 1} for ${sessionId}: ${incomplete.length} incomplete todo(s)`)
            // Send nudge via the standard message path which resets status
            // to 'working' and keeps polling alive.
            this.doSendAdapterMessage(session, sessionId, nudgeText).catch((err) => {
              console.error(`[AgentManager] TillDone nudge failed for ${sessionId}:`, err)
            })
            return
          } else if (incomplete.length > 0) {
            console.log(`[AgentManager] TillDone nudge limit (${AgentManager.MAX_TILLDONE_NUDGES}) reached for ${sessionId}, transitioning to idle`)
          }
        }

        console.log(`[AgentManager] Detected IDLE status for ${sessionId}, calling transitionToIdle`)
        // Sync dedup state from polling entry back to the session so that
        // if polling restarts (follow-up message), we preserve what was already seen.
        if (pollingEntry) {
          for (const id of pollingEntry.seenMessageIds) session.seenMessageIds.add(id)
          for (const id of pollingEntry.seenPartIds) session.seenPartIds.add(id)
          for (const [k, v] of pollingEntry.partContentLengths) session.partContentLengths.set(k, v)
          // Prune after merging to keep session-level structures bounded
          this.pruneDedup(session.seenMessageIds, session.seenPartIds, session.partContentLengths)
        }
        session.pollingStarted = false
        // Remove from polling FIRST so other sessions aren't starved while
        // transitionToIdle runs (it can be slow due to extractOutputValues).
        this.stopAdapterPolling(sessionId)
        // Fire-and-forget: transitionToIdle runs without blocking the coordinator.
        this.transitionToIdle(sessionId, session).catch((err) => {
          console.error(`[AgentManager] transitionToIdle error for ${sessionId}:`, err)
        })
        return
      }
    } catch (error: unknown) {
      console.error('[AgentManager] Adapter polling error:', error)
    }
  }

  /**
   * Resumes a session using a coding agent adapter (Claude Code, etc.)
   */
  private async resumeAdapterSession(
    adapter: CodingAgentAdapter,
    agentId: string,
    taskId: string,
    adapterSessionId: string,
    options?: { replayToRenderer?: boolean }
  ): Promise<string> {
    // Helper: yield event loop between bursts of sync DB/FS calls
    const yieldEL = (): Promise<void> => new Promise((r) => setImmediate(r))

    const agent = this.db.getAgent(agentId)!

    // Use the same workspace resolution as startSession: try git worktree first,
    // then fall back to the default workspace dir. This is critical because Claude
    // Code stores session files under ~/.claude/projects/<encoded-workspaceDir>/,
    // so resuming with a different workspaceDir produces a different path and the
    // session file won't be found.
    let workspaceDir = await this.setupWorktreeIfNeeded(taskId)
    if (!workspaceDir) {
      workspaceDir = this.db.getWorkspaceDir(taskId)
    }

    // Sync any attachments added since the session was started/last resumed
    if (workspaceDir) {
      this.syncAttachmentsToWorkspace(taskId, workspaceDir)
    }

    // Build MCP servers config
    const isMastermind = taskId === 'mastermind-session'
    const task = this.db.getTask(taskId)
    const isTriageSession = this.isTriageSessionTask(taskId, task)
    const isSubtask = !!task?.parent_task_id
    const taskScope = isSubtask && task?.parent_task_id ? { taskId, parentTaskId: task.parent_task_id } : undefined
    await yieldEL()

    const mcpServers = await this.buildMcpServersForAdapter(agentId, { ensureTaskManagement: isMastermind || isTriageSession || isSubtask, taskScope })

    // Build system prompt with task context (survives context compaction)
    const baseSystemPrompt = agent.config?.system_prompt || ''
    const taskContext = task
      ? `\n\n[Task Context]\nTask: "${task.title}"\n${task.description || ''}`
      : ''

    // Build session config
    const sessionConfig: SessionConfig = {
      agentId,
      taskId,
      workspaceDir,
      model: agent.config?.model,
      systemPrompt: baseSystemPrompt + taskContext,
      mcpServers,
      authMethod: agent.config?.auth_method,
      permissionMode: agent.config?.permission_mode,
      apiKeys: agent.config?.api_keys,
      tillDone: this.shouldEnableTillDone(taskId, task)
    }

    // Setup secret broker session if agent has secrets
    const secretToken = this.setupSecretSession(agentId)
    if (secretToken) {
      const brokerPort = getSecretBrokerPort()
      if (brokerPort) {
        sessionConfig.secretBrokerPort = brokerPort
        sessionConfig.secretSessionToken = secretToken
        sessionConfig.secretShellPath = writeSecretShellWrapper()
      }
    }

    // Populate secret env vars + system prompt awareness
    const secretIds = agent.config?.secret_ids
    if (secretIds && secretIds.length > 0) {
      const secretRecords = this.db.getSecretsByIds(secretIds)
      const secretsWithValues = this.db.getSecretsWithValues(secretIds)
      if (secretsWithValues.length > 0) {
        sessionConfig.secretEnvVars = {}
        for (const s of secretsWithValues) {
          sessionConfig.secretEnvVars[s.env_var_name] = s.value
        }
      }
      if (secretRecords.length > 0) {
        sessionConfig.systemPrompt = (sessionConfig.systemPrompt || '') + this.buildSecretsSystemPrompt(secretRecords)
      }
    }
    await yieldEL()

    // Initialize adapter
    await adapter.initialize()

    // Resume session via adapter
    let messages: SessionMessage[]
    try {
      console.log('[AgentManager] Calling adapter.resumeSession...')
      messages = await adapter.resumeSession(adapterSessionId, sessionConfig)
      console.log('[AgentManager] adapter.resumeSession completed successfully')
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.log('[AgentManager] adapter.resumeSession threw error:', errorMessage)

      // Check if it's an incompatible session ID error, session not found, or missing session file
      if (
        errorMessage.includes('INCOMPATIBLE_SESSION_ID') ||
        errorMessage.includes('No conversation found') ||
        errorMessage.includes('SESSION_FILE_NOT_FOUND') ||
        errorMessage.includes('Session no longer exists on server')
      ) {
        console.warn(`[AgentManager] Session not found or incompatible: ${adapterSessionId}`)

        // For completed/review tasks, the session may have ended normally.
        // Don't show the alarming "incompatible" dialog — just clear the session_id
        // so the UI shows "Start" instead. This commonly happens with subtask sessions.
        const currentTask = this.db.getTask(taskId)
        if (currentTask && (currentTask.status === TaskStatus.ReadyForReview || currentTask.status === TaskStatus.Completed)) {
          console.log(`[AgentManager] Session ended normally for ${currentTask.status} task ${taskId} — clearing session_id`)
          this.db.updateTask(taskId, { session_id: null })
          this.sendToRenderer('task:updated', { taskId, updates: { session_id: null } })
          // Return a sentinel value instead of throwing, so the IPC handler doesn't
          // log a noisy error. The public resumeSession() method returns empty string
          // which signals to the renderer that the session is gone.
          return ''
        }

        // Clear the old session_id in the database
        this.db.updateTask(taskId, { session_id: null })

        // Determine user-friendly error message
        let userMessage = 'Session not found. Would you like to start a new session?'
        if (errorMessage.includes('SESSION_FILE_NOT_FOUND')) {
          userMessage = 'Session file not found. The session may have been deleted or never synced. Would you like to start a new session?'
        } else if (errorMessage.includes('No conversation found')) {
          userMessage = 'Session not found on server. Would you like to start a new session?'
        } else {
          userMessage = errorMessage.replace('INCOMPATIBLE_SESSION_ID: ', '')
        }

        // Notify renderer to show dialog asking user to start fresh
        console.log('[AgentManager] Emitting agent:incompatible-session event')
        this.sendToRenderer('agent:incompatible-session', {
          taskId,
          agentId,
          error: userMessage
        })

        // Throw error to stop the resume flow
        throw new Error('SESSION_INCOMPATIBLE')
      }

      // Re-throw other errors
      throw error
    }

    const shouldReplayToRenderer = options?.replayToRenderer !== false

    // Build replay batch AND dedup state in a SINGLE pass so that both use
    // the same generated IDs.  Previously two separate loops each called
    // `Date.now() + Math.random()` for parts without an id, producing
    // different IDs.  The frontend's `seen` set then held the batch IDs while
    // the session's seenPartIds held different IDs, so when polling started
    // on a follow-up message the streaming replay (with yet another set of
    // stableId-based IDs) was not deduped by either — causing every
    // historical message to appear twice.
    const batchMessages: Array<{ id: string; role: string; content: string; partType?: string; tool?: unknown; taskProgress?: unknown; receivedAt?: number }> = []
    const resumedSeenMessageIds = new Set<string>()
    const resumedSeenPartIds = new Set<string>()
    const resumedPartContentLengths = new Map<string, string>()
    for (const message of messages) {
      // Track message-level IDs so adapters that dedup by message ID
      // (e.g. Codex pollMessages) won't re-send historical messages.
      if (message.id) resumedSeenMessageIds.add(message.id)
      for (const part of message.parts) {
        const partId = part.id || `${message.role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        // Dedup state
        resumedSeenPartIds.add(partId)
        if (part.content || part.text) {
          resumedPartContentLengths.set(partId, String((part.content || part.text || '').length))
        }
        // Batch message (only if we're replaying to the renderer)
        if (shouldReplayToRenderer) {
          batchMessages.push({
            id: partId,
            role: message.role,
            content: part.content || part.text || '',
            partType: part.type,
            tool: part.tool,
            taskProgress: part.taskProgress,
            receivedAt: part.receivedAt
          })
        }
      }
    }
    if (shouldReplayToRenderer && batchMessages.length > 0) {
      this.sendToRenderer('agent:output-batch', {
        sessionId: adapterSessionId,
        taskId,
        messages: batchMessages
      })
    }

    // Store session in sessions map — idle until user sends a message
    this.sessions.set(adapterSessionId, {
      id: adapterSessionId,
      agentId,
      taskId,
      workspaceDir,
      status: 'idle',
      createdAt: new Date(),
      seenMessageIds: resumedSeenMessageIds,
      seenPartIds: resumedSeenPartIds,
      partContentLengths: resumedPartContentLengths,
      adapter,
      pollingStarted: false,
      secretSessionToken: secretToken
    })

    // Notify renderer — session is resumed but idle (no work in progress)
    this.sendToRenderer('agent:status', {
      sessionId: adapterSessionId,
      agentId,
      taskId,
      status: 'idle'
    })

    return adapterSessionId
  }

  /**
   * Creates an OpenCode session and returns the sessionId immediately.
   * Uses promptAsync to send the initial prompt without blocking.
   */
  async startSession(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<string> {
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    // Auto-setup worktrees if caller didn't provide a workspaceDir
    if (!workspaceDir) {
      workspaceDir = await this.setupWorktreeIfNeeded(taskId)
    }

    const adapter = this.getAdapter(agentId)
    if (!adapter) {
      throw new Error(`No adapter available for agent ${agentId}`)
    }
    return this.startAdapterSession(adapter, agentId, taskId, workspaceDir, skipInitialPrompt)
  }

  async startTask(taskId: string, opts?: { preferSubtasks?: boolean; allowTriage?: boolean }): Promise<{
    action: 'task_started' | 'subtask_started' | 'triage_started' | 'already_running' | 'no_action'
    sessionId?: string
    startedTaskId?: string
    agentId?: string
  }> {
    const task = this.db.getTask(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    const preferSubtasks = opts?.preferSubtasks !== false
    const allowTriage = opts?.allowTriage !== false

    if (preferSubtasks) {
      const subtasks = this.db.getSubtasks(taskId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

      const activeSubtask = subtasks.find((subtask) =>
        subtask.status === TaskStatus.AgentWorking ||
        subtask.status === TaskStatus.ReadyForReview ||
        subtask.status === TaskStatus.Triaging ||
        subtask.status === TaskStatus.AgentLearning
      )
      if (activeSubtask) {
        return {
          action: 'already_running',
          startedTaskId: activeSubtask.id,
          agentId: activeSubtask.agent_id ?? undefined
        }
      }

      const nextSubtask = subtasks.find((subtask) => subtask.status === TaskStatus.NotStarted && !!subtask.agent_id)
      if (nextSubtask?.agent_id) {
        const sessionId = await this.startSession(nextSubtask.agent_id, nextSubtask.id)
        return {
          action: 'subtask_started',
          sessionId,
          startedTaskId: nextSubtask.id,
          agentId: nextSubtask.agent_id
        }
      }
    }

    const runningSession = this.findSessionByTaskId(taskId)
    if (runningSession && runningSession.session.status !== 'idle' && runningSession.session.status !== 'error') {
      return {
        action: 'already_running',
        sessionId: runningSession.sessionId,
        startedTaskId: taskId,
        agentId: runningSession.session.agentId
      }
    }

    if (!task.agent_id) {
      if (!allowTriage || task.parent_task_id) {
        return { action: 'no_action', startedTaskId: taskId }
      }

      const defaultAgentId = this.resolveDefaultAgentId()
      if (!defaultAgentId) {
        return { action: 'no_action', startedTaskId: taskId }
      }

      this.db.updateTask(taskId, { status: TaskStatus.Triaging })
      this.sendToRenderer('task:updated', {
        taskId,
        updates: { status: TaskStatus.Triaging }
      })

      const sessionId = await this.startSession(defaultAgentId, taskId)
      return {
        action: 'triage_started',
        sessionId,
        startedTaskId: taskId,
        agentId: defaultAgentId
      }
    }

    const sessionId = await this.startSession(task.agent_id, taskId)
    return {
      action: 'task_started',
      sessionId,
      startedTaskId: taskId,
      agentId: task.agent_id
    }
  }

  /**
   * Send a heartbeat check via a dedicated heartbeat session for this task.
   * Uses a separate session (heartbeat-{taskId}) to keep checks out of the task's working session.
   * Each task gets its own heartbeat session so checks don't mix across tasks.
   * Uses the real task's workspace dir so the agent has repo context for gh commands.
   */
  async sendHeartbeatViaMastermind(agentId: string, taskId: string, heartbeatPrompt: string): Promise<string> {
    const heartbeatTaskId = `heartbeat-${taskId}`

    // Check if heartbeat session for this task exists in memory
    let sessionId: string | undefined
    for (const [id, session] of this.sessions.entries()) {
      if (session.taskId === heartbeatTaskId) {
        sessionId = id
        break
      }
    }

    if (!sessionId) {
      // Use the real task's workspace dir so the agent has repo context
      const workspaceDir = this.db.getWorkspaceDir(taskId)
      console.log(`[AgentManager] Heartbeat: creating heartbeat session for task ${taskId}`)
      sessionId = await this.startSession(agentId, heartbeatTaskId, workspaceDir, true /* skipInitialPrompt */)
    }

    console.log(`[AgentManager] Heartbeat: sending check via heartbeat session ${sessionId} for task ${taskId}`)
    const result = await this.sendMessage(sessionId, heartbeatPrompt, heartbeatTaskId, agentId)
    return result.newSessionId || sessionId
  }

  /**
   * Send action findings to the task agent's own session.
   * Only called when mastermind detected something that needs the task agent to act on.
   */
  async startHeartbeatSession(agentId: string, taskId: string, heartbeatPrompt: string): Promise<string> {
    const task = this.db.getTask(taskId)
    let sessionId = task?.session_id

    if (!sessionId) {
      console.log(`[AgentManager] Heartbeat: no session for task ${taskId}, creating new session`)
      sessionId = await this.startSession(agentId, taskId, undefined, true /* skipInitialPrompt */)
    }

    console.log(`[AgentManager] Heartbeat: forwarding action to task session ${sessionId} for task ${taskId}`)

    // sendMessage handles everything: resume if dead, send the prompt, start polling
    const result = await this.sendMessage(sessionId, heartbeatPrompt, taskId, agentId)
    const activeSessionId = result.newSessionId || sessionId

    return activeSessionId
  }

  /**
   * Get a session's current state (used by HeartbeatScheduler to poll status).
   */
  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Remove a heartbeat session from memory after the check completes.
   * Prevents heartbeat-{taskId} sessions from accumulating indefinitely.
   */
  async cleanupHeartbeatSession(taskId: string): Promise<void> {
    const heartbeatTaskId = `heartbeat-${taskId}`
    for (const [id, session] of this.sessions.entries()) {
      if (session.taskId === heartbeatTaskId) {
        await this.stopSession(id, false)
        console.log(`[AgentManager] Cleaned up heartbeat session ${id} for task ${taskId}`)
        return
      }
    }
  }

  /**
   * Find a session by its taskId. Returns the current session ID and session object.
   * Used by HeartbeatScheduler to recover from session ID re-keying: when the adapter
   * provides a real session ID, pollSingleSession re-keys the sessions map, but
   * waitForSessionResult still holds the old temp ID. This method looks up by taskId
   * which is stable across re-keying.
   */
  findSessionByTaskId(taskId: string): { sessionId: string; session: AgentSession } | undefined {
    for (const [id, session] of this.sessions.entries()) {
      if (session.taskId === taskId) {
        return { sessionId: id, session }
      }
    }
    return undefined
  }


  /**
   * Check if a task has a live (working) session in memory.
   * Used by HeartbeatScheduler to avoid interrupting active user sessions.
   */
  hasActiveSessionForTask(taskId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.taskId === taskId && session.status === 'working') {
        return true
      }
    }
    return false
  }

  /**
   * Get the last assistant message text from a session's conversation.
   * Used by HeartbeatScheduler to extract the heartbeat result.
   */
  getLastAssistantMessage(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session?.adapter) return null

    // The adapter should have the session's messages accessible
    // We use the polling entry's seenPartIds to reconstruct content
    // For simplicity, we store the last assistant text during polling
    return session.lastAssistantText ?? null
  }

  /**
   * Get raw transcript for debugging. Returns all message parts with full tool
   * input/output, thinking blocks, errors, etc. Used by the renderer's hidden
   * "Copy Debug Info" feature to include raw coding agent data.
   * Truncates individual fields to keep the payload manageable.
   */
  async getRawTranscriptForDebug(taskId: string): Promise<Array<{ role: string; parts: Array<{ type: string; content?: string; tool?: { name: string; status?: string; input?: string; output?: string; error?: string } }> }>> {
    let session: AgentSession | undefined
    for (const s of this.sessions.values()) {
      if (s.taskId === taskId) {
        session = s
        break
      }
    }

    if (!session?.adapter?.getAllMessages) {
      return []
    }

    const MAX_FIELD = 3000
    const truncField = (val: unknown): string | undefined => {
      if (val == null) return undefined
      const s = typeof val === 'string' ? val : JSON.stringify(val)
      return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + `… (${s.length - MAX_FIELD} more)` : s
    }

    try {
      const config: SessionConfig = {
        agentId: session.agentId,
        taskId: session.taskId,
        workspaceDir: session.workspaceDir || this.db.getWorkspaceDir(taskId)
      }
      const messages = await session.adapter.getAllMessages(session.id, config)
      return messages
        .filter(m => m.parts && m.parts.length > 0)
        .slice(-100) // Last 100 messages only
        .map(m => ({
          role: m.role,
          parts: m.parts.map(p => ({
            type: p.type,
            content: truncField(p.content || p.text),
            tool: p.tool ? {
              name: p.tool.name,
              status: p.tool.status,
              input: truncField(p.tool.input),
              output: truncField(p.tool.output),
              error: p.tool.error
            } : undefined
          }))
        }))
    } catch (err) {
      console.error(`[AgentManager] Failed to get raw transcript for task ${taskId}:`, err)
      return []
    }
  }

  /**
   * Get a summary transcript for a task's session.
   * Returns assistant text messages suitable for sibling subtask coordination.
   * Used by the task-api-server to serve transcript data to subtask MCP agents.
   */
  async getTranscriptForTask(taskId: string): Promise<Array<{ role: string; text: string }>> {
    // Find the active session for this task
    let session: AgentSession | undefined
    for (const s of this.sessions.values()) {
      if (s.taskId === taskId) {
        session = s
        break
      }
    }

    if (!session?.adapter?.getAllMessages) {
      return []
    }

    try {
      const config: SessionConfig = {
        agentId: session.agentId,
        taskId: session.taskId,
        workspaceDir: session.workspaceDir || this.db.getWorkspaceDir(taskId)
      }
      const messages = await session.adapter.getAllMessages(session.id, config)
      // Return a simplified transcript with role + text content only
      return messages
        .filter(m => m.parts && m.parts.length > 0)
        .map(m => ({
          role: m.role,
          text: m.parts
            .filter(p => p.type === 'text')
            .map(p => p.content || '')
            .join('\n')
        }))
        .filter(m => m.text.length > 0)
    } catch (err) {
      console.error(`[AgentManager] Failed to get transcript for task ${taskId}:`, err)
      return []
    }
  }

  /**
   * Reconnects to an existing session by its persisted session ID.
   * Replays all messages to the renderer and resumes polling.
   */
  async resumeSession(agentId: string, taskId: string, sessionId: string): Promise<string> {
    console.log('[AgentManager] resumeSession called:', { agentId, taskId, sessionId })
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const adapter = this.getAdapter(agentId)
    if (!adapter) {
      throw new Error(`No adapter available for agent ${agentId}`)
    }

    return this.resumeAdapterSession(adapter, agentId, taskId, sessionId)
  }

  /**
   * Transitions a session to idle and notifies the renderer.
   * Extracts output field values BEFORE notifying so the renderer
   * picks up the updated task data on re-fetch.
   */
  private async replayMissedTranscriptPartsBeforeIdle(sessionId: string, session: AgentSession): Promise<void> {
    if (!session.adapter?.getAllMessages) return

    try {
      const config: SessionConfig = {
        agentId: session.agentId,
        taskId: session.taskId,
        workspaceDir: session.workspaceDir || this.db.getWorkspaceDir(session.taskId)
      }
      const messages = await session.adapter.getAllMessages(sessionId, config)
      const batchMessages: Array<{ id: string; role: string; content: string; partType?: string; tool?: unknown; taskProgress?: unknown; receivedAt?: number }> = []

      for (const message of messages) {
        if (message.role === MessageRole.USER) continue

        for (const part of message.parts) {
          const partId = part.id
          if (!partId || session.seenPartIds.has(partId)) continue
          const partType = String(part.type)
          if (partType === 'step-start' || partType === 'step-finish' || partType === 'system-status') {
            continue
          }

          session.seenPartIds.add(partId)
          if (part.content || part.text) {
            // Store actual text content, NOT length — partContentLengths is used
            // for chunk accumulation in streaming; storing a length string causes
            // the number to be prepended to the next streamed chunk.
            session.partContentLengths.set(partId, part.content || part.text || '')
          }

          batchMessages.push({
            id: partId,
            role: message.role,
            content: part.content || part.text || '',
            partType,
            tool: part.tool,
            taskProgress: part.taskProgress,
            receivedAt: part.receivedAt
          })
        }
      }

      if (batchMessages.length > 0) {
        console.log(`[AgentManager] Replaying ${batchMessages.length} missed transcript part(s) for ${sessionId} before idle`)
        this.sendToRenderer('agent:output-batch', {
          sessionId,
          taskId: session.taskId,
          messages: batchMessages
        })
      }
    } catch (err) {
      console.error(`[AgentManager] replayMissedTranscriptPartsBeforeIdle error for ${sessionId}:`, err)
    }
  }

  private async transitionToIdle(sessionId: string, session: AgentSession): Promise<void> {
    if (session.status === 'idle') {
      console.log(`[AgentManager] transitionToIdle: session ${sessionId} already idle, skipping`)
      return
    }
    session.status = 'idle'
    console.log(`[AgentManager] Session ${sessionId} → idle`)

    // Helper: yield event loop between synchronous DB operations so IPC,
    // timers and rendering callbacks can run.  transitionToIdle chains many
    // sync better-sqlite3 calls; without yields this blocks the main thread
    // for the entire duration and freezes the UI.
    const yieldEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

    // In learning mode, skip output extraction, task status, and renderer notification
    if (session.learningMode) return

    // In triage mode, set status back to NotStarted (now with agent_id assigned) and return early
    if (session.isTriageSession) {
      console.log(`[AgentManager] Triage session completed for task ${session.taskId}, reverting to NotStarted`)
      this.db.updateTask(session.taskId, { status: TaskStatus.NotStarted, session_id: null })
      await yieldEventLoop()

      this.sendToRenderer('task:updated', {
        taskId: session.taskId,
        updates: this.db.getTask(session.taskId) || { status: TaskStatus.NotStarted, session_id: null }
      })

      this.sendToRenderer('agent:status', {
        sessionId, agentId: session.agentId, taskId: session.taskId, status: 'idle'
      })

      // Clean up backend session — triage is done, no need to keep it
      this.sessions.delete(sessionId)
      console.log(`[SessionTracker] DESTROYED session=${sessionId} task=${session.taskId} reason=triage_completed`)
      return
    }

    // Polling can observe IDLE in the same tick that the adapter persists the
    // final assistant message. Reconcile once against the stored transcript so
    // the UI doesn't miss the last response.
    await this.replayMissedTranscriptPartsBeforeIdle(sessionId, session)
    await yieldEventLoop()

    // Check if task exists (e.g., orchestrator-session doesn't have a real task)
    const task = this.db.getTask(session.taskId)
    await yieldEventLoop()

    if (!task) {
      console.log(`[AgentManager] No task found for ${session.taskId}, sending idle status only`)
      this.sendToRenderer('agent:status', {
        sessionId, agentId: session.agentId, taskId: session.taskId, status: 'idle'
      })
      return
    }

    console.log(`[AgentManager] transitionToIdle checking task status: ${task.status} (looking for ${TaskStatus.AgentLearning})`)
    if (task.status === TaskStatus.AgentLearning) {
      console.log(`[AgentManager] Task in learning mode, syncing skills and marking as completed`)

      // Sync skills from workspace
      try {
        await this.syncSkillsFromWorkspace(sessionId)
      } catch (err) {
        console.error(`[AgentManager] Skill sync error:`, err)
      }
      await yieldEventLoop()

      // For enterprise tasks, call executeAction to notify the backend (e.g. Workflo)
      // before marking the task as completed locally. This mirrors the completion
      // path used by the renderer's onCompleteTask / handleFeedbackSkip.
      if (task.source_id && this.syncManager) {
        const actionField = task.output_fields?.find((f: OutputFieldRecord) => f.id === 'action')
        const actionValue = actionField?.value ? String(actionField.value) : PluginActionId.Complete
        console.log(`[AgentManager] Enterprise task — calling executeAction("${actionValue}") for source ${task.source_id}`)
        try {
          const result = await this.syncManager.executeAction(actionValue, task, undefined, task.source_id)
          if (!result.success) {
            console.error(`[AgentManager] executeAction failed:`, result.error)
            // Revert to ReadyForReview so user can retry completion manually
            this.db.updateTask(session.taskId, { status: TaskStatus.ReadyForReview })
            await yieldEventLoop()
            this.sendToRenderer('task:updated', {
              taskId: session.taskId,
              updates: { status: TaskStatus.ReadyForReview }
            })
            this.sendToRenderer('agent:status', {
              sessionId, agentId: session.agentId, taskId: session.taskId, status: 'idle'
            })
            return
          }
        } catch (err) {
          console.error(`[AgentManager] executeAction threw:`, err)
          this.db.updateTask(session.taskId, { status: TaskStatus.ReadyForReview })
          await yieldEventLoop()
          this.sendToRenderer('task:updated', {
            taskId: session.taskId,
            updates: { status: TaskStatus.ReadyForReview }
          })
          this.sendToRenderer('agent:status', {
            sessionId, agentId: session.agentId, taskId: session.taskId, status: 'idle'
          })
          return
        }
        await yieldEventLoop()
      }

      // Mark task as completed
      this.db.updateTask(session.taskId, { status: TaskStatus.Completed })
      await yieldEventLoop()

      this.sendToRenderer('task:updated', {
        taskId: session.taskId,
        updates: { status: TaskStatus.Completed }
      })

      this.sendToRenderer('agent:status', {
        sessionId, agentId: session.agentId, taskId: session.taskId, status: 'idle'
      })
      return
    }

    // Extract output field values BEFORE notifying the renderer
    try {
      await this.extractOutputValues(sessionId)
    } catch (err) {
      console.error(`[AgentManager] extractOutputValues error:`, err)
    }
    await yieldEventLoop()

    // Check again if task is still in a state where we should update it
    // (frontend might have already completed it during feedback flow)
    const taskAfterExtract = this.db.getTask(session.taskId)
    await yieldEventLoop()

    if (taskAfterExtract?.status === TaskStatus.AgentLearning || taskAfterExtract?.status === TaskStatus.Completed) {
      console.log(`[AgentManager] Task already in final state (${taskAfterExtract.status}), skipping status update`)
      this.sendToRenderer('agent:status', {
        sessionId, agentId: session.agentId, taskId: session.taskId, status: 'idle'
      })
      return
    }

    // Update task status to ready_for_review (only if task exists)
    if (task) {
      console.log(`[AgentManager] Updating task ${session.taskId} status to ReadyForReview`)
      this.db.updateTask(session.taskId, { status: TaskStatus.ReadyForReview })
      await yieldEventLoop()

      // Auto-enable heartbeat if agent wrote a heartbeat.md file
      this.autoEnableHeartbeat(session.taskId)
      await yieldEventLoop()

      // Get updated task with output fields and notify renderer
      const updatedTask = this.db.getTask(session.taskId)
      this.sendToRenderer('task:updated', {
        taskId: session.taskId,
        updates: {
          status: TaskStatus.ReadyForReview,
          output_fields: updatedTask?.output_fields,
          heartbeat_enabled: updatedTask?.heartbeat_enabled,
          heartbeat_interval_minutes: updatedTask?.heartbeat_interval_minutes,
          heartbeat_next_check_at: updatedTask?.heartbeat_next_check_at
        }
      })
    }

    this.sendToRenderer('agent:status', {
      sessionId, agentId: session.agentId, taskId: session.taskId, status: 'idle'
    })

    // Record enterprise sync event: agent run completed
    if (this.enterpriseStateSync && task && !session.isTriageSession && session.taskId !== 'mastermind-session' && !session.taskId.startsWith('heartbeat-')) {
      const durationMinutes = (Date.now() - session.createdAt.getTime()) / (1000 * 60)
      const agent = this.db.getAgent(session.agentId)
      this.enterpriseStateSync.recordAgentRunCompleted(task, {
        agentName: agent?.name,
        durationMinutes: Math.round(durationMinutes * 10) / 10,
        messageCount: session.seenMessageIds.size || undefined,
        success: true
      })
    }
  }

  /**
   * Interrupts the current generation, stops polling, keeps transcript.
   */
  async abortSession(sessionId: string): Promise<void> {
    let session = this.sessions.get(sessionId)

    // Fallback: session ID may have been re-keyed (temp → real) by pollSingleSession
    if (!session) {
      const redirectedId = this.sessionIdRedirects.get(sessionId)
      if (redirectedId) {
        const originalId = sessionId
        console.log(`[AgentManager] Session ${sessionId} re-keyed, redirecting abort to ${redirectedId}`)
        console.log(`[SessionTracker] REDIRECT from=${originalId} to=${redirectedId} reason=stale_id_in_abortSession`)
        sessionId = redirectedId
        session = this.sessions.get(sessionId)
      }
    }
    if (!session) return

    console.log(`[AgentManager] Aborting session ${sessionId}`)

    // Stop polling for this session
    this.stopAdapterPolling(sessionId)

    // Abort via adapter
    const adapter = this.getAdapter(session.agentId)
    if (adapter) {
      try {
        const sessionConfig = await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
        await adapter.abortPrompt(sessionId, sessionConfig)
      } catch (error) {
        console.error(`[AgentManager] Error aborting adapter session:`, error)
      }
    }

    session.status = 'idle'
    // Don't change task status on abort - preserve current state
    this.sendToRenderer('agent:status', {
      sessionId,
      agentId: session.agentId,
      taskId: session.taskId,
      status: 'idle'
    })
  }

  /**
   * Fully destroys the session — stops polling, removes from map.
   * @param resetTaskStatus - If true, resets task status to NotStarted (default: true)
   */
  async stopSession(sessionId: string, resetTaskStatus: boolean = true): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      console.log(`[AgentManager] Session ${sessionId} not found`)
      return
    }

    console.log(`[AgentManager] Destroying session ${sessionId} (resetTaskStatus=${resetTaskStatus})`)

    // Stop polling for this session
    this.stopAdapterPolling(sessionId)

    // Destroy via adapter
    const adapter = this.getAdapter(session.agentId)
    if (adapter) {
      try {
        const sessionConfig = await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
        await adapter.destroySession(sessionId, sessionConfig)
      } catch (error) {
        console.error(`[AgentManager] Error destroying adapter session:`, error)
      }
    }

    // Clean up secret broker session
    if (session.secretSessionToken) {
      unregisterSecretSession(session.secretSessionToken)
      console.log(`[AgentManager] Unregistered secret session for ${sessionId}`)
    }

    // Eagerly clear dedup structures to free memory immediately (don't wait for GC)
    session.seenMessageIds.clear()
    session.seenPartIds.clear()
    session.partContentLengths.clear()

    this.sessions.delete(sessionId)
    this.lastSentStatus.delete(sessionId)
    console.log(`[SessionTracker] DESTROYED session=${sessionId} task=${session.taskId} resetStatus=${resetTaskStatus} reason=stop_session`)

    // Clean up any redirect entries pointing to this session
    for (const [oldId, newId] of this.sessionIdRedirects.entries()) {
      if (newId === sessionId) {
        this.sessionIdRedirects.delete(oldId)
      }
    }

    // Only reset task status if explicitly requested (e.g., user manually stopped, not app shutdown)
    // But never reset if task is already Completed
    if (resetTaskStatus) {
      const task = this.db.getTask(session.taskId)
      if (task?.status !== TaskStatus.Completed) {
        this.db.updateTask(session.taskId, { status: TaskStatus.NotStarted })
      }
    }

    this.sendToRenderer('agent:status', {
      sessionId,
      agentId: session.agentId,
      taskId: session.taskId,
      status: 'idle'
    })
  }

  /**
   * Stops a session by taskId — used when the renderer's session mapping
   * is broken (Session: none) and the normal stop-by-sessionId path fails.
   */
  async stopByTaskId(taskId: string): Promise<{ sessionId: string | null }> {
    const found = this.findSessionByTaskId(taskId)
    if (!found) {
      console.log(`[AgentManager] stopByTaskId: no active session found for task ${taskId}`)
      return { sessionId: null }
    }
    console.log(`[AgentManager] stopByTaskId: found session ${found.sessionId} for task ${taskId}, stopping`)
    await this.stopSession(found.sessionId)
    return { sessionId: found.sessionId }
  }

  /**
   * Sends a message by taskId — used when the renderer's session mapping
   * is broken and the normal send-by-sessionId path can't resolve a sessionId.
   * Tries to find a live in-memory session first, then falls back to
   * sendMessage's built-in resume/create logic.
   */
  async sendByTaskId(
    taskId: string,
    message: string,
    attachments?: MessageAttachmentRef[]
  ): Promise<{ sessionId: string | null; newSessionId?: string }> {
    const found = this.findSessionByTaskId(taskId)
    if (found) {
      console.log(`[AgentManager] sendByTaskId: found live session ${found.sessionId} for task ${taskId}`)
      const result = await this.sendMessage(found.sessionId, message, taskId, found.session.agentId, attachments)
      return { sessionId: found.sessionId, ...result }
    }
    // No live session — delegate to sendMessage with empty sessionId.
    // Its internal logic will try resume from persisted session_id, or create a new one.
    console.log(`[AgentManager] sendByTaskId: no live session for task ${taskId}, delegating to sendMessage for recovery`)
    const result = await this.sendMessage('', message, taskId, undefined, attachments)
    return { sessionId: null, ...result }
  }

  async sendMessage(
    sessionId: string,
    message: string,
    taskId?: string,
    agentId?: string,
    attachments?: MessageAttachmentRef[]
  ): Promise<{ newSessionId?: string }> {
    let session = this.sessions.get(sessionId)

    // Check redirect map: session ID may have been re-keyed (temp → real)
    if (!session) {
      const redirectedId = this.sessionIdRedirects.get(sessionId)
      if (redirectedId) {
        console.log(`[AgentManager] Session ${sessionId} re-keyed, redirecting sendMessage to ${redirectedId}`)
        console.log(`[SessionTracker] REDIRECT from=${sessionId} to=${redirectedId} reason=stale_id_in_sendMessage`)
        sessionId = redirectedId
        session = this.sessions.get(sessionId)
      }
    }

    // Session was destroyed — try to RESUME first (preserves conversation history),
    // then fallback to creating a new session
    if (!session && taskId) {
      // For regular tasks, look up agent from DB; for mastermind, use the passed agentId
      const task = this.db.getTask(taskId)
      const resolvedAgentId = task?.agent_id || agentId

      if (resolvedAgentId) {
        // Try resuming existing session first
        const persistedSessionId = task?.session_id
        if (persistedSessionId) {
          try {
            console.log(`[AgentManager] Session ${sessionId} not found, attempting resume from ${persistedSessionId} for task ${taskId}`)
            console.log(`[SessionTracker] RESUME_ATTEMPT old=${sessionId} persisted=${persistedSessionId} task=${taskId} reason=session_not_in_memory`)
            const adapter = this.getAdapter(resolvedAgentId)
            if (adapter) {
              // Replay messages to the renderer so the client doesn't lose
              // conversation context after an idle period. Previously this used
              // replayToRenderer: false which caused ~20% context loss on mobile
              // and desktop when the in-memory session was evicted.
              const resumedId = await this.resumeAdapterSession(adapter, resolvedAgentId, taskId, persistedSessionId, {
                replayToRenderer: true
              })
              session = this.sessions.get(resumedId)
              if (session) {
                sessionId = resumedId
              }
            }
          } catch (error) {
            console.warn(`[AgentManager] Resume failed, will create new session:`, error)
          }
        }

        // If resume failed or no session_id, create new session
        if (!session) {
          console.log(`[AgentManager] Creating new session for task ${taskId}`)
          const newSessionId = await this.startSession(resolvedAgentId, taskId, undefined, true)
          session = this.sessions.get(newSessionId)
          if (!session) throw new Error('Failed to restart session')
          sessionId = newSessionId
          console.log(`[SessionTracker] CREATED_FALLBACK session=${newSessionId} task=${taskId} reason=resume_failed_or_no_persisted_session`)
        }

        // Send the user's message (fire-and-forget to avoid blocking IPC response)
        this.doSendAdapterMessage(session, sessionId, message, attachments).catch((err) => {
          console.error(`[AgentManager] doSendAdapterMessage failed for session ${sessionId}:`, err)
          this.handleSessionError(sessionId, session!, err)
        })
        return { newSessionId: sessionId }
      }
    }

    if (!session) throw new Error(`Session not found: ${sessionId}`)

    // Fire-and-forget to avoid blocking IPC response and freezing the renderer
    this.doSendAdapterMessage(session, sessionId, message, attachments).catch((err) => {
      console.error(`[AgentManager] doSendAdapterMessage failed for session ${sessionId}:`, err)
      this.handleSessionError(sessionId, session!, err)
    })
    return {}
  }

  /**
   * Handles errors from fire-and-forget doSendAdapterMessage calls.
   * Sends error status to the renderer so the UI reflects the failure.
   */
  private handleSessionError(sessionId: string, session: AgentSession, err: unknown): void {
    console.error(`[AgentManager] Session ${sessionId} error:`, err instanceof Error ? err.message : err)
    session.status = 'error'
    this.sendToRenderer('agent:status', {
      sessionId,
      agentId: session.agentId,
      taskId: session.taskId,
      status: 'error'
    })
  }

  private async doSendAdapterMessage(
    session: AgentSession,
    sessionId: string,
    message: string,
    attachments?: MessageAttachmentRef[]
  ): Promise<void> {
    if (session.status === 'error') {
      // Check if this is an incompatible session error (non-recoverable)
      if (session.adapter) {
        const adapterStatus = await session.adapter.getStatus(sessionId, {} as SessionConfig)
        if (adapterStatus.message?.includes('INCOMPATIBLE_SESSION_ID')) {
          throw new Error('Session is in error state: incompatible session')
        }
      }
      // Allow recovery from non-fatal errors (e.g., rate limits)
      console.log(`[AgentManager] Clearing error state for session ${sessionId} to allow recovery`)
      session.status = 'working'
      // Reset polling flag so polling restarts with the new message
      session.pollingStarted = false
    }
    if (!session.adapter) throw new Error('Adapter not initialized')

    // Sync any attachments added mid-session into the workspace so
    // the agent can reference them immediately.
    if (session.workspaceDir) {
      this.syncAttachmentsToWorkspace(session.taskId, session.workspaceDir)
    }

    // Update status to working (but preserve AgentLearning if set)
    session.status = 'working'
    const currentTask = this.db.getTask(session.taskId)
    if (currentTask?.status !== TaskStatus.AgentLearning) {
      this.db.updateTask(session.taskId, { status: TaskStatus.AgentWorking })
    }
    this.sendToRenderer('agent:status', {
      sessionId,
      agentId: session.agentId,
      taskId: session.taskId,
      status: 'working'
    })

    // Record enterprise sync event: agent run started (follow-up message)
    // Each working→idle cycle is a separate agent run. Without this,
    // follow-up messages produce agent_run_completed without a matching started.
    if (this.enterpriseStateSync && currentTask && !session.isTriageSession && session.taskId !== 'mastermind-session' && !session.taskId.startsWith('heartbeat-')) {
      const agent = this.db.getAgent(session.agentId)
      this.enterpriseStateSync.recordAgentRunStarted(currentTask, agent?.name)
    }

    const userFacingMessage = this.buildDisplayMessage(message, attachments)

    // Show user's message in UI
    this.sendToRenderer('agent:output', {
      sessionId,
      taskId: session.taskId,
      type: 'message',
      data: {
        id: `user-message-${Date.now()}`,
        role: 'user',
        content: userFacingMessage,
        partType: 'text'
      }
    })

    // Build session config (includes secret broker fields if agent has secrets)
    const sessionConfig = await this.buildSessionConfig(
      session.agentId,
      session.taskId,
      session.workspaceDir || process.cwd()
    )

    // Send prompt via adapter
    const promptText = this.buildMessageWithAttachmentContext(session, message, attachments)
    const parts: MessagePart[] = [{ type: MessagePartType.TEXT, text: promptText }]
    await session.adapter.sendPrompt(sessionId, parts, sessionConfig)

    // Start polling if not already started (for Claude Code after resume)
    if (!session.pollingStarted) {
      console.log(`[AgentManager] Starting polling for session ${sessionId} (preserving dedup state)`)
      session.pollingStarted = true
      // Pass existing session so dedup state (seenMessageIds, seenPartIds) is preserved
      // from previous polling cycle — prevents old messages from being re-sent to renderer
      this.startAdapterPolling(sessionId, session.adapter, sessionConfig, undefined, session)
    }
  }

  async respondToPermission(sessionId: string, approved: boolean, message?: string, optionId?: string): Promise<void> {
    let session = this.sessions.get(sessionId)

    // Fallback: session ID may have been re-keyed (temp → real) by pollSingleSession.
    // The renderer might still hold the stale temp ID. Check the redirect map.
    if (!session) {
      const redirectedId = this.sessionIdRedirects.get(sessionId)
      if (redirectedId) {
        console.log(`[AgentManager] Session ${sessionId} re-keyed, redirecting to ${redirectedId}`)
        console.log(`[SessionTracker] REDIRECT from=${sessionId} to=${redirectedId} reason=stale_id_in_respondToPermission`)
        sessionId = redirectedId
        session = this.sessions.get(sessionId)
      }
    }
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    const adapter = this.getAdapter(session.agentId)

    // --- ACP adapters: use respondToApproval (permission-style options) ---
    if (adapter && 'respondToApproval' in adapter && typeof (adapter as unknown as AcpAdapter).respondToApproval === 'function') {
      let selectedOption = optionId
      if (!selectedOption && message) {
        const answerMap: Record<string, string> = {
          'Always': 'approved-for-session',
          'Yes': 'approved',
          'No, provide feedback': 'abort',
          'No': 'abort'
        }
        selectedOption = answerMap[message] || (approved ? 'approved' : 'abort')
      }
      console.log(`[AgentManager] Responding to ACP adapter approval with: ${selectedOption}`)
      // OpenCode adapter returns boolean (true=handled, false=no permission found).
      // AcpAdapter returns void. Cast to boolean|void to handle both.
      const handled = await (adapter as unknown as { respondToApproval: (sid: string, approved: boolean, opt?: string) => Promise<boolean | void> }).respondToApproval(sessionId, approved, selectedOption)

      // If no pending permission was found (stale prompt after watchdog abort
      // or app restart), send a continuation message so the session recovers.
      // AcpAdapter returns void (undefined), which won't match === false.
      if (handled === false && approved) {
        console.log(`[AgentManager] No pending permission found for ${sessionId}, sending continuation message to recover session`)
        this.doSendAdapterMessage(session, sessionId, 'continue').catch((err) => {
          console.error(`[AgentManager] Continuation message failed for session ${sessionId}:`, err)
          this.handleSessionError(sessionId, session!, err)
        })
      }
      return
    }

    // --- Adapters with respondToQuestion: pass structured answers ---
    if (adapter && typeof adapter.respondToQuestion === 'function') {
      if (!approved) {
        console.log(`[AgentManager] Question rejected for session ${sessionId}`)
        session.status = 'idle'
        this.sendToRenderer('agent:status', {
          sessionId, agentId: session.agentId, taskId: session.taskId, status: 'idle'
        })
        return
      }

      // Parse structured answers from message text
      // Format from renderer: "Header1: Answer1\nHeader2: Answer2" or single answer
      const answers: Record<string, string> = {}
      if (message) {
        const lines = message.split('\n')
        for (const line of lines) {
          const colonIdx = line.indexOf(':')
          if (colonIdx > 0) {
            answers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
          } else {
            answers['answer'] = line.trim()
          }
        }
      }

      console.log(`[AgentManager] Responding to question via adapter for session ${sessionId}:`, answers)

      // Update session and task state before sending
      session.status = 'working'
      const currentTask = this.db.getTask(session.taskId)
      if (currentTask?.status !== TaskStatus.AgentLearning) {
        this.db.updateTask(session.taskId, { status: TaskStatus.AgentWorking })
      }
      this.sendToRenderer('agent:status', {
        sessionId, agentId: session.agentId, taskId: session.taskId, status: 'working'
      })

      // Show user's answer in UI
      if (message) {
        this.sendToRenderer('agent:output', {
          sessionId,
          taskId: session.taskId,
          type: 'message',
          data: {
            id: `user-answer-${Date.now()}`,
            role: 'user',
            content: message,
            partType: 'text'
          }
        })
      }

      const adapterConfig = await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
      await adapter.respondToQuestion(sessionId, answers, adapterConfig)

      // Restart polling if it was stopped (session may have gone idle before answer)
      if (!session.pollingStarted && session.adapter) {
        console.log(`[AgentManager] Restarting polling after question answer for session ${sessionId}`)
        session.pollingStarted = true
        this.startAdapterPolling(sessionId, session.adapter, adapterConfig)
      }
      return
    }

    console.warn(`[AgentManager] No adapter handler for permission response in session ${sessionId}`)
  }

  async stopAllSessions(): Promise<void> {
    console.log(`[AgentManager] Stopping all ${this.sessions.size} sessions`)

    // Stop the centralized polling coordinator first
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer)
      this.pollingTimer = null
    }
    this.pollingEntries.clear()

    await Promise.allSettled(
      [...this.sessions.keys()].map((sessionId) => {
        // Don't reset task status during app shutdown - preserve current status
        return this.stopSession(sessionId, false)
      })
    )
  }

  getSessionStatus(sessionId: string): { status: string; agentId: string; taskId: string } | null {
    let session = this.sessions.get(sessionId)

    // Fallback: session ID may have been re-keyed (temp → real) by pollSingleSession.
    // The mobile client might still hold the stale temp ID. Check the redirect map.
    if (!session) {
      const redirectedId = this.sessionIdRedirects.get(sessionId)
      if (redirectedId) {
        session = this.sessions.get(redirectedId)
      }
    }

    if (!session) return null
    return { status: session.status, agentId: session.agentId, taskId: session.taskId }
  }

  /**
   * Replay all messages from a running session via the adapter.
   * Used by the mobile API to sync with an already-running session.
   * Sends a single agent:output-batch event (matching resumeAdapterSession pattern)
   * to avoid content filtering, step-start/step-finish absorption, and dedup issues
   * that affect individual agent:output events.
   */
  async replaySessionMessages(sessionId: string): Promise<void> {
    let session = this.sessions.get(sessionId)

    // Fallback: session ID may have been re-keyed (temp → real).
    // The mobile client might still hold the stale temp ID.
    if (!session) {
      const redirectedId = this.sessionIdRedirects.get(sessionId)
      if (redirectedId) {
        sessionId = redirectedId
        session = this.sessions.get(sessionId)
      }
    }

    if (!session?.adapter?.getAllMessages) return

    const messages = await session.adapter.getAllMessages(sessionId, {
      agentId: session.agentId,
      taskId: session.taskId,
      workspaceDir: session.workspaceDir || process.cwd()
    })

    // Collect all message parts into a single batch (matching resumeAdapterSession pattern)
    const batchMessages: Array<{ id: string; role: string; content: string; partType?: string; tool?: unknown; update?: boolean; taskProgress?: unknown; receivedAt?: number }> = []
    for (const msg of messages) {
      for (const part of msg.parts) {
        batchMessages.push({
          id: part.id || `${msg.id}-${msg.parts.indexOf(part)}`,
          role: msg.role === MessageRole.USER ? 'user' : msg.role === MessageRole.ASSISTANT ? 'assistant' : 'system',
          content: part.text || part.content || '',
          partType: part.type?.toLowerCase(),
          tool: part.tool ? {
            name: part.tool.name,
            status: part.tool.status || part.state?.status || '',
            title: part.tool.title || part.state?.title || '',
            input: typeof part.tool.input === 'string' ? part.tool.input : part.tool.input ? JSON.stringify(part.tool.input) : undefined,
            output: typeof part.tool.output === 'string' ? part.tool.output : part.tool.output ? JSON.stringify(part.tool.output) : undefined,
            error: part.tool.error || part.state?.error,
            questions: part.tool.questions,
            todos: part.tool.todos
          } : undefined,
          taskProgress: part.taskProgress,
          receivedAt: part.receivedAt,
          // Pass update flag so mobile store merges tool results into their
          // pending tool_use entries (e.g. status pending → success)
          ...(part.update ? { update: true } : {})
        })
      }
    }

    if (batchMessages.length > 0) {
      this.sendToRenderer('agent:output-batch', {
        sessionId,
        taskId: session.taskId,
        messages: batchMessages
      })
    }

    // Also send current status
    this.sendToRenderer('agent:status', {
      sessionId,
      agentId: session.agentId,
      taskId: session.taskId,
      status: session.status
    })
  }

  getActiveSessionsForTask(taskId: string): string[] {
    const sessionIds: string[] = []
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.taskId === taskId && session.status !== 'error') {
        sessionIds.push(sessionId)
      }
    }
    return sessionIds
  }

  /**
   * Tests an MCP server by speaking the MCP protocol directly
   * (JSON-RPC over stdio for local, HTTP POST for remote).
   */
  async testMcpServer(serverData: { name: string; type?: string; command?: string; args?: string[]; url?: string; headers?: Record<string, string>; environment?: Record<string, string> }): Promise<{ status: 'connected' | 'failed'; error?: string; toolCount?: number; tools?: { name: string; description: string }[] }> {
    if (serverData.type === 'remote') {
      return this.testRemoteMcpServer(serverData)
    }
    return this.testLocalMcpServer(serverData)
  }

  private testLocalMcpServer(serverData: { name: string; command?: string; args?: string[]; environment?: Record<string, string> }): Promise<{ status: 'connected' | 'failed'; error?: string; errorDetail?: string; toolCount?: number; tools?: { name: string; description: string }[] }> {
    if (!serverData.command) {
      return Promise.resolve({ status: 'failed', error: 'No command specified' })
    }

    return new Promise((resolve) => {
      let resolved = false
      const finish = (result: { status: 'connected' | 'failed'; error?: string; errorDetail?: string; toolCount?: number; tools?: { name: string; description: string }[] }): void => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        try { proc.kill('SIGTERM') } catch {}
        resolve(result)
      }

      const timer = setTimeout(() => {
        finish({ status: 'failed', error: 'Connection timeout (30s)' })
      }, 30000)

      // Inject TASK_API_URL for the built-in task-management server
      const extraEnv: Record<string, string> = {}
      if (serverData.name === 'task-management') {
        const apiPort = getTaskApiPort()
        if (apiPort) extraEnv.TASK_API_URL = `http://127.0.0.1:${apiPort}`
      }

      // Spawn directly with args array (no shell quoting) to avoid Windows single-quote issues.
      // Only use shell mode for commands that need it (npx, .cmd/.bat wrappers).
      const needsShell = /^(npx|uvx|bunx)\b/.test(serverData.command!) || (process.platform === 'win32' && /\.(cmd|bat)$/i.test(serverData.command!))
      const proc = spawn(serverData.command!, serverData.args || [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(needsShell ? { shell: true } : {}),
        env: { ...process.env, npm_config_yes: 'true', ...(serverData.environment || {}), ...extraEnv }
      })

      let buffer = ''
      let stderrBuf = ''
      let phase: 'init' | 'tools' = 'init'

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString()
      })

      const handleMessage = (msg: { id?: number; error?: { message?: string }; result?: { tools?: { name?: string; description?: string }[] } }): void => {
        if (msg.error) {
          finish({ status: 'failed', error: msg.error.message || JSON.stringify(msg.error) })
          return
        }

        if (phase === 'init' && msg.id === 1 && msg.result) {
          phase = 'tools'
          // Send initialized notification + tools/list request
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
        } else if (phase === 'tools' && msg.id === 2 && msg.result) {
          const rawTools = Array.isArray(msg.result.tools) ? msg.result.tools : []
          const tools = rawTools.map((t) => ({ name: t.name || '', description: t.description || '' }))
          finish({ status: 'connected', toolCount: tools.length, tools })
        }
      }

      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        // Parse newline-delimited JSON messages
        let idx: number
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          try { handleMessage(JSON.parse(line)) } catch {}
        }
        // Try parsing buffer as complete JSON (server may not send trailing newline)
        if (buffer.trim()) {
          try {
            const msg = JSON.parse(buffer.trim())
            buffer = ''
            handleMessage(msg)
          } catch {}
        }
      })

      proc.on('error', (err) => {
        finish({ status: 'failed', error: err.message })
      })

      proc.on('exit', (code) => {
        const lines = stderrBuf.trim().split('\n')
        // Find a line matching an error pattern (e.g. "TypeError: ...", "Error [ERR_...]: ...")
        const errorLine = lines.find((l) => /\bError\b/.test(l) && !/^\s+at /.test(l) && !/^Node\.js v/.test(l))
        const errMsg = errorLine?.trim() || `Process exited with code ${code}`
        const detail = stderrBuf.trim().replace(/\nNode\.js v.+$/, '').trim()
        finish({ status: 'failed', error: errMsg, errorDetail: detail || undefined })
      })

      // Send initialize
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'pf-desktop', version: '1.0.0' }
        }
      }) + '\n')
    })
  }

  private async testRemoteMcpServer(serverData: { name: string; url?: string; headers?: Record<string, string> }): Promise<{ status: 'connected' | 'failed'; error?: string; toolCount?: number; tools?: { name: string; description: string }[] }> {
    if (!serverData.url) {
      return { status: 'failed', error: 'No URL specified' }
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...serverData.headers }

      // Inject enterprise JWT for servers hosted on the enterprise API
      if (this.enterpriseAuth) {
        try {
          const apiUrl = this.enterpriseAuth.getApiUrl()
          if (serverData.url.startsWith(apiUrl)) {
            const jwt = await this.enterpriseAuth.getJwt()
            headers['Authorization'] = `Bearer ${jwt}`
          }
        } catch { /* proceed without JWT — will likely get 401/403 */ }
      }

      // Try streamable HTTP — POST initialize directly
      const initRes = await fetch(serverData.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pf-desktop', version: '1.0.0' } }
        }),
        signal: AbortSignal.timeout(10000)
      })

      if (!initRes.ok) {
        return { status: 'failed', error: `HTTP ${initRes.status}: ${initRes.statusText}` }
      }

      const contentType = initRes.headers.get('content-type') || ''

      if (contentType.includes('application/json')) {
        const initData = await initRes.json()
        if (initData.error) {
          return { status: 'failed', error: initData.error.message || 'Initialize failed' }
        }

        // Send initialized notification (fire-and-forget)
        fetch(serverData.url, {
          method: 'POST', headers,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
        }).catch(() => {})

        // Request tools
        const toolsRes = await fetch(serverData.url, {
          method: 'POST', headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
          signal: AbortSignal.timeout(10000)
        })
        const toolsData = await toolsRes.json()
        const rawTools = Array.isArray(toolsData.result?.tools) ? toolsData.result.tools : []
        const tools = rawTools.map((t: { name?: string; description?: string }) => ({ name: t.name || '', description: t.description || '' }))
        return { status: 'connected', toolCount: tools.length, tools }
      }

      // Non-JSON response (SSE or other) — server is reachable but uses SSE transport
      return { status: 'connected' }
    } catch (error: unknown) {
      return { status: 'failed', error: error instanceof Error ? error.message : 'Connection failed' }
    }
  }


  async getProviders(serverUrl?: string, directory?: string, backendType?: string): Promise<{ providers: { id: string; name: string; [key: string]: unknown }[]; default: Record<string, string> } | null> {
    try {
      // Determine which server URL to use
      const baseUrl = serverUrl || (() => {
        const agents = this.db.getAgents()
        const defaultAgent = agents.find((a) => a.is_default) || agents[0]
        return defaultAgent?.server_url || DEFAULT_SERVER_URL
      })()

      // Identify the backend type: use the explicit parameter, fall back to default agent config
      const resolvedBackend = backendType || (() => {
        const agents = this.db.getAgents()
        const defaultAgent = agents.find((a) => a.is_default) || agents[0]
        return (defaultAgent?.config?.coding_agent as string) || CodingAgentType.OPENCODE
      })()

      // Only the OpenCode adapter exposes configurable providers/models.
      // For other backends (claude-code, codex), provider listing isn't supported.
      if (resolvedBackend !== CodingAgentType.OPENCODE) {
        console.log(`[AgentManager] Backend "${resolvedBackend}" does not support provider listing, skipping`)
        return null
      }

      // Refresh the AI gateway virtual key before querying providers so the
      // OpenCode server config includes the Peakflo provider. This handles
      // plans activated after the initial tenant selection (same pattern as
      // startAdapterSession). Best-effort — fall back to the cached key.
      // Since this is user-initiated (settings UI), notify the adapter so it
      // pushes the updated config — this is safe because the user is in settings,
      // not actively running parallel tasks.
      if (this.enterpriseAuth) {
        try {
          await this.enterpriseAuth.refreshAiGatewayVirtualKey()
        } catch (err) {
          console.warn('[AgentManager] AI gateway key refresh before getProviders failed (will use cached key):', err)
        }
      }

      const adapter = this.getAdapterByType(resolvedBackend)
      if (!adapter?.getProviders) {
        console.log(`[AgentManager] Adapter for "${resolvedBackend}" does not support getProviders`)
        return null
      }

      // Push updated config to the server before querying providers. This is
      // user-initiated (settings UI) so it's safe to push even if sessions are
      // running — the user explicitly opened settings to change config.
      if (adapter.notifyConfigChanged) {
        try {
          await adapter.notifyConfigChanged()
        } catch {
          // notifyConfigChanged already logs; proceed with cached config
        }
      }

      return await adapter.getProviders(baseUrl, directory)
    } catch (error: unknown) {
      console.log('[AgentManager] Could not get providers:', error instanceof Error ? error.message : error)
      return null
    }
  }

  /**
   * Gets or creates an adapter by backend type (without requiring an agent ID).
   */
  private getAdapterByType(backendType: string): CodingAgentAdapter | null {
    if (this.adapters.has(backendType)) {
      return this.adapters.get(backendType)!
    }

    let adapter: CodingAgentAdapter | null = null
    switch (backendType) {
      case CodingAgentType.OPENCODE:
        adapter = new OpencodeAdapter(this.db)
        break
      case CodingAgentType.CLAUDE_CODE:
        adapter = new ClaudeCodeAdapter()
        break
    }

    if (adapter) {
      this.adapters.set(backendType, adapter)
    }
    return adapter
  }

  /**
   * Builds instructions for the agent about output fields to fill.
   */
  private buildOutputFieldInstructions(fields: OutputFieldRecord[]): string {
    const lines: string[] = [
      '\n\n---',
      'When you complete this task, provide the following outputs.',
      'Include your answers in a JSON code block at the end of your final message.',
      'Use the exact field names as keys:\n'
    ]

    // Build example JSON
    const exampleObj: Record<string, string> = {}
    for (const field of fields) {
      const attrs: string[] = [field.type]
      if (field.required) attrs.push('required')
      if (field.multiple) attrs.push('multiple')
      if (field.options?.length) attrs.push(`options: ${field.options.join(', ')}`)

      lines.push(`- ${field.name} (${attrs.join(', ')})`)
      exampleObj[field.name] = field.type === 'file' ? '</absolute/path/to/file>' : `<${field.type} value>`
    }

    const hasFileFields = fields.some((f) => f.type === 'file')
    if (hasFileFields) {
      lines.push('\nFor file fields, return the absolute path to the file you created in the workspace.')
    }

    lines.push('\nExample output format (if you have ``` inside the output - escape with \\`\\`\\`):')
    lines.push('```json')
    lines.push(JSON.stringify(exampleObj, null, 2))
    lines.push('```')

    return lines.join('\n')
  }

  private resolveDefaultAgentId(): string | null {
    const agents = this.db.getAgents()
    const defaultAgent = agents.find((agent) => agent.is_default)
    return defaultAgent?.id ?? agents[0]?.id ?? null
  }

  private buildTriagePrompt(task: TaskRecord): string {
    return `You are triaging a new task. Your job is to analyze this task and assign the best agent, skills, repos, priority, and labels. Do NOT work on the task itself.

Task ID: ${task.id}
Title: ${task.title}
Description: ${task.description || '(none)'}
Type: ${task.type || 'general'}
Current Priority: ${task.priority || 'medium'}
Current Labels: ${JSON.stringify(task.labels || [])}
Current Output Fields: ${JSON.stringify(task.output_fields || [])}
Parent Task: ${task.parent_task_id ? `This is a subtask of task ${task.parent_task_id}` : 'None (top-level task)'}

IMPORTANT: For ALL task operations below, use ONLY the \`task-management\` MCP server tools (e.g. \`mcp__task-management__update_task\`, \`mcp__task-management__create_subtask\`). Do NOT use integration/sync tools like \`pf-workflo-integrations\` for updating tasks — those are for external system sync only.

Follow these steps:

1. Call \`find_similar_tasks\` with individual keywords extracted from the title/description. Pass them as space-separated words in \`title_keywords\` (e.g. "login bug fix" not the full title). Do NOT set \`completed_only\` — search all tasks so you find patterns even if tasks are still in progress.
2. Call \`list_agents\` to see available agents and their capabilities.
3. Call \`list_skills\` to see available skills.
4. Call \`list_repos\` to see known repositories.
5. Based on the similar tasks and available resources, determine:
   - The best agent_id to assign (REQUIRED — you must set this)
   - Relevant skill_ids (if any match the task)
   - Appropriate repos (if the task relates to specific repositories)
   - Priority (critical/high/medium/low) — adjust if the current priority seems wrong
   - Labels — suggest relevant labels based on similar tasks
   - output_fields — define the expected structured outputs for this task. Think about what concrete deliverables or data the agent should produce. Each output field needs an id (snake_case), name (human-readable), and type (text, number, url, file, boolean, textarea, list, date, email, country, currency). Mark fields as required if they are essential. Examples:
     - A coding task might have: { id: "pr_url", name: "Pull Request URL", type: "url", required: true }
     - A research task might have: { id: "summary", name: "Summary", type: "textarea", required: true }
     - A review task might have: { id: "approved", name: "Approved", type: "boolean", required: true }
6. If the task is complex and clearly involves multiple distinct steps that would benefit from separate agents or sequential human review, create subtasks using \`create_subtask\` from the \`task-management\` MCP server. Each subtask should:
   - Have a clear, specific title describing one step
   - Be assigned to the most appropriate agent_id (REQUIRED for each subtask)
   - Have relevant skill_ids assigned based on what skills match that subtask's work
   - Have repos set to the repositories relevant to that subtask (inherits from parent if not specified)
   - Include a description explaining the subtask's scope, expected output, and how it relates to other subtasks
   - Have output_fields defined to specify what structured data the subtask agent should produce
   - NOT overlap with other subtasks — each subtask should be a distinct, self-contained piece of work
   Only create subtasks when clearly needed — simple tasks should remain as single tasks.
   When creating subtasks, consider the order of execution and dependencies between them.
   Each subtask will run as a separate agent session with access to the parent task and sibling subtask outputs for coordination.
7. Call \`update_task\` ONCE with task_id "${task.id}" and all the values you determined. You MUST include agent_id and output_fields.
   If you created subtasks, the parent task's agent will coordinate the overall work.

Important:
- You MUST assign an agent_id to the parent task. If only one agent exists, assign that one.
- You MUST also assign an agent_id to each subtask you create.
- Do NOT change the task status — it will be handled automatically.
- Do NOT attempt to work on or solve the task. Only triage it.
- If no similar tasks exist, use your best judgment based on the title, description, and type.
- Be efficient — make your tool calls and finish quickly.
- If the task already has output_fields defined (from an external source), preserve them and only add additional fields if needed. Do not remove existing output fields.
- When creating subtasks, the parent task's agent will coordinate — subtask agents handle individual pieces.
- Subtask agents can see the parent task, all sibling subtasks' status/resolution/outputs, and sibling transcripts for coordination.
- NEVER use external integration MCP tools (like pf-workflo-integrations) for local task updates — always use task-management tools.`
  }

  /**
   * Extracts output field values from the last assistant message
   * and from the outputs directory on session completion.
   */
  private async extractOutputValues(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.adapter) return

    const task = this.db.getTask(session.taskId)
    if (!task?.output_fields || task.output_fields.length === 0) return

    console.log(`[AgentManager] Extracting output values for task ${session.taskId}`)

    try {
      // Use standardized getAllMessages from adapter
      let messages: SessionMessage[] = []

      if (session.adapter.getAllMessages) {
        messages = await session.adapter.getAllMessages(sessionId, {
          agentId: session.agentId,
          taskId: session.taskId,
          workspaceDir: session.workspaceDir || process.cwd()
        })
      } else {
        console.warn('[AgentManager] Adapter does not implement getAllMessages')
        return
      }

      if (messages.length === 0) {
        console.log('[AgentManager] No messages found')
        return
      }

      // Filter for assistant messages
      const assistantMessages = messages.filter((m) => m.role === 'assistant')
      let parsedValues: Record<string, unknown> = {}

      // Collect file paths from completed write/edit tool calls
      const writtenFiles: string[] = []
      for (const msg of assistantMessages) {
        if (!msg.parts) continue
        for (const part of msg.parts) {
          if (part.type !== 'tool' || part.state?.status !== 'completed') continue
          const toolName = (typeof part.tool === 'string' ? part.tool : part.tool?.name || '').toLowerCase()
          if (toolName === 'write' || toolName === 'edit' || toolName === 'create_file') {
            const input = (part.state?.input || {}) as Record<string, string | undefined>
            const filePath = input.file_path || input.path || input.filename
            if (filePath) writtenFiles.push(filePath)
          }
        }
      }
      if (writtenFiles.length > 0) {
        console.log(`[AgentManager] Found ${writtenFiles.length} written file(s):`, writtenFiles)
      }

      // Extract JSON block from ALL assistant text (search last message first, then earlier ones)
      for (let i = assistantMessages.length - 1; i >= 0; i--) {
        const msg = assistantMessages[i]
        if (!msg.parts) continue

        const fullText = msg.parts
          .filter((p) => p.type === 'text' && p.text)
          .map((p) => p.text)
          .join('\n')

        if (!fullText) continue

        const jsonMatch = fullText.match(/```json\s*\n?([\s\S]*?)\n?\s*```/)
          || fullText.match(/```\s*\n?([\s\S]*?)\n?\s*```/)

        if (jsonMatch) {
          const raw = jsonMatch[1].trim()
          try {
            parsedValues = JSON.parse(raw)
            break
          } catch (err) {
            // JSON truncated — extract complete key-value pairs via regex
            parsedValues = this.extractPartialJson(raw)
            if (Object.keys(parsedValues).length > 0) {
              break
            }
          }
        }
      }

      if (Object.keys(parsedValues).length === 0) {
        console.log(`[AgentManager] No JSON output block found in assistant messages`)
      }

      // Build lookup maps: name → value and id → value (case-insensitive name match)
      const byName = new Map<string, unknown>()
      const byId = new Map<string, unknown>()
      for (const [key, value] of Object.entries(parsedValues)) {
        byId.set(key, value)
        byName.set(key.toLowerCase(), value)
      }

      // Map parsed values to fields — match by name first, then by id
      const updatedFields = task.output_fields.map((field) => {
        const updated = { ...field }

        const valueByName = byName.get(field.name.toLowerCase())
        const valueById = byId.get(field.id)
        if (valueByName !== undefined) {
          updated.value = valueByName
        } else if (valueById !== undefined) {
          updated.value = valueById
        }

        // For file fields: use written file paths from tool calls
        if (field.type === 'file' && !updated.value && writtenFiles.length > 0) {
          updated.value = field.multiple ? writtenFiles : writtenFiles[0]
        }

        return updated
      })

      // Save updated output fields
      this.db.updateTask(session.taskId, { output_fields: updatedFields })
      console.log(`[AgentManager] Extracted output values for task ${session.taskId}`)
    } catch (error) {
      console.error(`[AgentManager] Error extracting output values:`, error)
    }
  }

  /**
   * Extracts complete key-value pairs from truncated JSON.
   * Handles cases where LLM output was cut off mid-value.
   */
  private extractPartialJson(raw: string): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    // Match "key": "value" pairs that are fully closed (string values)
    const stringPairs = raw.matchAll(/"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)
    for (const m of stringPairs) {
      result[m[1]] = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
    // Match "key": number/boolean/null pairs
    const literalPairs = raw.matchAll(/"([^"]+)"\s*:\s*(true|false|null|-?\d+(?:\.\d+)?)\s*[,}\n]/g)
    for (const m of literalPairs) {
      result[m[1]] = JSON.parse(m[2])
    }
    return result
  }

  /**
   * Parses a SKILL.md file's raw content into name, description, and content.
   * Expected format: ---\nname: ...\ndescription: ...\n---\n\ncontent
   */
  private parseSkillMd(raw: string): { name: string; description: string; content: string; confidence?: number; uses?: number; last_used?: string | null; tags?: string[] } | null {
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n\n?([\s\S]*)$/)
    if (!match) return null

    const frontmatter = match[1]
    const content = match[2].trim()

    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
    if (!nameMatch) return null

    // Strip surrounding double quotes — writeSkillFiles now wraps values in
    // double quotes to prevent YAML parsing errors from colons/brackets.
    const stripQuotes = (v: string): string => {
      const t = v.trim()
      if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      return t
    }
    const name = stripQuotes(nameMatch[1])
    const description = descMatch ? stripQuotes(descMatch[1]) : ''

    // Validate name pattern
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return null

    // Parse optional metadata
    const confidenceMatch = frontmatter.match(/^confidence:\s*([0-9.]+)$/m)
    const usesMatch = frontmatter.match(/^uses:\s*(\d+)$/m)
    const lastUsedMatch = frontmatter.match(/^lastUsed:\s*(.+)$/m)
    const tagsMatch = frontmatter.match(/^tags:\s*\n((?:  - .+\n?)+)/m)

    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : undefined
    const uses = usesMatch ? parseInt(usesMatch[1], 10) : undefined
    const last_used = lastUsedMatch ? lastUsedMatch[1].trim() : undefined

    let tags: string[] | undefined
    if (tagsMatch) {
      tags = tagsMatch[1]
        .split('\n')
        .map(line => line.trim().replace(/^- /, ''))
        .filter(Boolean)
    }

    return { name, description, content, confidence, uses, last_used, tags }
  }

  /**
   * Scans .opencode/skills/ in the session's workspace, compares with DB,
   * and creates/updates skills that have changed.
   */
  syncSkillsFromWorkspace(sessionId: string): { created: string[]; updated: string[]; unchanged: string[] } {
    const session = this.sessions.get(sessionId)
    if (!session?.workspaceDir) {
      console.log(`[AgentManager] syncSkillsFromWorkspace: no session or workspaceDir for ${sessionId} (sessions count: ${this.sessions.size})`)
      return { created: [], updated: [], unchanged: [] }
    }

    // Scan .claude/skills/ (Claude Code), .agents/skills/ (other agents), and .opencode/skills/ (legacy)
    const skillsDirs = [
      join(session.workspaceDir, '.claude', 'skills'),
      join(session.workspaceDir, '.agents', 'skills'),
      join(session.workspaceDir, '.opencode', 'skills')
    ].filter(existsSync)
    console.log(`[AgentManager] syncSkillsFromWorkspace: workspaceDir=${session.workspaceDir}, skillsDirs found=${skillsDirs.length}`, skillsDirs)
    if (skillsDirs.length === 0) {
      return { created: [], updated: [], unchanged: [] }
    }

    const result = { created: [] as string[], updated: [] as string[], unchanged: [] as string[] }
    const seen = new Set<string>()

    for (const skillsDir of skillsDirs) {
    let entries: string[]
    try {
      entries = readdirSync(skillsDir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = join(skillsDir, entry)
      let skillFile: string
      let fallbackName: string | undefined

      try {
        const st = statSync(entryPath)
        if (st.isDirectory()) {
          // .opencode/skills/<name>/SKILL.md
          skillFile = join(entryPath, 'SKILL.md')
          if (!existsSync(skillFile)) continue
          fallbackName = entry.replace(/_/g, '-')
        } else if (entry.endsWith('.md')) {
          // .opencode/skills/<name>.md (flat file)
          skillFile = entryPath
          fallbackName = entry.replace(/\.md$/, '').replace(/_/g, '-')
        } else {
          continue
        }
      } catch {
        continue
      }

      let raw: string
      try {
        raw = readFileSync(skillFile, 'utf-8')
      } catch {
        continue
      }

      // Try frontmatter parse; fall back to deriving name from filename
      let parsed = this.parseSkillMd(raw)
      if (!parsed && fallbackName && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(fallbackName)) {
        parsed = { name: fallbackName, description: '', content: raw.trim() }
      }
      if (!parsed) continue
      if (seen.has(parsed.name)) continue
      seen.add(parsed.name)

      const existing = this.db.getSkillByName(parsed.name)
      if (existing) {
        // Check if any field changed
        const contentChanged = existing.content !== parsed.content
        const descChanged = existing.description !== parsed.description
        const confidenceChanged = parsed.confidence !== undefined && existing.confidence !== parsed.confidence
        const usesChanged = parsed.uses !== undefined && existing.uses !== parsed.uses
        const lastUsedChanged = parsed.last_used !== undefined && existing.last_used !== parsed.last_used
        const tagsChanged = parsed.tags !== undefined && JSON.stringify(existing.tags) !== JSON.stringify(parsed.tags)

        if (contentChanged || descChanged || confidenceChanged || usesChanged || lastUsedChanged || tagsChanged) {
          this.db.updateSkill(existing.id, {
            description: parsed.description,
            content: parsed.content,
            ...(parsed.confidence !== undefined && { confidence: parsed.confidence }),
            ...(parsed.uses !== undefined && { uses: parsed.uses }),
            ...(parsed.last_used !== undefined && { last_used: parsed.last_used }),
            ...(parsed.tags !== undefined && { tags: parsed.tags })
          })
          result.updated.push(parsed.name)
        } else {
          result.unchanged.push(parsed.name)
        }
      } else {
        this.db.createSkill({
          name: parsed.name,
          description: parsed.description,
          content: parsed.content,
          confidence: parsed.confidence,
          uses: parsed.uses,
          last_used: parsed.last_used,
          tags: parsed.tags
        })
        result.created.push(parsed.name)
      }
    }
    } // end skillsDirs loop

    console.log(`[AgentManager] Skill sync: created=${result.created.length}, updated=${result.updated.length}, unchanged=${result.unchanged.length}`)
    return result
  }

  /**
   * Finds the session for a given taskId and syncs skills from its workspace.
   */
  syncSkillsForTask(taskId: string): { created: string[]; updated: string[]; unchanged: string[] } {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.taskId === taskId) {
        return this.syncSkillsFromWorkspace(sessionId)
      }
    }
    return { created: [], updated: [], unchanged: [] }
  }

  /**
   * Syncs skills from workspace and cleans up session.
   * Does NOT change task status at any point.
   */
  async learnFromSession(sessionId: string, _feedbackMessage: string): Promise<{ created: string[]; updated: string[]; unchanged: string[] }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { created: [], updated: [], unchanged: [] }
    }

    console.log(`[AgentManager] Learning from session ${sessionId}`)

    // Sync skills from workspace
    const result = this.syncSkillsFromWorkspace(sessionId)

    // Clean up session without changing task status
    this.sessions.delete(sessionId)
    console.log(`[AgentManager] Learning complete for session ${sessionId}:`, result)
    return result
  }

  /**
   * Register an external listener that receives all events sent to the renderer.
   * Used by the mobile API server to broadcast via WebSocket.
   */
  addExternalListener(fn: (channel: string, data: unknown) => void): void {
    this.externalListeners.push(fn)
  }

  /**
   * Auto-enable heartbeat for a task if a heartbeat.md file exists in the workspace.
   * Called after a task transitions to ready_for_review.
   */
  private autoEnableHeartbeat(taskId: string): void {
    try {
      const workspaceDir = this.db.getWorkspaceDir(taskId)
      const heartbeatPath = join(workspaceDir, 'heartbeat.md')

      if (existsSync(heartbeatPath)) {
        const content = readFileSync(heartbeatPath, 'utf-8').trim()
        // Skip empty files or files with only headers
        if (content && !/^(#[^\n]*\n?\s*)*$/.test(content)) {
          const defaultInterval = parseInt(this.db.getSetting('heartbeat_default_interval') || '30', 10)
          const now = new Date()
          const nextCheck = new Date(now.getTime() + defaultInterval * 60_000)

          this.db.updateTask(taskId, {
            heartbeat_enabled: true,
            heartbeat_interval_minutes: defaultInterval,
            heartbeat_next_check_at: nextCheck.toISOString()
          })

          console.log(`[AgentManager] Auto-enabled heartbeat for task ${taskId} (found heartbeat.md)`)
        }
      }
    } catch (err) {
      console.error(`[AgentManager] Error auto-enabling heartbeat for task ${taskId}:`, err)
    }
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
    // Also notify external listeners (mobile API WebSocket)
    for (const fn of this.externalListeners) {
      try { fn(channel, data) } catch { /* ignore */ }
    }

    // Show OS notification when agent transitions from working to idle/waiting_approval
    // and the app window is not focused
    if (channel === 'agent:status' && data && typeof data === 'object') {
      const { sessionId, status, taskId } = data as { sessionId?: string; status?: string; taskId?: string }
      if (sessionId && status) {
        const prevStatus = this.lastSentStatus.get(sessionId)
        this.lastSentStatus.set(sessionId, status)

        // Check ALL conditions BEFORE doing any DB/notification work.
        // Previously the sync db.getTask() call ran inside the notification
        // block but BEFORE checking if the window was inactive, blocking the
        // event loop on every status transition even when no notification was
        // needed.
        const isWindowInactive = !this.mainWindow || this.mainWindow.isDestroyed() || !this.mainWindow.isFocused()
        const isNotifiableTransition = prevStatus === SessionStatus.WORKING && (status === SessionStatus.IDLE || status === SessionStatus.WAITING_APPROVAL)

        if (isNotifiableTransition && isWindowInactive) {
          try {
            if (Notification.isSupported()) {
              // Only hit the database when we actually need the title for a notification
              const task = taskId ? this.db.getTask(taskId) : undefined
              const taskTitle = task?.title

              // Skip notifications for subtasks whose parent task is already completed
              if (task?.parent_task_id) {
                const parentTask = this.db.getTask(task.parent_task_id)
                if (parentTask?.status === TaskStatus.Completed) {
                  return
                }
              }

              let title: string
              let body: string
              if (status === SessionStatus.WAITING_APPROVAL) {
                title = 'Agent needs approval'
                body = taskTitle ? `"${taskTitle}" is waiting for your approval` : 'An agent is waiting for your approval'
              } else {
                title = 'Agent finished'
                body = taskTitle ? `"${taskTitle}" is ready for review` : 'A task is ready for review'
              }

              const notification = new Notification({ title, body })
              notification.on('click', () => {
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                  this.mainWindow.show()
                  this.mainWindow.focus()
                }
              })
              notification.show()
            }
          } catch (err) {
            console.error('[AgentManager] Failed to show OS notification:', err)
          }
        }
      }
    }
  }
}
