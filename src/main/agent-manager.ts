import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { homedir } from 'os'
import { join, delimiter } from 'path'
import { existsSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { Agent as UndiciAgent } from 'undici'
import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import type { DatabaseManager, AgentMcpServerEntry, OutputFieldRecord, SecretRecord, SkillRecord, TaskRecord } from './database'
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

let OpenCodeSDK: typeof import('@opencode-ai/sdk') | null = null

// Coding agent backend type enum
enum CodingAgentType {
  OPENCODE = 'opencode',
  CLAUDE_CODE = 'claude-code',
  CODEX = 'codex'
}

// Custom fetch with no timeout — agent prompts can run indefinitely
const noTimeoutAgent = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 })
const noTimeoutFetch = (req: Request): ReturnType<typeof fetch> =>
  (globalThis.fetch as (input: Request, init: Record<string, unknown>) => ReturnType<typeof fetch>)(req, { dispatcher: noTimeoutAgent })

// Default OpenCode server URL (matches database default)
const DEFAULT_SERVER_URL = 'http://localhost:4096'

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
  adapter?: CodingAgentAdapter
  secretSessionToken?: string
  pollingStarted?: boolean
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
}

export class AgentManager extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map()
  /** Maps old (temp) session IDs to their re-keyed (real) IDs so that
   *  stale IDs from the renderer still resolve after pollSingleSession re-keys. */
  private sessionIdRedirects: Map<string, string> = new Map()
  private serverInstance: { close(): void } | null = null  // OpenCode SDK server instance
  private serverUrl: string | null = null
  private serverStarting: Promise<void> | null = null  // Track server startup
  private sdkLoading: Promise<void> | null = null  // Track SDK loading
  private db: DatabaseManager
  private mainWindow: BrowserWindow | null = null
  private adapters: Map<string, CodingAgentAdapter> = new Map()  // Adapter instances
  private worktreeManager: WorktreeManager | null = null
  private githubManager: GitHubManager | null = null
  private gitlabManager: GitLabManager | null = null
  private oauthManager: import('./oauth/oauth-manager').OAuthManager | null = null
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
   * Set the sync manager for executing enterprise actions (e.g. completing tasks on Workflo).
   * Called after both AgentManager and SyncManager are created.
   */
  setSyncManager(syncManager: import('./sync-manager').SyncManager): void {
    this.syncManager = syncManager
  }

  private async loadSDK(): Promise<void> {
    try {
      OpenCodeSDK = await import('@opencode-ai/sdk')
      console.log('[AgentManager] OpenCode SDK loaded successfully')
    } catch (error) {
      console.error('[AgentManager] Failed to load OpenCode SDK:', error)
    } finally {
      this.sdkLoading = null
    }
  }

  /**
   * Ensures the SDK is loaded before proceeding with any operations.
   * Lazily triggers loading on first call.
   */
  private async ensureSDKLoaded(): Promise<void> {
    if (OpenCodeSDK) return
    if (!this.sdkLoading) {
      this.sdkLoading = this.loadSDK()
    }
    await this.sdkLoading
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
   * Skips for mastermind sessions, triage sessions, tasks without repos,
   * or when github_org is not configured.
   */
  private async setupWorktreeIfNeeded(taskId: string): Promise<string | undefined> {
    if (taskId === 'mastermind-session' || taskId.startsWith('heartbeat-')) return undefined

    if (!this.worktreeManager) return undefined

    const gitProvider = this.db.getSetting('git_provider') || 'github'
    const githubOrg = this.db.getSetting('github_org')
    if (!githubOrg) return undefined

    const task = this.db.getTask(taskId)
    if (!task) return undefined
    if (task.status === TaskStatus.Triaging) return undefined
    if (!task.repos || task.repos.length === 0) return undefined

    try {
      console.log(`[AgentManager] setupWorktreeIfNeeded: provider=${gitProvider}, org=${githubOrg}, taskRepos=${task.repos.join(', ')}`)

      let orgRepos: Array<{ fullName: string; defaultBranch: string }>

      if (gitProvider === 'gitlab' && this.gitlabManager) {
        orgRepos = await this.gitlabManager.fetchOrgRepos(githubOrg)
      } else if (this.githubManager) {
        orgRepos = await this.githubManager.fetchOrgRepos(githubOrg)
      } else {
        console.warn(`[AgentManager] No ${gitProvider} manager available, skipping worktree setup`)
        return undefined
      }

      console.log(`[AgentManager] Fetched ${orgRepos.length} org repos, matching against task repos: ${task.repos.join(', ')}`)

      const matched = task.repos
        .map((name) => orgRepos.find((r) => r.fullName === name))
        .filter(Boolean) as Array<{ fullName: string; defaultBranch: string }>

      if (matched.length === 0) {
        console.warn(`[AgentManager] No matching repos found. Task repos: [${task.repos.join(', ')}], Org repos: [${orgRepos.map(r => r.fullName).slice(0, 10).join(', ')}${orgRepos.length > 10 ? '...' : ''}]`)
        return undefined
      }

      console.log(`[AgentManager] Matched ${matched.length} repos: ${matched.map(r => r.fullName).join(', ')}`)

      const workspaceDir = await this.worktreeManager.setupWorkspaceForTask(
        taskId,
        matched.map((r) => ({ fullName: r.fullName, defaultBranch: r.defaultBranch })),
        githubOrg,
        gitProvider
      )
      return workspaceDir
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
        adapter = new OpencodeAdapter()
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

        result[mcpServer.name] = {
          type: 'http',
          url: mcpServer.url,
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

    // result keys logged at debug level only
    return result
  }

  private async buildSessionConfig(agentId: string, taskId: string, workspaceDir?: string): Promise<SessionConfig> {
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const isMastermind = taskId === 'mastermind-session'
    const task = this.db.getTask(taskId)
    const isTriageSession = task?.status === TaskStatus.Triaging
    const isSubtask = !!task?.parent_task_id
    const taskScope = isSubtask && task?.parent_task_id ? { taskId, parentTaskId: task.parent_task_id } : undefined
    const mcpServers = await this.buildMcpServersForAdapter(agentId, { ensureTaskManagement: isMastermind || isTriageSession || isSubtask, taskScope })

    const config: SessionConfig = {
      agentId,
      taskId,
      workspaceDir: workspaceDir || this.db.getWorkspaceDir(taskId),
      model: agent.config?.model,
      systemPrompt: agent.config?.system_prompt,
      mcpServers,
      authMethod: agent.config?.auth_method,
      permissionMode: agent.config?.permission_mode,
      apiKeys: agent.config?.api_keys
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

  /**
   * Returns the memory file name for an agent based on its type.
   * Claude Code agents use CLAUDE.md; all other agents use AGENTS.md.
   */
  private getMemoryFileName(agentId: string): string {
    const agent = this.db.getAgent(agentId)
    const backendType = (agent?.config?.coding_agent as string) || CodingAgentType.OPENCODE
    return backendType === CodingAgentType.CLAUDE_CODE ? 'CLAUDE.md' : 'AGENTS.md'
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
          const desc = skill.description || skill.name
          const content = `---\nname: ${skill.name}\ndescription: ${desc}\n---\n\n${skill.content}`
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

  /**
   * Ensures API keys are loaded from settings into process.env
   */
  private loadApiKeysToEnv(): void {
    const providers = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY']
    const envVars: Record<string, string> = {}

    for (const key of providers) {
      const value = this.db.getSetting(key)
      if (value) {
        if (!process.env[key]) {
          envVars[key] = value
          process.env[key] = value
        } else {
          console.log(`[AgentManager] ${key} already set in environment, skipping`)
        }
      }
    }

    if (Object.keys(envVars).length > 0) {
      console.log(`[AgentManager] Loaded ${Object.keys(envVars).length} API key(s) from settings:`, Object.keys(envVars))
    } else {
      console.log('[AgentManager] No new API keys loaded (may already be in environment)')
    }
  }

  /**
   * Spawns the opencode server process with platform-aware settings.
   * On Windows, uses shell: true so .cmd wrappers are resolved.
   */
  private spawnOpencodeServer(hostname: string, port: number, isWin: boolean): Promise<{ close: () => void }> {
    const args = ['serve', `--hostname=${hostname}`, `--port=${port}`]
    const cmd = isWin ? 'opencode.cmd' : 'opencode'
    const timeout = 10000

    console.log(`[AgentManager] Spawning: ${cmd} ${args.join(' ')} (shell=${isWin})`)

    // Read OpenCode auth.json to inject API keys as env vars
    // OpenCode stores credentials in auth.json but expects env vars at runtime
    const serverEnv: Record<string, string> = { ...process.env } as Record<string, string>
    try {
      const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
      if (existsSync(authPath)) {
        const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
        if (auth.google?.key && !serverEnv.GOOGLE_GENERATIVE_AI_API_KEY) {
          serverEnv.GOOGLE_GENERATIVE_AI_API_KEY = auth.google.key
          console.log('[AgentManager] Injected GOOGLE_GENERATIVE_AI_API_KEY from OpenCode auth.json')
        }
        if (auth.openai?.key && !serverEnv.OPENAI_API_KEY) {
          serverEnv.OPENAI_API_KEY = auth.openai.key
          console.log('[AgentManager] Injected OPENAI_API_KEY from OpenCode auth.json')
        }
      }
    } catch (e) {
      console.log('[AgentManager] Could not read OpenCode auth.json:', e)
    }

    const proc = spawn(cmd, args, {
      shell: isWin,
      windowsHide: true,
      env: serverEnv
    })

    return new Promise((resolve, reject) => {
      const id = setTimeout(() => {
        reject(new Error(`Timeout waiting for opencode server after ${timeout}ms`))
      }, timeout)

      let output = ''

      proc.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const lines = output.split('\n')
        for (const line of lines) {
          if (line.startsWith('opencode server listening')) {
            clearTimeout(id)
            console.log(`[AgentManager] OpenCode server started: ${line.trim()}`)
            resolve({ close: () => proc.kill() })
            return
          }
        }
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })

      proc.on('exit', (code) => {
        clearTimeout(id)
        let msg = `opencode server exited with code ${code}`
        if (output.trim()) msg += `\nOutput: ${output.slice(0, 500)}`
        reject(new Error(msg))
      })

      proc.on('error', (error) => {
        clearTimeout(id)
        reject(error)
      })
    })
  }

  /**
   * Ensures common binary install paths (e.g. ~/.opencode/bin) are in PATH
   * so the OpenCode SDK can find the `opencode` binary via spawn().
   */
  private ensureBinaryPaths(): void {
    const currentPath = process.env.PATH || ''
    const customPath = this.db.getSetting('OPENCODE_BINARY_PATH')
    const extraPaths = [
      ...(customPath ? [customPath] : []),
      join(homedir(), '.opencode', 'bin'),
      ...(process.platform === 'win32'
        ? [join(homedir(), 'AppData', 'Roaming', 'npm')]
        : ['/usr/local/bin']),
      join(homedir(), '.local', 'bin')
    ].filter(p => !currentPath.includes(p))

    if (extraPaths.length > 0) {
      process.env.PATH = [...extraPaths, currentPath].join(delimiter)
      console.log('[AgentManager] Added binary paths to PATH:', extraPaths)
    }
  }

  /**
   * Checks if a server is accessible at the given URL
   * Tries both the given URL and its localhost/127.0.0.1 variant
   * Returns the working URL if found, null otherwise
   */
  private async findAccessibleServer(url: string): Promise<string | null> {
    const urls = [url]

    // Add localhost variant if URL uses 127.0.0.1 (and vice versa)
    // This handles macOS DNS resolution issues when launched from UI
    if (url.includes('localhost')) {
      urls.push(url.replace('localhost', '127.0.0.1'))
    } else if (url.includes('127.0.0.1')) {
      urls.push(url.replace('127.0.0.1', 'localhost'))
    }

    for (const testUrl of urls) {
      try {
        console.log('[AgentManager] Checking server at', testUrl)
        // Use the correct OpenCode health endpoint: /global/health
        const response = await fetch(`${testUrl}/global/health`, {
          signal: AbortSignal.timeout(2000)
        })
        if (response.ok) {
          const health = await response.json()
          console.log('[AgentManager] Server accessible at', testUrl, 'version:', health.version)
          return testUrl
        }
      } catch (error: unknown) {
        console.log('[AgentManager] Server not accessible at', testUrl, ':', error instanceof Error ? error.message : error)
      }
    }

    return null
  }

  /**
   * Starts or detects an OpenCode server.
   * Only creates embedded server if targetUrl is the default and no server is running.
   * For custom URLs, just validates they're accessible.
   */
  async startServer(targetUrl: string = DEFAULT_SERVER_URL): Promise<void> {
    // Always load API keys first (for both embedded and external servers)
    this.loadApiKeysToEnv()

    // Ensure common binary install paths are in PATH so the SDK can find `opencode`
    this.ensureBinaryPaths()

    // If we already have a server running, check if it matches the target
    if (this.serverUrl) {
      if (this.serverUrl === targetUrl) {
        console.log('[AgentManager] Server already available at', this.serverUrl)
        return
      }
      // Different URL requested, will need to start/detect a different server
      console.log('[AgentManager] Different server URL requested:', targetUrl)
    }

    // If server is starting, wait for it
    if (this.serverStarting) {
      console.log('[AgentManager] Server startup in progress, waiting...')
      return this.serverStarting
    }

    // Ensure SDK is loaded
    await this.ensureSDKLoaded()
    if (!OpenCodeSDK) {
      throw new Error('OpenCode SDK not loaded')
    }

    const isDefaultUrl = targetUrl === DEFAULT_SERVER_URL ||
                         targetUrl === 'http://127.0.0.1:4096' // Also accept 127.0.0.1 variant

    // Create startup promise to prevent race conditions
    this.serverStarting = (async () => {
      try {
        console.log('[AgentManager] Checking for server at', targetUrl)

        // Check if server is already accessible (tries localhost and 127.0.0.1 variants)
        const accessibleUrl = await this.findAccessibleServer(targetUrl)
        if (accessibleUrl) {
          console.log('[AgentManager] Found existing server at', accessibleUrl)
          this.serverUrl = accessibleUrl
          this.serverInstance = null // External server
          return
        }

        // Server not accessible
        if (!isDefaultUrl) {
          // Custom URL but not accessible - fail
          throw new Error(`OpenCode server not accessible at ${targetUrl}`)
        }

        // Default URL and not accessible - create embedded server
        console.log('[AgentManager] Creating embedded OpenCode server...')

        // Parse hostname and port from URL
        const url = new URL(targetUrl)
        const hostname = url.hostname
        const port = parseInt(url.port || '4096', 10)

        // On Windows, the SDK's createOpencodeServer uses spawn('opencode', ...)
        // which can't find .cmd wrappers. Use a platform-aware spawn instead.
        const isWin = process.platform === 'win32'
        const serverResult = await this.spawnOpencodeServer(hostname, port, isWin)

        this.serverInstance = serverResult
        this.serverUrl = targetUrl

        console.log(`[AgentManager] Embedded server created at ${this.serverUrl}`)
      } catch (error) {
        console.error('[AgentManager] Failed to start server:', error)
        this.serverInstance = null
        this.serverUrl = null
        this.serverStarting = null
        throw error
      } finally {
        this.serverStarting = null
      }
    })()

    return this.serverStarting
  }

  async stopServer(): Promise<void> {
    if (this.serverInstance) {
      // Only stop if we created the server (embedded server)
      console.log('[AgentManager] Stopping embedded OpenCode server...')
      try {
        await this.serverInstance.close()
        console.log('[AgentManager] Embedded OpenCode server stopped')
      } catch (error) {
        console.error('[AgentManager] Error stopping server:', error)
      }
      this.serverInstance = null
      this.serverUrl = null
    } else if (this.serverUrl) {
      // We're using an external server, just clear the URL
      console.log('[AgentManager] Disconnecting from external OpenCode server')
      this.serverUrl = null
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
    const isTriageSession = task?.status === TaskStatus.Triaging
    const isSubtask = !!task?.parent_task_id
    const taskScope = isSubtask && task?.parent_task_id ? { taskId, parentTaskId: task.parent_task_id } : undefined
    await yieldEL()

    // Build MCP servers config for adapter
    // Mastermind, triage, and subtask sessions always get task-management access
    const isMastermind = taskId === 'mastermind-session'
    const mcpServers = await this.buildMcpServersForAdapter(agentId, { ensureTaskManagement: isMastermind || isTriageSession || isSubtask, taskScope })

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
      apiKeys: agent.config?.api_keys
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
        }

        // Append output field instructions
        if (currentTask?.output_fields && currentTask.output_fields.length > 0) {
          promptText += this.buildOutputFieldInstructions(currentTask.output_fields)
        }

        // Copy attachments and build references
        const attachmentRefs: string[] = []
        if (currentTask?.attachments?.length && workspaceDir) {
          const attachDir = this.db.getAttachmentsDir(taskId)
          const destDir = join(workspaceDir, 'attachments')
          if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

          for (const att of currentTask.attachments) {
            const srcPath = join(attachDir, `${att.id}-${att.filename}`)
            if (!existsSync(srcPath)) continue
            const destPath = join(destDir, att.filename)
            try {
              copyFileSync(srcPath, destPath)
              attachmentRefs.push(`- attachments/${att.filename}`)
            } catch {
              continue
            }
          }
        }
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
      hasSeenWork: existingSession ? true : false,
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

      // Run a poll cycle immediately
      if (this.pollTickFn) {
        this.pollTickFn()
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

      // Check if the real session ID has been provided by the adapter
      const realSessionId = newParts.find(p => p.realSessionId)?.realSessionId
      if (realSessionId && realSessionId !== sessionId) {
        console.log(`[AgentManager] Session ID updated: ${sessionId} -> ${realSessionId}`)

        // Update database with real session ID
        this.db.updateTask(config.taskId, { session_id: realSessionId })

        // Re-key the sessions map
        const session = this.sessions.get(sessionId)
        if (session) {
          this.sessions.delete(sessionId)
          this.sessions.set(realSessionId, session)

          // Record redirect so stale IDs from the renderer still resolve
          this.sessionIdRedirects.set(sessionId, realSessionId)

          // Re-key the polling entry
          this.pollingEntries.delete(sessionId)
          entry.sessionId = realSessionId
          this.pollingEntries.set(realSessionId, entry)

          sessionId = realSessionId
        }
      }

      // Mark that the session has done real work once we receive any messages.
      // This disables the IDLE grace period so future IDLE means truly done.
      if (newParts.length > 0 && !entry.hasSeenWork) {
        entry.hasSeenWork = true
      }

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

      // Check for pending approval (ACP adapters only) — include in same batch
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
        }
        if (assistantTexts.length > 0) {
          currentSession.lastAssistantText = assistantTexts.join('\n')
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
          // Still within grace period and haven't seen any work yet — keep polling
          return
        }

        console.log(`[AgentManager] Detected IDLE status for ${sessionId}, calling transitionToIdle`)
        // Sync dedup state from polling entry back to the session so that
        // if polling restarts (follow-up message), we preserve what was already seen.
        if (pollingEntry) {
          for (const id of pollingEntry.seenMessageIds) session.seenMessageIds.add(id)
          for (const id of pollingEntry.seenPartIds) session.seenPartIds.add(id)
          for (const [k, v] of pollingEntry.partContentLengths) session.partContentLengths.set(k, v)
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

    // Build MCP servers config
    const isMastermind = taskId === 'mastermind-session'
    const task = this.db.getTask(taskId)
    const isTriageSession = task?.status === TaskStatus.Triaging
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
      apiKeys: agent.config?.api_keys
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

    // Replay messages to renderer in a single batch to avoid UI freeze
    if (shouldReplayToRenderer) {
      const batchMessages: Array<{ id: string; role: string; content: string; partType?: string; tool?: unknown; taskProgress?: unknown }> = []
      for (const message of messages) {
        for (const part of message.parts) {
          batchMessages.push({
            id: part.id || `${message.role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: message.role,
            content: part.content || part.text || '',
            partType: part.type,
            tool: part.tool,
            taskProgress: part.taskProgress
          })
        }
      }
      if (batchMessages.length > 0) {
        this.sendToRenderer('agent:output-batch', {
          sessionId: adapterSessionId,
          taskId,
          messages: batchMessages
        })
      }
    }

    // Build dedup state from replayed messages so that when polling starts
    // (on follow-up message), it won't re-send messages already shown in the UI.
    const resumedSeenMessageIds = new Set<string>()
    const resumedSeenPartIds = new Set<string>()
    const resumedPartContentLengths = new Map<string, string>()
    for (const message of messages) {
      for (const part of message.parts) {
        const partId = part.id || `${message.role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        resumedSeenPartIds.add(partId)
        if (part.content || part.text) {
          resumedPartContentLengths.set(partId, String((part.content || part.text || '').length))
        }
      }
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
  cleanupHeartbeatSession(taskId: string): void {
    const heartbeatTaskId = `heartbeat-${taskId}`
    for (const [id, session] of this.sessions.entries()) {
      if (session.taskId === heartbeatTaskId) {
        this.sessions.delete(id)
        console.log(`[AgentManager] Cleaned up heartbeat session ${id} for task ${taskId}`)
        break
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
      return
    }

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
        console.log(`[AgentManager] Session ${sessionId} re-keyed, redirecting abort to ${redirectedId}`)
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

    this.sessions.delete(sessionId)

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

  async sendMessage(sessionId: string, message: string, taskId?: string, agentId?: string): Promise<{ newSessionId?: string }> {
    let session = this.sessions.get(sessionId)

    // Check redirect map: session ID may have been re-keyed (temp → real)
    if (!session) {
      const redirectedId = this.sessionIdRedirects.get(sessionId)
      if (redirectedId) {
        console.log(`[AgentManager] Session ${sessionId} re-keyed, redirecting sendMessage to ${redirectedId}`)
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
        }

        // Send the user's message (fire-and-forget to avoid blocking IPC response)
        this.doSendAdapterMessage(session, sessionId, message).catch((err) => {
          console.error(`[AgentManager] doSendAdapterMessage failed for session ${sessionId}:`, err)
          this.handleSessionError(sessionId, session!, err)
        })
        return { newSessionId: sessionId }
      }
    }

    if (!session) throw new Error(`Session not found: ${sessionId}`)

    // Fire-and-forget to avoid blocking IPC response and freezing the renderer
    this.doSendAdapterMessage(session, sessionId, message).catch((err) => {
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

  private async doSendAdapterMessage(session: AgentSession, sessionId: string, message: string): Promise<void> {
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

    // Show user's message in UI
    this.sendToRenderer('agent:output', {
      sessionId,
      taskId: session.taskId,
      type: 'message',
      data: {
        id: `user-message-${Date.now()}`,
        role: 'user',
        content: message,
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
    const parts: MessagePart[] = [
      { type: MessagePartType.TEXT, text: message }
    ]
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
      await (adapter as unknown as AcpAdapter).respondToApproval(sessionId, approved, selectedOption)
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
    const batchMessages: Array<{ id: string; role: string; content: string; partType?: string; tool?: unknown; update?: boolean; taskProgress?: unknown }> = []
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


  async getProviders(serverUrl?: string, directory?: string): Promise<{ providers: { id: string; name: string; [key: string]: unknown }[]; default: Record<string, string> } | null> {
    await this.ensureSDKLoaded()
    if (!OpenCodeSDK) return null

    try {
      // Determine which server URL to use
      let baseUrl = serverUrl
      if (!baseUrl) {
        // Try to get from existing server or agent config
        if (this.serverUrl) {
          baseUrl = this.serverUrl
        } else {
          const agents = this.db.getAgents()
          const defaultAgent = agents.find((a) => a.is_default) || agents[0]
          baseUrl = defaultAgent?.server_url || DEFAULT_SERVER_URL
        }
      }

      // Try to detect/start server - if it fails, return null gracefully
      try {
        if (!this.serverUrl || this.serverUrl !== baseUrl) {
          console.log('[AgentManager] Checking for OpenCode server to fetch providers...')
          await this.startServer(baseUrl)
        }
      } catch (serverError: unknown) {
        console.log('[AgentManager] No OpenCode server available:', serverError instanceof Error ? serverError.message : serverError)
        return null // No server, no providers - this is OK during onboarding
      }

      // Default to home directory so project-scoped OpenCode configs are picked up
      const dir = directory || homedir()

      const ocClient = OpenCodeSDK.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch })
      const result = await ocClient.config.providers({
        query: { directory: dir }
      })

      if (result.error) {
        console.log('[AgentManager] No providers configured on server')
        return null
      }

      const data = result.data as { providers?: { id: string; name: string; [key: string]: unknown }[]; default?: Record<string, string> } | undefined
      console.log('[AgentManager] Found providers:', data?.providers?.map((p) => p.id))
      return data ? { providers: data.providers || [], default: data.default || {} } : null
    } catch (error: unknown) {
      console.log('[AgentManager] Could not get providers:', error instanceof Error ? error.message : error)
      return null // Gracefully return null - no providers available
    }
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
        console.log(`[AgentManager] Retrieved ${messages.length} messages from adapter`)
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
      console.log(`[AgentManager] Found ${assistantMessages.length} assistant messages`)

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
        console.log(`[AgentManager] Processing message ${i}, parts count:`, msg.parts?.length)
        if (!msg.parts) continue

        // Debug: log part types and small text samples
        msg.parts.forEach((p, idx) => {
          console.log(`[AgentManager]   Part ${idx}: type=${p.type}, hasText=${!!p.text}, textLength=${p.text?.length || 0}`)
          // Log small text parts in full, large ones as preview
          if (p.text) {
            if (p.text.length < 300) {
              console.log(`[AgentManager]   Part ${idx} full text:`, p.text)
            } else {
              console.log(`[AgentManager]   Part ${idx} text preview (first 300 chars):`, p.text.slice(0, 300) + '...')
            }
          }
        })

        const fullText = msg.parts
          .filter((p) => p.type === 'text' && p.text)
          .map((p) => p.text)
          .join('\n')

        console.log(`[AgentManager] Full text length: ${fullText.length}`)
        if (fullText.length > 0) {
          console.log(`[AgentManager] Full text preview (first 500 chars):`, fullText.slice(0, 500))
        }
        if (!fullText) continue

        const jsonMatch = fullText.match(/```json\s*\n?([\s\S]*?)\n?\s*```/)
          || fullText.match(/```\s*\n?([\s\S]*?)\n?\s*```/)

        if (jsonMatch) {
          console.log(`[AgentManager] Found JSON block in message ${i}`)
          const raw = jsonMatch[1].trim()
          console.log(`[AgentManager] Raw JSON content (first 300 chars):`, raw.slice(0, 300))
          try {
            parsedValues = JSON.parse(raw)
            console.log(`[AgentManager] Successfully parsed output values:`, parsedValues)
            break
          } catch (err) {
            console.log(`[AgentManager] JSON parse failed:`, err)
            // JSON truncated — extract complete key-value pairs via regex
            parsedValues = this.extractPartialJson(raw)
            if (Object.keys(parsedValues).length > 0) {
              console.log(`[AgentManager] Extracted partial output values:`, parsedValues)
              break
            } else {
              console.log(`[AgentManager] Partial extraction also returned empty`)
            }
          }
        } else {
          console.log(`[AgentManager] No JSON block found in message ${i}`)
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

    const name = nameMatch[1].trim()
    const description = descMatch ? descMatch[1].trim() : ''

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
