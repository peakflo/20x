/**
 * Codex App Server adapter.
 *
 * Experimental replacement path for Codex ACP. This talks to `codex app-server`
 * over JSON-RPC stdio and maps the app-server thread/turn/item protocol onto
 * 20x's CodingAgentAdapter contract.
 */

import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
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
  pendingRequests: Map<string | number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>
  pendingApproval: PendingApproval | null
  nextRequestId: number
  lastError: string | null
  config: SessionConfig
  streamedTextByItemId: Map<string, string>
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

function extractItemId(params: Record<string, unknown>): string {
  const item = isObject(params.item) ? params.item : undefined
  return asString(params.itemId) || asString(item?.id) || `item-${Date.now()}`
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

function extractToolName(item: Record<string, unknown>): string {
  return (
    asString(item.toolName) ||
    asString(item.tool_name) ||
    asString(item.name) ||
    asString(item.type) ||
    'tool'
  )
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
      runtimeWorkspaceRoots: [config.workspaceDir],
      config: this.buildConfigOverrides(config)
    })

    const threadId = extractThreadId(result)
    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id')
    }

    session.threadId = threadId
    this.sessions.delete(config.taskId)
    this.sessions.set(threadId, session)
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
      runtimeWorkspaceRoots: [config.workspaceDir],
      initialTurnsPage: { limit: 50 },
      config: this.buildConfigOverrides(config)
    })

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
      sandbox: this.resolveSandboxMode(config)
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

    for (const event of session.permanentMessages) {
      const parts = this.convertEventToMessageParts(event, seenMessageIds, seenPartIds, partContentLengths, session)
      for (const part of parts) {
        const key = `${part.id || `part-${partsByIdAndRole.size}`}-${part.role || MessageRole.ASSISTANT}`
        if (!partsByIdAndRole.has(key) || part.update) {
          partsByIdAndRole.set(key, part)
        }
      }
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
      pendingRequests: new Map(),
      pendingApproval: null,
      nextRequestId: 1,
      lastError: null,
      config,
      streamedTextByItemId: new Map(),
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
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      overrides.mcp_servers = this.convertMcpServers(config.mcpServers)
    }
    return overrides
  }

  private convertMcpServers(servers: Record<string, McpServerConfig>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [name, server] of Object.entries(servers)) {
      if (server.type === 'stdio') {
        result[name] = {
          command: server.command,
          args: server.args || [],
          env: server.env || {}
        }
      } else {
        result[name] = {
          type: server.type,
          url: server.url,
          headers: server.headers || {}
        }
      }
    }
    return result
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
    }

    if (notification.method === 'turn/completed') {
      session.status = SessionStatusType.IDLE
      session.activeTurnId = null
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
        return 'workspace-write'
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
      this.addEvent(session, {
        method: 'item/completed',
        params: {
          threadId: session.threadId,
          turnId: isObject(item) ? asString(item.turnId) : undefined,
          item
        }
      })
    }
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
          this.addEvent(session, {
            method: 'item/completed',
            params: {
              threadId: session.threadId,
              turnId: asString(turn.id),
              item
            }
          })
        }
      }
      cursor = isObject(result) ? (asString(result.nextCursor) || null) : null
      if (!cursor) return
    }
    console.warn('[CodexAppServerAdapter] Stopped thread/turns pagination after 20 pages')
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
    const next = previous + extractText(params)
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
        input: params,
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
    const text = extractText(item)

    if (type.includes('user') || type === 'user_message') {
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

    if (type.includes('agent') || type.includes('assistant') || (!type && text)) {
      const partId = `agent-${itemId}`
      if (seenPartIds.has(partId) && method !== 'item/completed') return []
      seenPartIds.add(partId)
      const finalText = text || session.streamedTextByItemId.get(itemId) || ''
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
        title: toolName,
        input: item,
        output: isCompleted ? item : undefined
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
