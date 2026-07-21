/**
 * Codex App Server adapter.
 *
 * Experimental replacement path for Codex ACP. This talks to `codex app-server`
 * over JSON-RPC stdio and maps the app-server thread/turn/item protocol onto
 * 20x's CodingAgentAdapter contract.
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import { promisify } from 'util'
import type {
  CodingAgentAdapter,
  SessionConfig,
  SessionStatus,
  SessionMessage,
  MessagePart,
  McpServerConfig
} from './coding-agent-adapter'
import { MessagePartType, MessageRole, SessionStatusType } from './coding-agent-adapter'

const DEFAULT_CODEX_APP_SERVER_MODEL = 'gpt-5.5'
const MAX_IPC_TOOL_INPUT_CHARS = 20_000
const MAX_IPC_TOOL_OUTPUT_CHARS = 100_000

type CodexSandboxPolicy =
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; networkAccess: boolean; writableRoots: string[] }
  | { type: 'dangerFullAccess' }

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

interface PendingApproval {
  requestId: string | number
  toolCallId: string
  question: string
  options: Array<{
    optionId: string
    name: string
    kind: string
  }>
  responseKind: 'execCommand' | 'commandExecution' | 'fileChange' | 'permissions' | 'elicitation' | 'userInput' | 'generic'
}

interface AppServerSession {
  sessionId: string
  threadId: string | null
  activeTurnId: string | null
  process: ChildProcess
  stdoutBuffer: string
  status: SessionStatusType
  messageBuffer: unknown[]
  permanentMessages: unknown[]
  bufferedThreadItemIds: Set<string>
  pendingCompletionRefreshes: number
  sawThreadStatusNotification: boolean
  pendingThreadIdle: boolean
  pendingRequests: Map<string | number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>
  pendingApproval: PendingApproval | null
  nextRequestId: number
  lastError: string | null
  config: SessionConfig
  streamedTextByItemId: Map<string, string>
  assistantTextKeysByTurn: Map<string, Set<string>>
  runningTools: Map<string, {
    partId: string
    toolName: string
    startTime?: number
    input?: Record<string, unknown>
  }>
  codexUseApiKey: boolean
  codexAuthSummary: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function extractThreadId(value: unknown): string | null {
  if (!isObject(value)) return null
  const direct = asString(value.threadId) || asString(value.thread_id) || asString(value.id)
  if (direct) return direct
  if (isObject(value.thread)) {
    return asString(value.thread.id) || asString(value.thread.threadId) || asString(value.thread.thread_id) || null
  }
  return null
}

/**
 * Deterministic 32-bit string hash (djb2). Used to build stable dedup keys for
 * thread items that carry no id — never use Date.now()/random here, or the same
 * item would produce a new key on every reconcile pass and be re-emitted.
 */
function hashString(value: string): string {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * Derives a STABLE identity for a Codex thread item. Many item types
 * (function_call_output, custom_tool_call_output, tool_search_output, and
 * user/developer input messages) have no top-level `id` — only a `call_id`, or
 * nothing at all. This must return the same value across reconcile passes for the
 * same logical item, otherwise the transcript repeats older messages after every
 * idle. Returns null when no id-like field exists (caller falls back to a
 * content-based key).
 */
function deriveItemIdentity(item: Record<string, unknown> | undefined): string | null {
  if (!item) return null
  const direct = asString(item.id) || asString(item.itemId) || asString(item.item_id)
  if (direct) return direct
  const callId = asString(item.call_id) || asString(item.callId)
  if (callId) {
    const type = asString(item.type) || 'item'
    return `${type}:${callId}`
  }
  return null
}

function extractItemId(params: Record<string, unknown>): string {
  const item = isObject(params.item) ? params.item : undefined
  const identity = asString(params.itemId) || deriveItemIdentity(item)
  if (identity) return identity
  // Last resort: a deterministic key derived from the item's content so the same
  // item maps to the same part id across reconciles (was `item-${Date.now()}`,
  // which minted a new id every pass and duplicated the message on each idle).
  const fingerprint = item ? `${asString(item.type) || 'item'}:${extractText(item)}` : 'item'
  return `item-${hashString(fingerprint)}`
}

function extractText(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n')
  if (!isObject(value)) return ''

  for (const key of ['text', 'content', 'delta', 'message', 'output']) {
    const text = extractText(value[key])
    if (text) return text
  }

  return ''
}

function extractRole(item: Record<string, unknown>): string {
  return (asString(item.role) || asString(item.author) || asString(item.sender) || '').toLowerCase()
}

function extractToolName(item: Record<string, unknown>): string {
  const server = asString(item.server)
  const tool = asString(item.tool)
  if ((item.type === 'mcpToolCall' || server || tool) && (server || tool)) {
    return [server, tool].filter(Boolean).join('.')
  }

  return (
    asString(item.toolName) ||
    asString(item.tool_name) ||
    asString(item.name) ||
    asString(item.type) ||
    'tool'
  )
}

function extractToolTitle(item: Record<string, unknown>, toolName: string): string {
  if (item.type === 'commandExecution') {
    const actionCommand = Array.isArray(item.commandActions)
      ? item.commandActions
        .filter(isObject)
        .map((action) => asString(action.command))
        .find(Boolean)
      : undefined
    const command = actionCommand || asString(item.command)
    if (command) return command
  }

  if (item.type === 'fileChange') {
    const paths = Array.isArray(item.changes)
      ? item.changes
        .filter(isObject)
        .map((change) => asString(change.path))
        .filter((path): path is string => !!path)
      : []
    const directPath = asString(item.path)
    if (paths.length === 1) return basename(paths[0])
    if (paths.length > 1) return `${basename(paths[0])} +${paths.length - 1}`
    if (directPath) return basename(directPath)
  }

  return toolName
}

function truncateForIpc(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n... (truncated for display)`
}

function stringifyForIpc(value: unknown, maxChars: number): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return truncateForIpc(value, maxChars)
  try {
    const seen = new WeakSet<object>()
    return truncateForIpc(JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'bigint') return nested.toString()
      if (typeof nested === 'function' || typeof nested === 'symbol') return undefined
      if (nested && typeof nested === 'object') {
        if (seen.has(nested)) return '[Circular]'
        seen.add(nested)
      }
      return nested
    }, 2), maxChars)
  } catch {
    return truncateForIpc(String(value), maxChars)
  }
}

function normalizeCodexMcpServerName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return normalized || 'mcp_server'
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(Boolean).map((path) => resolve(path))))
}

function isSubpath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function summarizeApproval(params: Record<string, unknown>, fallback: string): string {
  const command = asString(params.command)
  const reason = asString(params.reason)
  const itemId = asString(params.itemId) || asString(params.callId)
  return [command || fallback, reason, itemId ? `id: ${itemId}` : ''].filter(Boolean).join('\n')
}

function normalizeDecisionName(decision: unknown): string {
  if (typeof decision === 'string') return decision
  if (isObject(decision)) {
    return Object.keys(decision)[0] || 'accept'
  }
  return 'accept'
}

function decisionLabel(decision: string): string {
  switch (decision) {
    case 'accept':
    case 'approved':
      return 'Allow'
    case 'acceptForSession':
    case 'approved_for_session':
      return 'Allow for Session'
    case 'decline':
    case 'denied':
      return 'Deny'
    case 'cancel':
    case 'abort':
      return 'Deny and Stop'
    default:
      return decision
  }
}

export class CodexAppServerAdapter implements CodingAgentAdapter {
  private sessions = new Map<string, AppServerSession>()
  private codexExecutablePath: string | null = null

  onDataAvailable?: (sessionId: string) => void

  async initialize(): Promise<void> {
    const health = await this.checkHealth()
    if (!health.available) {
      throw new Error(health.reason || 'Codex app-server not available')
    }
  }

  async createSession(config: SessionConfig): Promise<string> {
    const session = await this.startAppServerProcess(config, config.taskId)
    this.sessions.set(config.taskId, session)

    await this.initializeAppServer(session)

    const result = await this.sendRpcRequest(session, 'thread/start', {
      cwd: config.workspaceDir,
      model: config.model || DEFAULT_CODEX_APP_SERVER_MODEL,
      approvalPolicy: config.permissionMode === 'allow' ? 'never' : 'on-request',
      approvalsReviewer: 'user',
      sandbox: this.resolveSandboxMode(config),
      developerInstructions: config.systemPrompt || null,
      runtimeWorkspaceRoots: this.buildRuntimeWorkspaceRoots(config.workspaceDir),
      config: this.buildConfigOverrides(config)
    })

    const threadId = extractThreadId(result)
    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id')
    }

    session.threadId = threadId
    this.sessions.delete(config.taskId)
    this.sessions.set(threadId, session)
    void this.logMcpServerInventory(session, threadId, 'thread/start')
    return threadId
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    const session = await this.startAppServerProcess(config, sessionId)
    session.threadId = sessionId
    this.sessions.set(sessionId, session)

    await this.initializeAppServer(session)

    await this.sendRpcRequest(session, 'thread/resume', {
      threadId: sessionId,
      cwd: config.workspaceDir,
      model: config.model || DEFAULT_CODEX_APP_SERVER_MODEL,
      approvalPolicy: config.permissionMode === 'allow' ? 'never' : 'on-request',
      approvalsReviewer: 'user',
      sandbox: this.resolveSandboxMode(config),
      runtimeWorkspaceRoots: this.buildRuntimeWorkspaceRoots(config.workspaceDir),
      initialTurnsPage: { limit: 50 },
      config: this.buildConfigOverrides(config)
    })

    void this.logMcpServerInventory(session, sessionId, 'thread/resume')

    try {
      await this.bufferAllThreadItems(session, sessionId)
    } catch (error) {
      console.warn('[CodexAppServerAdapter] Failed to list thread items after resume:', error)
    }

    const messages = await this.getAllMessages(sessionId, config)
    session.messageBuffer = []
    return messages
  }

  async sendPrompt(sessionId: string, parts: MessagePart[], config: SessionConfig): Promise<void> {
    const session = this.requireSession(sessionId)
    if (!session.threadId) {
      throw new Error(`Codex app-server session has no thread id: ${sessionId}`)
    }

    const promptText = parts
      .filter((part) => part.type === MessagePartType.TEXT && part.text)
      .map((part) => part.text)
      .join('\n')

    if (!promptText) {
      throw new Error('No text content in message parts')
    }

    session.messageBuffer = []

    const userItem = {
      method: 'item/completed',
      params: {
        threadId: session.threadId,
        turnId: session.activeTurnId || `local-${Date.now()}`,
        item: {
          id: `user-${Date.now()}`,
          type: 'user_message',
          text: promptText
        }
      }
    }
    this.addEvent(session, userItem)

    session.status = SessionStatusType.BUSY
    session.lastError = null

    const result = await this.sendRpcRequest(session, 'turn/start', {
      threadId: session.threadId,
      input: [{ type: 'text', text: promptText }],
      cwd: config.workspaceDir,
      model: config.model || DEFAULT_CODEX_APP_SERVER_MODEL,
      effort: config.reasoningEffort && config.reasoningEffort !== 'max' ? config.reasoningEffort : null,
      approvalPolicy: config.permissionMode === 'allow' ? 'never' : 'on-request',
      approvalsReviewer: 'user',
      sandbox: this.resolveSandboxMode(config),
      sandboxPolicy: this.buildSandboxPolicy(config),
      runtimeWorkspaceRoots: this.buildRuntimeWorkspaceRoots(config.workspaceDir),
      config: this.buildConfigOverrides(config)
    })

    if (isObject(result)) {
      session.activeTurnId = asString(result.turnId) || asString(result.turn_id) || session.activeTurnId
    }
  }

  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { type: SessionStatusType.ERROR, message: 'Session not found' }
    }
    return {
      type: session.status,
      message: session.status === SessionStatusType.ERROR ? (session.lastError || 'Process error') : undefined
    }
  }

  async pollMessages(
    sessionId: string,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    _config: SessionConfig
  ): Promise<MessagePart[]> {
    const session = this.sessions.get(sessionId)
    if (!session) return []

    const parts = session.messageBuffer.flatMap((event) =>
      this.convertEventToMessageParts(event, seenMessageIds, seenPartIds, partContentLengths, session)
    )
    session.messageBuffer = []
    return parts
  }

  async getAllMessages(sessionId: string, _config: SessionConfig): Promise<SessionMessage[]> {
    const session = this.requireSession(sessionId)
    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const partsByIdAndRole = new Map<string, MessagePart>()

    const assistantTextKeysByTurn = session.assistantTextKeysByTurn
    session.assistantTextKeysByTurn = new Map()
    try {
      for (const event of session.permanentMessages) {
        const parts = this.convertEventToMessageParts(event, seenMessageIds, seenPartIds, partContentLengths, session)
        for (const part of parts) {
          const key = `${part.id || `part-${partsByIdAndRole.size}`}-${part.role || MessageRole.ASSISTANT}`
          if (!partsByIdAndRole.has(key) || part.update) {
            partsByIdAndRole.set(key, part)
          }
        }
      }
    } finally {
      session.assistantTextKeysByTurn = assistantTextKeysByTurn
    }

    const messages: SessionMessage[] = []
    let currentMessage: SessionMessage | null = null
    let previousPart: MessagePart | null = null
    let messageCounter = 0

    for (const part of partsByIdAndRole.values()) {
      const role = part.role === MessageRole.USER
        ? MessageRole.USER
        : part.role === MessageRole.SYSTEM
          ? MessageRole.SYSTEM
          : MessageRole.ASSISTANT
      const startsNewMessage = !currentMessage
        || currentMessage.role !== role
        || !previousPart
        || part.id !== previousPart.id

      if (startsNewMessage) {
        if (currentMessage) messages.push(currentMessage)
        currentMessage = {
          id: `msg-${messageCounter++}`,
          role,
          parts: []
        }
      }

      currentMessage!.parts.push(part)
      previousPart = part
    }

    if (currentMessage) messages.push(currentMessage)
    return messages
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.requireSession(sessionId)
    if (!session.threadId || !session.activeTurnId) return
    await this.sendRpcRequest(session, 'turn/interrupt', {
      threadId: session.threadId,
      turnId: session.activeTurnId
    })
    session.status = SessionStatusType.IDLE
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.process.kill('SIGTERM')
    setTimeout(() => {
      if (!session.process.killed) {
        session.process.kill('SIGKILL')
      }
    }, 1000)
    session.messageBuffer.length = 0
    session.permanentMessages.length = 0
    session.pendingRequests.clear()
    session.streamedTextByItemId.clear()
    session.assistantTextKeysByTurn.clear()
    session.runningTools.clear()
    this.sessions.delete(sessionId)
  }

  async registerMcpServer(
    _serverName: string,
    _mcpConfig: {
      type: 'local' | 'remote'
      command?: string[]
      args?: string[]
      url?: string
      headers?: Record<string, string>
      environment?: Record<string, string>
    },
    _workspaceDir?: string
  ): Promise<void> {
    // App Server reads MCP configuration from Codex config. Per-session MCP
    // injection will be added after the thread config shape is verified in app.
    console.log('[CodexAppServerAdapter] MCP server registration deferred to Codex app-server config')
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      const executable = await this.findCodexExecutable()
      await this.execFileAsync(executable, ['app-server', '--help'], { timeout: 5000 })
      return { available: true }
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }

  getPendingApproval(sessionId: string): PendingApproval | null {
    return this.sessions.get(sessionId)?.pendingApproval || null
  }

  async respondToApproval(sessionId: string, approved: boolean, optionId?: string): Promise<void> {
    const session = this.requireSession(sessionId)
    const approval = session.pendingApproval
    if (!approval) return

    const selected = optionId || approval.options.find((option) =>
      approved
        ? ['acceptForSession', 'accept', 'approved_for_session', 'approved'].includes(option.optionId)
        : ['cancel', 'abort', 'decline', 'denied'].includes(option.optionId)
    )?.optionId || (approved ? 'accept' : 'cancel')
    const response = this.buildApprovalResponse(approval.responseKind, selected, approved)

    this.sendRpcResponse(session, approval.requestId, response)
    session.pendingApproval = null
    if (!approved) {
      session.status = SessionStatusType.IDLE
    }
  }

  async getRunningTools(sessionId: string, _config: SessionConfig): Promise<Array<{
    partId: string
    toolName: string
    startTime?: number
    input?: Record<string, unknown>
  }>> {
    return Array.from(this.sessions.get(sessionId)?.runningTools.values() || [])
  }

  private async startAppServerProcess(config: SessionConfig, sessionId: string): Promise<AppServerSession> {
    const executable = await this.findCodexExecutable()
    const authEnv = this.buildEnvironment(config)
    const env = authEnv.env
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
    const child = spawn(executable, ['app-server', '--stdio'], {
      cwd: config.workspaceDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(needsShell ? { shell: true } : {})
    })

    const session: AppServerSession = {
      sessionId,
      threadId: null,
      activeTurnId: null,
      process: child,
      stdoutBuffer: '',
      status: SessionStatusType.IDLE,
      messageBuffer: [],
      permanentMessages: [],
      bufferedThreadItemIds: new Set(),
      pendingCompletionRefreshes: 0,
      sawThreadStatusNotification: false,
      pendingThreadIdle: false,
      pendingRequests: new Map(),
      pendingApproval: null,
      nextRequestId: 1,
      lastError: null,
      config,
      streamedTextByItemId: new Map(),
      assistantTextKeysByTurn: new Map(),
      runningTools: new Map(),
      codexUseApiKey: authEnv.usesApiKey,
      codexAuthSummary: authEnv.summary
    }

    this.setupStdoutParser(child, session)
    child.stderr?.on('data', (chunk: Buffer) => {
      console.log('[CodexAppServerAdapter] stderr:', chunk.toString())
    })
    child.on('exit', (code, signal) => {
      console.log(`[CodexAppServerAdapter] process exited: code=${code}, signal=${signal}`)
      if (code !== 0 && code !== null) {
        session.status = SessionStatusType.ERROR
        session.lastError = `Codex app-server exited with code ${code}`
      }
    })

    return session
  }

  private async initializeAppServer(session: AppServerSession): Promise<void> {
    await this.sendRpcRequest(session, 'initialize', {
      clientInfo: {
        name: '20x',
        title: '20x',
        version: '0.0.1'
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true
      }
    })
    this.sendRpcNotification(session, 'initialized', {})
  }

  private async findCodexExecutable(): Promise<string> {
    if (this.codexExecutablePath) return this.codexExecutablePath
    const isWin = process.platform === 'win32'
    const finder = isWin ? 'where' : 'which'
    const binary = isWin ? 'codex.cmd' : 'codex'
    const { stdout } = await this.execFileAsync(finder, [binary])
    this.codexExecutablePath = stdout.trim().split(/\r?\n/)[0]
    return this.codexExecutablePath
  }

  private async execFileAsync(
    command: string,
    args: string[],
    options?: { timeout?: number }
  ): Promise<{ stdout: string }> {
    const { execFile } = await import('child_process')
    const execFileAsync = promisify(execFile)
    return await execFileAsync(command, args, options) as { stdout: string }
  }

  private buildEnvironment(config: SessionConfig): {
    env: NodeJS.ProcessEnv
    usesApiKey: boolean
    summary: string
  } {
    const env: NodeJS.ProcessEnv = { ...process.env }

    for (const [key, value] of Object.entries(config.secretEnvVars || {})) {
      env[key] = value
    }

    const explicitApiKey = config.apiKeys?.openai
    const useApiKey =
      config.authMethod === 'api_key' ? true
      : config.authMethod === 'subscription' ? false
      : !!explicitApiKey

    if (useApiKey) {
      const key = explicitApiKey || env.OPENAI_API_KEY || env.CODEX_API_KEY
      if (key) {
        env.OPENAI_API_KEY = key
        env.CODEX_API_KEY = key
      }
      env.NO_BROWSER = '1'
      env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'codex-app-server-session-'))
      return {
        env,
        usesApiKey: true,
        summary: `API key (authMethod=${config.authMethod ?? 'legacy'}, isolated CODEX_HOME)`
      }
    }

    if (!useApiKey) {
      delete env.OPENAI_API_KEY
      delete env.CODEX_API_KEY
      if (!env.CODEX_HOME) {
        env.CODEX_HOME = join(homedir(), '.codex')
      }
    }

    return {
      env,
      usesApiKey: false,
      summary: `subscription (authMethod=${config.authMethod ?? 'legacy'}, CODEX_HOME=${env.CODEX_HOME ?? 'default'})`
    }
  }

  private buildConfigOverrides(config: SessionConfig): Record<string, unknown> {
    const overrides: Record<string, unknown> = {}
    if (config.reasoningEffort && config.reasoningEffort !== 'max') {
      overrides.model_reasoning_effort = config.reasoningEffort
    }
    if (this.resolveSandboxMode(config) === 'workspace-write') {
      overrides.sandbox_workspace_write = {
        network_access: true,
        writable_roots: this.buildRuntimeWorkspaceRoots(config.workspaceDir)
      }
    }
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      overrides.mcp_servers = this.convertMcpServers(config.mcpServers)
    }
    return overrides
  }

  private buildRuntimeWorkspaceRoots(workspaceDir: string): string[] {
    return uniquePaths([workspaceDir, ...this.resolveExternalGitRoots(workspaceDir)])
  }

  private resolveExternalGitRoots(workspaceDir: string): string[] {
    const workspaceRoot = resolve(workspaceDir)
    const dotGitPath = join(workspaceRoot, '.git')
    if (!existsSync(dotGitPath)) return []

    try {
      const dotGitContent = readFileSync(dotGitPath, 'utf8').trim()
      if (!dotGitContent.startsWith('gitdir:')) return []

      const rawGitDir = dotGitContent.slice('gitdir:'.length).trim()
      if (!rawGitDir) return []

      const gitDir = isAbsolute(rawGitDir)
        ? resolve(rawGitDir)
        : resolve(workspaceRoot, rawGitDir)
      const commonDirPath = join(gitDir, 'commondir')
      const rawCommonDir = existsSync(commonDirPath)
        ? readFileSync(commonDirPath, 'utf8').trim()
        : ''
      const commonDir = rawCommonDir
        ? (isAbsolute(rawCommonDir) ? resolve(rawCommonDir) : resolve(gitDir, rawCommonDir))
        : gitDir

      return [commonDir, gitDir].filter((path) => !isSubpath(workspaceRoot, path))
    } catch (error) {
      console.warn('[CodexAppServerAdapter] Failed to resolve external git metadata roots:', error)
      return []
    }
  }

  private convertMcpServers(servers: Record<string, McpServerConfig>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [name, server] of Object.entries(servers)) {
      const codexName = normalizeCodexMcpServerName(name)
      if (server.type === 'stdio') {
        result[codexName] = {
          command: server.command,
          args: server.args || [],
          env: server.env || {}
        }
      } else {
        const remoteConfig: Record<string, unknown> = { url: server.url }
        if (server.headers && Object.keys(server.headers).length > 0) {
          remoteConfig.http_headers = server.headers
        }
        result[codexName] = remoteConfig
      }
    }
    return result
  }

  private async logMcpServerInventory(session: AppServerSession, threadId: string, context: string): Promise<void> {
    try {
      const result = await this.sendRpcRequest(session, 'mcpServerStatus/list', {
        threadId,
        detail: 'toolsAndAuthOnly',
        limit: 100
      })
      if (!isObject(result) || !Array.isArray(result.data)) return

      const servers = result.data
        .filter(isObject)
        .map((server) => {
          const tools = server.tools
          const toolNames = Array.isArray(tools)
            ? tools.map((tool) => isObject(tool) ? asString(tool.name) : undefined).filter(Boolean)
            : isObject(tools)
              ? Object.keys(tools)
              : []

          return {
            name: asString(server.name) || 'unknown',
            authStatus: asString(server.authStatus) || null,
            toolCount: toolNames.length,
            toolNames: toolNames.slice(0, 50)
          }
        })

      console.log('[CodexAppServerAdapter] MCP inventory', { context, threadId, servers })
    } catch (error) {
      console.warn('[CodexAppServerAdapter] Failed to list MCP inventory:', error)
    }
  }

  private setupStdoutParser(process: ChildProcess, session: AppServerSession): void {
    process.stdout?.on('data', (chunk: Buffer) => {
      session.stdoutBuffer += chunk.toString()
      let newlineIndex: number
      while ((newlineIndex = session.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = session.stdoutBuffer.slice(0, newlineIndex).trim()
        session.stdoutBuffer = session.stdoutBuffer.slice(newlineIndex + 1)
        if (!line) continue
        try {
          this.handleRpcMessage(session, JSON.parse(line) as JsonRpcMessage)
        } catch (error) {
          console.error('[CodexAppServerAdapter] Failed to parse JSON-RPC:', line, error)
        }
      }
    })
  }

  private handleRpcMessage(session: AppServerSession, message: JsonRpcMessage): void {
    if ('id' in message && 'method' in message) {
      this.handleServerRequest(session, message as JsonRpcRequest)
      return
    }

    if ('id' in message) {
      const pending = session.pendingRequests.get(message.id)
      if (!pending) return
      session.pendingRequests.delete(message.id)
      const response = message as JsonRpcResponse
      if (response.error) {
        pending.reject(new Error(response.error.message))
      } else {
        pending.resolve(response.result)
      }
      return
    }

    if ('method' in message) {
      this.handleNotification(session, message as JsonRpcNotification)
    }
  }

  private handleServerRequest(session: AppServerSession, request: JsonRpcRequest): void {
    const params = isObject(request.params) ? request.params : {}
    if (request.method.includes('Approval') || request.method.includes('requestApproval')) {
      this.handleApprovalRequest(session, request, params)
      return
    }

    if (request.method === 'mcpServer/elicitation/request' || request.method === 'item/tool/requestUserInput') {
      this.handleApprovalRequest(session, request, params)
      return
    }

    this.sendRpcResponse(session, request.id, {})
  }

  private handleNotification(session: AppServerSession, notification: JsonRpcNotification): void {
    const params = isObject(notification.params) ? notification.params : {}

    if (notification.method === 'thread/status/changed') {
      const status = asString(params.status)
      session.status = status === 'running' || status === 'busy' ? SessionStatusType.BUSY : SessionStatusType.IDLE
    }

    if (notification.method === 'turn/started') {
      session.status = SessionStatusType.BUSY
      session.activeTurnId = asString(params.turnId) || session.activeTurnId
      session.pendingThreadIdle = false
    }

    if (notification.method === 'turn/completed') {
      session.activeTurnId = null
      if (session.threadId) {
        session.pendingCompletionRefreshes += 1
        void this.reconcileCompletedTurn(session)
      } else {
        session.status = SessionStatusType.IDLE
      }
    }

    if (notification.method === 'thread/status/changed') {
      session.sawThreadStatusNotification = true
      const status = isObject(params.status) ? asString(params.status.type) : ''
      if (status === 'active') {
        session.status = SessionStatusType.BUSY
        session.pendingThreadIdle = false
      } else if (status === 'idle') {
        session.activeTurnId = null
        session.pendingThreadIdle = true
        this.markIdleIfSettled(session)
      } else if (status === 'systemError') {
        session.status = SessionStatusType.ERROR
        session.lastError = 'Codex app-server thread entered system error state'
      }
    }

    if (notification.method === 'error') {
      session.status = SessionStatusType.ERROR
      session.lastError = extractText(params) || 'Codex app-server error'
    }

    if (notification.method === 'serverRequest/resolved') {
      const requestId = params.requestId
      if (session.pendingApproval && String(session.pendingApproval.requestId) === String(requestId)) {
        session.pendingApproval = null
        if (session.status === SessionStatusType.WAITING_APPROVAL) {
          session.status = SessionStatusType.BUSY
        }
      }
    }

    this.addEvent(session, notification)
  }

  private handleApprovalRequest(
    session: AppServerSession,
    request: JsonRpcRequest,
    params: Record<string, unknown>
  ): void {
    if (session.config.permissionMode === 'allow') {
      const responseKind = this.getApprovalResponseKind(request.method)
      const selected = responseKind === 'execCommand' ? 'approved' : 'accept'
      this.sendRpcResponse(session, request.id, this.buildApprovalResponse(responseKind, selected, true))
      return
    }

    const toolCallId = asString(params.approvalId) || asString(params.itemId) || asString(params.callId) || String(request.id)
    const responseKind = this.getApprovalResponseKind(request.method)

    const rawDecisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : []
    const approvalOptions = rawDecisions.length > 0
      ? rawDecisions.map((decision) => {
          const optionId = normalizeDecisionName(decision)
          return {
            optionId,
            name: decisionLabel(optionId),
            kind: optionId.includes('accept') || optionId === 'approved' ? 'allow' : 'reject'
          }
        })
      : [
          { optionId: 'accept', name: 'Allow', kind: 'allow' },
          { optionId: 'cancel', name: 'Deny', kind: 'reject' }
        ]

    session.pendingApproval = {
      requestId: request.id,
      toolCallId,
      question: summarizeApproval(params, request.method),
      options: approvalOptions,
      responseKind
    }
    session.status = SessionStatusType.WAITING_APPROVAL
    this.onDataAvailable?.(session.threadId || session.sessionId)
  }

  private buildApprovalResponse(
    responseKind: PendingApproval['responseKind'],
    selected: string,
    approved: boolean
  ): unknown {
    switch (responseKind) {
      case 'execCommand':
        return { decision: approved ? (selected === 'approved_for_session' ? 'approved_for_session' : 'approved') : (selected === 'denied' ? 'denied' : 'abort') }
      case 'commandExecution':
        return { decision: selected }
      case 'fileChange':
      case 'permissions':
        return { decision: selected }
      case 'elicitation':
        return approved
          ? { action: 'accept', content: {} }
          : { action: 'decline' }
      case 'userInput':
        return approved
          ? { response: selected }
          : { response: null }
      default:
        return { decision: approved ? selected : 'cancel' }
    }
  }

  private getApprovalResponseKind(method: string): PendingApproval['responseKind'] {
    if (method === 'execCommandApproval') return 'execCommand'
    if (method.includes('commandExecution')) return 'commandExecution'
    if (method.includes('fileChange')) return 'fileChange'
    if (method.includes('permissions')) return 'permissions'
    if (method === 'mcpServer/elicitation/request') return 'elicitation'
    if (method === 'item/tool/requestUserInput') return 'userInput'
    return 'generic'
  }

  private resolveSandboxMode(config: SessionConfig): 'read-only' | 'workspace-write' | 'danger-full-access' {
    switch (config.sandboxMode) {
      case 'read-only':
      case 'workspace-write':
      case 'danger-full-access':
        return config.sandboxMode
      default:
        return 'danger-full-access'
    }
  }

  private buildSandboxPolicy(config: SessionConfig): CodexSandboxPolicy {
    switch (this.resolveSandboxMode(config)) {
      case 'read-only':
        return { type: 'readOnly', networkAccess: true }
      case 'danger-full-access':
        return { type: 'dangerFullAccess' }
      case 'workspace-write':
      default:
        return {
          type: 'workspaceWrite',
          networkAccess: true,
          writableRoots: this.buildRuntimeWorkspaceRoots(config.workspaceDir)
        }
    }
  }

  private addEvent(session: AppServerSession, event: unknown): void {
    session.messageBuffer.push(event)
    session.permanentMessages.push(event)
    if (session.permanentMessages.length > 1000) {
      session.permanentMessages.splice(0, 250)
    }
    this.onDataAvailable?.(session.threadId || session.sessionId)
  }

  private bufferThreadItems(session: AppServerSession, result: unknown): void {
    const items = isObject(result) && Array.isArray(result.data) ? result.data : []
    for (const item of items) {
      this.bufferReconciledThreadItem(session, item, isObject(item) ? asString(item.turnId) : undefined)
    }
  }

  /**
   * Buffers a single thread item from a reconcile pass, skipping it if it has
   * already been buffered. reconcileCompletedTurn() re-lists the entire thread on
   * every turn/completed, so this MUST be idempotent for every item — including
   * the many Codex item types that carry no top-level `id` (function_call_output,
   * custom_tool_call_output, tool_search_output, user/developer messages). We key
   * off a stable identity (id/itemId/call_id) or, failing that, a deterministic
   * content hash, and forward that key as `itemId` so the derived part id stays
   * stable across passes. Without this, id-less items were re-emitted with a fresh
   * id on every idle and the transcript repeated older messages.
   */
  private bufferReconciledThreadItem(
    session: AppServerSession,
    item: unknown,
    turnId: string | undefined
  ): void {
    let stableItemId: string | undefined
    if (isObject(item)) {
      stableItemId = this.computeThreadItemKey(item, turnId)
      if (session.bufferedThreadItemIds.has(stableItemId)) return
      session.bufferedThreadItemIds.add(stableItemId)
    }
    this.addEvent(session, {
      method: 'item/completed',
      params: {
        threadId: session.threadId,
        turnId,
        item,
        ...(stableItemId ? { itemId: stableItemId } : {})
      }
    })
  }

  private computeThreadItemKey(item: Record<string, unknown>, turnId: string | undefined): string {
    const identity = deriveItemIdentity(item)
    if (identity) return identity
    // No id-like field (e.g. user/developer input messages). Build a deterministic
    // key from turn + type + role + content so the same item maps to the same key
    // across reconcile passes instead of duplicating.
    const type = asString(item.type) || 'item'
    const role = extractRole(item)
    return `synthetic:${turnId || 'noturn'}:${type}:${role}:${hashString(extractText(item))}`
  }

  private async bufferAllThreadItems(session: AppServerSession, threadId: string): Promise<void> {
    try {
      let cursor: string | null = null
      for (let page = 0; page < 20; page++) {
        const result = await this.sendRpcRequest(session, 'thread/items/list', {
          threadId,
          cursor,
          limit: 200,
          sortDirection: 'asc'
        })
        this.bufferThreadItems(session, result)
        cursor = isObject(result) ? (asString(result.nextCursor) || null) : null
        if (!cursor) return
      }
      console.warn('[CodexAppServerAdapter] Stopped thread/items pagination after 20 pages')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('not supported')) throw error
      await this.bufferAllThreadTurns(session, threadId)
    }
  }

  private async bufferAllThreadTurns(session: AppServerSession, threadId: string): Promise<void> {
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      let result: unknown
      try {
        result = await this.sendRpcRequest(session, 'thread/turns/list', {
          threadId,
          cursor,
          limit: 100,
          sortDirection: 'asc',
          itemsView: 'full'
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('not materialized yet') || message.includes('before first user message')) {
          return
        }
        throw error
      }
      const turns = isObject(result) && Array.isArray(result.data) ? result.data : []
      for (const turn of turns) {
        if (!isObject(turn) || !Array.isArray(turn.items)) continue
        for (const item of turn.items) {
          this.bufferReconciledThreadItem(session, item, asString(turn.id))
        }
      }
      cursor = isObject(result) ? (asString(result.nextCursor) || null) : null
      if (!cursor) return
    }
    console.warn('[CodexAppServerAdapter] Stopped thread/turns pagination after 20 pages')
  }

  private async reconcileCompletedTurn(session: AppServerSession): Promise<void> {
    try {
      if (!session.threadId) return
      await this.bufferAllThreadItems(session, session.threadId)
    } catch (error) {
      console.warn('[CodexAppServerAdapter] Failed to reconcile completed turn items:', error)
    } finally {
      session.pendingCompletionRefreshes = Math.max(0, session.pendingCompletionRefreshes - 1)
      this.markIdleIfSettled(session)
    }
  }

  private markIdleIfSettled(session: AppServerSession): void {
    if (session.status === SessionStatusType.ERROR) return
    if (session.pendingCompletionRefreshes > 0) return
    if (session.activeTurnId) return
    if (session.sawThreadStatusNotification && !session.pendingThreadIdle) return

    session.pendingThreadIdle = false
    session.status = SessionStatusType.IDLE
    this.onDataAvailable?.(session.threadId || session.sessionId)
  }

  private convertEventToMessageParts(
    event: unknown,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    session: AppServerSession
  ): MessagePart[] {
    if (!isObject(event) || !asString(event.method)) return []
    const method = event.method
    const params = isObject(event.params) ? event.params : {}
    const item = isObject(params.item) ? params.item : undefined

    if (method === 'item/agentMessage/delta') {
      const itemId = asString(params.itemId) || `agent-${Date.now()}`
      const partId = `agent-${itemId}`
      const delta = asString(params.delta) || ''
      const previous = session.streamedTextByItemId.get(itemId) || ''
      const next = previous + delta
      const update = seenPartIds.has(partId)
      seenPartIds.add(partId)
      session.streamedTextByItemId.set(itemId, next)
      partContentLengths.set(partId, String(next.length))
      // Register the streamed text against the turn so a later reconcile pass that
      // re-lists this assistant message under a DIFFERENT persisted item id does not
      // re-emit it as a brand-new part below the final message. Streaming deltas
      // never reach convertThreadItem()'s item/completed branch (which is the only
      // other place that marks turn text), so without this the live-vs-reconcile
      // copies could not be collapsed and the transcript repeated older messages.
      this.markAssistantTextForTurn(session, params, item ?? {}, next)
      return [{
        id: partId,
        type: MessagePartType.TEXT,
        text: next,
        role: MessageRole.ASSISTANT,
        update
      }]
    }

    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      const itemId = asString(params.itemId) || `reasoning-${Date.now()}`
      const partId = `reasoning-${itemId}`
      const text = asString(params.delta) || ''
      if (!text && seenPartIds.has(partId)) return []
      seenPartIds.add(partId)
      partContentLengths.set(partId, String(text.length))
      return [{
        id: partId,
        type: MessagePartType.REASONING,
        text,
        role: MessageRole.ASSISTANT
      }]
    }

    if (
      method === 'item/commandExecution/outputDelta' ||
      method === 'command/exec/outputDelta' ||
      method === 'process/outputDelta'
    ) {
      return this.convertOutputDeltaEvent('command', params, seenPartIds, partContentLengths, session)
    }

    if (
      method === 'item/fileChange/outputDelta' ||
      method === 'item/fileChange/patchUpdated'
    ) {
      return this.convertOutputDeltaEvent('file_change', params, seenPartIds, partContentLengths, session)
    }

    if (
      method === 'item/plan/delta' ||
      method === 'turn/plan/updated'
    ) {
      return this.convertOutputDeltaEvent('plan', params, seenPartIds, partContentLengths, session)
    }

    if (method === 'item/mcpToolCall/progress') {
      return this.convertOutputDeltaEvent('mcp_tool', params, seenPartIds, partContentLengths, session)
    }

    if ((method === 'item/started' || method === 'item/completed') && item) {
      return this.convertThreadItem(method, item, params, seenMessageIds, seenPartIds, partContentLengths, session)
    }

    if (method === 'error') {
      const partId = `error-${Date.now()}`
      return [{
        id: partId,
        type: MessagePartType.ERROR,
        text: extractText(params) || 'Codex app-server error',
        role: MessageRole.ASSISTANT
      }]
    }

    return []
  }

  private convertOutputDeltaEvent(
    toolName: string,
    params: Record<string, unknown>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    session: AppServerSession
  ): MessagePart[] {
    const itemId = asString(params.itemId) || asString(params.processId) || asString(params.turnId) || `${toolName}-${Date.now()}`
    const partId = `tool-${itemId}`
    const previous = session.streamedTextByItemId.get(partId) || ''
    const next = truncateForIpc(previous + extractText(params), MAX_IPC_TOOL_OUTPUT_CHARS)
    const update = seenPartIds.has(partId)
    seenPartIds.add(partId)
    session.streamedTextByItemId.set(partId, next)
    partContentLengths.set(partId, `${next.length}:${toolName}`)

    return [{
      id: partId,
      type: MessagePartType.TOOL,
      role: MessageRole.ASSISTANT,
      tool: {
        name: toolName,
        status: 'running',
        title: toolName,
        input: stringifyForIpc(params, MAX_IPC_TOOL_INPUT_CHARS),
        output: next
      },
      update
    }]
  }

  private convertThreadItem(
    method: string,
    item: Record<string, unknown>,
    params: Record<string, unknown>,
    _seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    session: AppServerSession
  ): MessagePart[] {
    const itemId = extractItemId(params)
    const type = asString(item.type) || ''
    const role = extractRole(item)
    const text = extractText(item)

    // Reasoning items are streamed live via item/reasoning/textDelta as a REASONING
    // part with id `reasoning-<itemId>`. reconcileCompletedTurn() re-lists the whole
    // thread and re-emits the same reasoning item as an item/completed. Without this
    // branch it fell through to the tool branch below and was emitted as a distinct
    // `tool-<itemId>` TOOL part, so the renderer could not collapse it against the
    // live `reasoning-<itemId>` part and the reasoning was repeated after each turn.
    // Emit it with the SAME part id/type as the live stream so the two collapse.
    if (type.includes('reasoning')) {
      const partId = `reasoning-${itemId}`
      const alreadySeen = seenPartIds.has(partId)
      if (alreadySeen && method !== 'item/completed') return []
      seenPartIds.add(partId)
      const reasoningText = text || session.streamedTextByItemId.get(itemId) || ''
      partContentLengths.set(partId, String(reasoningText.length))
      return [{
        id: partId,
        type: MessagePartType.REASONING,
        text: reasoningText,
        role: MessageRole.ASSISTANT,
        update: alreadySeen
      }]
    }

    if (role === 'user' || type.includes('user') || type === 'user_message') {
      const partId = `user-${itemId}`
      if (seenPartIds.has(partId)) return []
      seenPartIds.add(partId)
      partContentLengths.set(partId, String(text.length))
      return [{
        id: partId,
        type: MessagePartType.TEXT,
        text,
        role: MessageRole.USER
      }]
    }

    if (role === 'assistant' || type.includes('agent') || type.includes('assistant') || (!type && text)) {
      const partId = `agent-${itemId}`
      if (seenPartIds.has(partId) && method !== 'item/completed') return []
      const finalText = text || session.streamedTextByItemId.get(itemId) || ''
      const alreadySeen = seenPartIds.has(partId)
      if (!alreadySeen && method === 'item/completed' && this.hasSeenAssistantTextForTurn(session, params, item, finalText)) {
        return []
      }
      seenPartIds.add(partId)
      if (method === 'item/completed') {
        this.markAssistantTextForTurn(session, params, item, finalText)
      }
      partContentLengths.set(partId, String(finalText.length))
      return [{
        id: partId,
        type: MessagePartType.TEXT,
        text: finalText,
        role: MessageRole.ASSISTANT,
        update: method === 'item/completed' && session.streamedTextByItemId.has(itemId)
      }]
    }

    const toolName = extractToolName(item)
    const toolTitle = extractToolTitle(item, toolName)
    const partId = `tool-${itemId}`
    const isCompleted = method === 'item/completed'
    if (!isCompleted && seenPartIds.has(partId)) return []
    seenPartIds.add(partId)

    const part: MessagePart = {
      id: partId,
      type: MessagePartType.TOOL,
      role: MessageRole.ASSISTANT,
      tool: {
        name: toolName,
        status: isCompleted ? 'completed' : 'running',
        title: toolTitle,
        input: stringifyForIpc(item, MAX_IPC_TOOL_INPUT_CHARS),
        output: isCompleted ? stringifyForIpc(extractText(item) || item, MAX_IPC_TOOL_OUTPUT_CHARS) : undefined
      },
      update: isCompleted
    }

    if (isCompleted) {
      session.runningTools.delete(partId)
    } else {
      session.runningTools.set(partId, {
        partId,
        toolName,
        startTime: typeof params.startedAtMs === 'number' ? params.startedAtMs : Date.now(),
        input: item
      })
    }

    partContentLengths.set(partId, `${part.tool?.status}:${toolName}`)
    return [part]
  }

  private hasSeenAssistantTextForTurn(
    session: AppServerSession,
    params: Record<string, unknown>,
    item: Record<string, unknown>,
    text: string
  ): boolean {
    const key = this.buildAssistantTextKey(text)
    if (!key) return false
    const turnKey = this.extractTurnKey(params, item)
    return session.assistantTextKeysByTurn.get(turnKey)?.has(key) ?? false
  }

  private markAssistantTextForTurn(
    session: AppServerSession,
    params: Record<string, unknown>,
    item: Record<string, unknown>,
    text: string
  ): void {
    const key = this.buildAssistantTextKey(text)
    if (!key) return
    const turnKey = this.extractTurnKey(params, item)
    const seenForTurn = session.assistantTextKeysByTurn.get(turnKey) ?? new Set<string>()
    seenForTurn.add(key)
    session.assistantTextKeysByTurn.set(turnKey, seenForTurn)
  }

  private extractTurnKey(params: Record<string, unknown>, item: Record<string, unknown>): string {
    return asString(params.turnId) || asString(item.turnId) || asString(params.threadId) || 'unknown-turn'
  }

  private buildAssistantTextKey(text: string): string {
    return text.trim().replace(/\s+/g, ' ')
  }

  private sendRpcRequest(session: AppServerSession, method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = session.nextRequestId++
      session.pendingRequests.set(id, { resolve, reject })
      this.writeJson(session, { jsonrpc: '2.0', id, method, params })
      setTimeout(() => {
        if (!session.pendingRequests.has(id)) return
        session.pendingRequests.delete(id)
        reject(new Error(`Codex app-server RPC timed out: ${method}`))
      }, 30000)
    })
  }

  private sendRpcResponse(session: AppServerSession, id: string | number, result: unknown): void {
    this.writeJson(session, { jsonrpc: '2.0', id, result })
  }

  private sendRpcNotification(session: AppServerSession, method: string, params?: unknown): void {
    this.writeJson(session, { jsonrpc: '2.0', method, params })
  }

  private writeJson(session: AppServerSession, payload: unknown): void {
    session.process.stdin?.write(`${JSON.stringify(payload)}\n`)
  }

  private requireSession(sessionId: string): AppServerSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return session
  }
}
