/**
 * Generic ACP (Agent Client Protocol) client for ACP-compatible coding agent
 * processes. Any agent reachable by spawning a command — a registry binary,
 * an npx/uvx invocation, or a user-pointed local command — can use this
 * client; it is not specific to any one agent.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON). This file owns
 * its own framing/transport (proven in production) rather than adopting the
 * ACP SDK's Stream abstraction; the SDK is used purely for its TypeScript
 * schema types so request/response/notification shapes are checked against
 * the real protocol instead of hand-rolled interfaces.
 *
 * Supports both ACP generations:
 *  - v1 ("stable"): `authenticate`/`logout`, `session/load`, `session/set_mode`.
 *  - v2 (`experimental/v2`): `auth/login`/`auth/logout`, `session/resume`
 *    (collapses create+resume via a replay cursor), mode selection folded
 *    into the generic config-option mechanism.
 * The generation actually spoken by a given agent process is decided from
 * the *shape* of its `initialize` response (see `detectGeneration`), not the
 * numeric `protocolVersion` it reports — some agents misreport that number.
 *
 * Cursor is NOT special-cased here, and nothing dispatches Cursor agents to
 * this client anymore — Cursor now has its own dedicated adapter built on
 * the official `@cursor/sdk` package (see `cursor-sdk-adapter.ts`), wired up
 * in agent-manager.ts's `CodingAgentType.CURSOR` case. Codex keeps its own
 * separate, untouched CodexAppServerAdapter.
 */

import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { realpath as realpathAsync } from 'fs/promises'
import { isAbsolute, relative, resolve as resolvePath } from 'path'
import { guardChildStreams } from '../child-stream-guards'
import type {
  CodingAgentAdapter,
  SessionConfig,
  SessionMessage,
  SessionStatus,
  MessagePart,
  McpServerConfig,
  AdapterUsageLimitsEvent,
  AdapterUsageReport,
  UsageLimitStop
} from './coding-agent-adapter'
import { SessionStatusType, MessagePartType, MessageRole } from './coding-agent-adapter'
import type { ProviderUsageLimits } from '../../shared/usage'
import { acpUsageUpdateCostUsd, normalizeAcpPromptUsage } from '../usage/usage-normalize'
import { getWrapperHooks, type AcpWrapperHooks, type AcpErrorClass } from '../acp-registry/wrapper-hooks'

// Type-only imports: real ACP wire shapes for v1 ("stable") and the
// experimental v2 generation. Never imported as values — the package ships
// ESM-only and this file stays on its own hand-rolled stdio JSON-RPC loop.
import type {
  AgentCapabilities as AcpV1AgentCapabilities,
  AuthMethod as AcpV1AuthMethod,
  ContentBlock as AcpV1ContentBlock,
  McpServer as AcpV1McpServer,
  SessionConfigOption as AcpV1SessionConfigOption
} from '@agentclientprotocol/sdk'
import type { InitializeResponse as AcpV2InitializeResponse } from '@agentclientprotocol/sdk/experimental/v2'

// ============================================================================
// Generic process configuration
// ============================================================================

/** Resolved, ready-to-spawn process description. Upstream (registry/install
 *  manager/local-command code) decides how this was obtained; this client
 *  only cares that it is a literal argv it can spawn directly. */
export interface AcpAgentProcessConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface AcpAgentAdapterOptions extends AcpAgentProcessConfig {
  /** Per-agent extension hooks. Takes precedence over `registryAgentId`. */
  wrapperHooks?: AcpWrapperHooks
  /** Looked up via `getWrapperHooks` when `wrapperHooks` is not supplied. */
  registryAgentId?: string
  /** Advertise + serve `fs/read_text_file` / `fs/write_text_file`. Default: false. */
  enableFs?: boolean
  /** Advertise + serve `terminal/*`. Default: false — off unless explicitly requested. */
  enableTerminal?: boolean
  /**
   * Resolves the real process config asynchronously (e.g. a registry agent
   * that may need installing first). `getAdapter`-style callers are
   * necessarily synchronous, so a registry-backed instance is constructed
   * with placeholder `command`/`args` and this resolver instead; it's run
   * once, in `initialize()` — which every caller already awaits before
   * `createSession`/`resumeSession`/the deep health check — and overwrites
   * the placeholder before anything is ever spawned.
   */
  resolveProcessConfig?: () => Promise<AcpAgentProcessConfig>
}

// ============================================================================
// JSON-RPC 2.0 framing (hand-rolled; proven, kept as-is)
// ============================================================================

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
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcError {
  jsonrpc: '2.0'
  id: string | number
  error: { code: number; message: string; data?: unknown }
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse | JsonRpcError

// ACP `session/update` notification payload (loosely typed: fields vary a lot
// by update kind, and both protocol generations are accepted on this wire).
interface SessionUpdate {
  sessionUpdate?: string
  messageId?: string
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  content?: unknown
  entries?: Array<{ content: string; priority: string; status: string }>
  configOptions?: AcpV1SessionConfigOption[]
  currentModeId?: string
  availableCommands?: unknown[]
}

interface AcpPermissionRequest {
  requestId: string | number
  toolCallId: string
  question: string
  options: Array<{ optionId: string; name: string; kind: string }>
}

/** Negotiated protocol generation for one connection (one spawned process). */
type AcpGeneration = 'v1' | 'v2'

/** Internal booleans derived from `agentCapabilities`/`capabilities`, actually used below. */
interface AcpNegotiatedCapabilities {
  canResume: boolean
  mcpHttp: boolean
  mcpSse: boolean
  promptImage: boolean
  supportsLogout: boolean
  hasDedicatedSetMode: boolean
}

/** Pending sign-in flow state for the auth methods that need more than one RPC. */
interface AcpPendingAuth {
  kind: 'browser'
  url: string
  elicitationRequestId: string | number
  resolve: (proceed: boolean) => void
}

interface AcpTerminalProcess {
  process: ChildProcess
  stdout: string
  stderr: string
  exitCode: number | null
  exitSignal: string | null
  exited: boolean
}

interface AcpSession {
  sessionId: string
  acpSessionId: string | null
  process: ChildProcess
  stdoutBuffer: string
  status: SessionStatusType
  messageBuffer: unknown[]
  permanentMessages: unknown[]
  pendingRequests: Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
  nextRequestId: number
  pendingApproval: AcpPermissionRequest | null
  config: SessionConfig
  promptRequestId: number | null
  responseCounter: number
  currentUserTurnId: number
  lastChunkTime: number | null
  currentTurnId: number
  lastSessionUpdateType: string | null
  activeTurnId: number | null
  pendingAssistantTurnSplit: boolean
  toolCallMetadata: Map<string, { name: string; input: string; title?: string }>
  lastError: string | null
  createdInApp: boolean
  usageLimit?: UsageLimitStop | null
  usageCostUsd: number | null
  // Negotiation state
  generation: AcpGeneration
  capabilities: AcpNegotiatedCapabilities
  // New update surfaces
  configOptions: AcpV1SessionConfigOption[]
  currentModeId: string | null
  availableCommands: unknown[]
  // Auth flow
  pendingAuth: AcpPendingAuth | null
  lastAuthMethods?: AcpV1AuthMethod[]
  _resolveBrowserWait?: (v: { kind: 'browser'; url: string }) => void
  // Terminal (gated by enableTerminal)
  terminals: Map<string, AcpTerminalProcess>
}

/**
 * Generic ACP client/adapter. One instance per agent process configuration
 * (e.g. one per registry agent, one per harness instance); each session owns
 * its own spawned child process and its own `initialize` handshake, matching
 * how real ACP agents behave (no cross-session protocol state).
 */
export class AcpAgentAdapter implements CodingAgentAdapter {
  private processConfig: AcpAgentProcessConfig
  private wrapperHooks: AcpWrapperHooks
  private enableFs: boolean
  private enableTerminal: boolean
  private sessions = new Map<string, AcpSession>()
  private debugRpcLogs: boolean

  private static readonly MAX_PERMANENT_MESSAGES = 1000
  private static readonly MAX_TOOL_CALL_METADATA = 500

  /** Callback set by agent-manager to trigger an immediate poll cycle */
  onDataAvailable?: (sessionId: string) => void
  /** Set by agent-manager: receives cumulative session usage at each turn end. */
  onUsage?: (report: AdapterUsageReport) => void
  /** Set by agent-manager: receives plan-limit snapshots/updates. */
  onUsageLimits?: (event: AdapterUsageLimitsEvent) => void

  /**
   * Reads the provider's current plan/usage limits on demand. Generic ACP
   * agents have no standard way to expose subscription plan limits, so the
   * default always resolves to null. This is an *own* property (not a
   * prototype method), so a caller that knows a specific agent instance has
   * an out-of-band way to read limits (e.g. a CLI login file) can override
   * it per instance without this class needing to know about that agent.
   */
  probeUsageLimits: () => Promise<ProviderUsageLimits | null> = async () => null
  private limitsRead: Promise<ProviderUsageLimits | null> | null = null
  private lastLimitsReadAt = 0

  private resolveProcessConfig?: () => Promise<AcpAgentProcessConfig>
  private processConfigResolved = false

  constructor(options: AcpAgentAdapterOptions) {
    this.processConfig = { command: options.command, args: options.args, env: options.env }
    this.wrapperHooks = options.wrapperHooks ?? getWrapperHooks(options.registryAgentId)
    this.enableFs = options.enableFs ?? false
    this.enableTerminal = options.enableTerminal ?? false
    this.resolveProcessConfig = options.resolveProcessConfig
    this.debugRpcLogs = AcpAgentAdapter.isDebugLogLevel(process.env.LOG_LEVEL)
  }

  private static isDebugLogLevel(value: string | undefined): boolean {
    if (!value) return false
    const normalized = value.trim().toLowerCase()
    return normalized === 'debug' || normalized === 'trace'
  }

  async initialize(): Promise<void> {
    if (this.resolveProcessConfig && !this.processConfigResolved) {
      this.processConfig = await this.resolveProcessConfig()
      this.processConfigResolved = true
    }
    const health = await this.checkHealth()
    if (!health.available) {
      throw new Error(health.reason || 'ACP agent not available')
    }
    console.log('[AcpAgentAdapter] Initialized successfully')
  }

  // ==========================================================================
  // Session lifecycle
  // ==========================================================================

  async createSession(config: SessionConfig): Promise<string> {
    const sessionId = config.taskId
    console.log(`[AcpAgentAdapter] Creating session ${sessionId}`)

    const env = this.buildEnv(config)
    const acpProcess = this.spawnAgentProcess(config, env)
    const session = this.initSessionState(sessionId, acpProcess, config, true)
    this.sessions.set(sessionId, session)
    this.wireProcess(acpProcess, session)

    const initResult = await this.performHandshake(session)
    await this.authenticateSession(session, initResult)

    const convertedMcpServers = this.convertMcpServers(config.mcpServers, session)
    const result = await this.sendRpcRequest(session, 'session/new', {
      cwd: config.workspaceDir,
      mcpServers: convertedMcpServers
    })

    const acpSessionId = this.extractAcpSessionId(result)
    if (acpSessionId) {
      session.acpSessionId = acpSessionId
      this.sessions.delete(sessionId)
      this.sessions.set(acpSessionId, session)
    }

    if (config.model && acpSessionId) {
      await this.setModel(session, config.model)
    }
    if (config.reasoningEffort && config.reasoningEffort !== 'max' && acpSessionId) {
      try {
        await this.sendRpcRequest(session, 'session/set_config_option', {
          sessionId: acpSessionId,
          configId: 'model_reasoning_effort',
          value: config.reasoningEffort
        })
      } catch (error: unknown) {
        console.warn(`[AcpAgentAdapter] Failed to set reasoning effort: ${errMsg(error)}`)
      }
    }

    console.log(`[AcpAgentAdapter] Session created: ${sessionId} (ACP: ${acpSessionId})`)
    return acpSessionId || sessionId
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    console.log(`[AcpAgentAdapter] Resuming session ${sessionId}`)

    const env = this.buildEnv(config)
    const acpProcess = this.spawnAgentProcess(config, env)
    const session = this.initSessionState(sessionId, acpProcess, config, false)
    session.acpSessionId = sessionId
    this.sessions.set(sessionId, session)
    this.wireProcess(acpProcess, session)

    const initResult = await this.performHandshake(session)
    await this.authenticateSession(session, initResult)

    try {
      const mcpServers = this.convertMcpServers(config.mcpServers, session)
      if (session.generation === 'v2') {
        await this.sendRpcRequest(session, 'session/resume', {
          sessionId,
          cwd: config.workspaceDir,
          mcpServers,
          replayFrom: { type: 'start' }
        })
      } else {
        await this.sendRpcRequest(session, 'session/load', {
          sessionId,
          cwd: config.workspaceDir,
          mcpServers
        })
      }

      console.log(`[AcpAgentAdapter] Session loaded successfully: ${sessionId}`)
      const messages = await this.getAllMessages(sessionId, config)
      session.messageBuffer = []
      return messages
    } catch (error: unknown) {
      const message = errMsg(error)
      if (message.includes('not found') || message.includes('does not exist')) {
        acpProcess.kill('SIGTERM')
        this.sessions.delete(sessionId)
        throw new Error('INCOMPATIBLE_SESSION_ID: This session does not exist or has expired. Please start a new session.')
      }
      throw error
    }
  }

  private buildEnv(config: SessionConfig): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.processConfig.env
    }
    if (config.apiKeys?.anthropic) env.ANTHROPIC_API_KEY = config.apiKeys.anthropic
    if (config.secretEnvVars) {
      for (const [key, value] of Object.entries(config.secretEnvVars)) env[key] = value
    }
    return env
  }

  private spawnAgentProcess(config: SessionConfig, env: Record<string, string | undefined>): ChildProcess {
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.processConfig.command)
    const acpProcess = spawn(this.processConfig.command, this.processConfig.args, {
      cwd: config.workspaceDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(needsShell ? { shell: true } : {})
    })
    guardChildStreams(acpProcess, '[AcpAgentAdapter]')
    return acpProcess
  }

  private initSessionState(
    sessionId: string,
    acpProcess: ChildProcess,
    config: SessionConfig,
    createdInApp: boolean
  ): AcpSession {
    return {
      sessionId,
      acpSessionId: null,
      createdInApp,
      usageCostUsd: null,
      process: acpProcess,
      stdoutBuffer: '',
      status: SessionStatusType.IDLE,
      messageBuffer: [],
      permanentMessages: [],
      pendingRequests: new Map(),
      nextRequestId: 1,
      pendingApproval: null,
      config,
      promptRequestId: null,
      responseCounter: 0,
      currentUserTurnId: 0,
      lastChunkTime: null,
      currentTurnId: 0,
      lastSessionUpdateType: null,
      activeTurnId: null,
      pendingAssistantTurnSplit: false,
      toolCallMetadata: new Map(),
      lastError: null,
      generation: 'v1',
      capabilities: {
        canResume: false,
        mcpHttp: false,
        mcpSse: false,
        promptImage: false,
        supportsLogout: false,
        hasDedicatedSetMode: false
      },
      configOptions: [],
      currentModeId: null,
      availableCommands: [],
      pendingAuth: null,
      terminals: new Map()
    }
  }

  private wireProcess(acpProcess: ChildProcess, session: AcpSession): void {
    this.setupStdoutParser(acpProcess, session)
    acpProcess.stderr?.on('data', (chunk: Buffer) => {
      console.log('[AcpAgentAdapter] stderr:', chunk.toString())
    })
    acpProcess.on('exit', (code, signal) => {
      console.log(`[AcpAgentAdapter] Process exited: code=${code}, signal=${signal}`)
      session.status = code === 0 ? SessionStatusType.IDLE : SessionStatusType.ERROR
    })
  }

  /**
   * Sends one `initialize` request shaped to satisfy both ACP generations,
   * then decides which generation the agent actually speaks from the SHAPE
   * of the response (not the `protocolVersion` number it reports — that
   * number alone isn't trusted, since a real agent could misreport it).
   *
   * v2 initialize responses carry a required `info: Implementation` field
   * and an optional `capabilities` field; v1 carries `agentCapabilities`
   * and an optional, nullable `agentInfo`. Presence of `info`/`capabilities`
   * without `agentCapabilities` is treated as v2.
   */
  private async performHandshake(session: AcpSession): Promise<Record<string, unknown>> {
    const clientCapabilities: Record<string, unknown> = {
      fs: { readTextFile: this.enableFs, writeTextFile: this.enableFs },
      terminal: this.enableTerminal,
      ...this.wrapperHooks.extraClientCapabilities
    }

    const initResult = await this.sendRpcRequest(session, 'initialize', {
      protocolVersion: 1,
      clientCapabilities,
      clientInfo: { name: 'pf-desktop', version: '0.0.1' },
      ...(this.wrapperHooks.extraInitializeMeta ? { _meta: this.wrapperHooks.extraInitializeMeta } : {})
    }) as Record<string, unknown>

    session.generation = detectAcpGeneration(initResult)
    session.capabilities = deriveNegotiatedCapabilities(session.generation, initResult)
    console.log(`[AcpAgentAdapter] Negotiated generation=${session.generation} capabilities=${JSON.stringify(session.capabilities)}`)
    return initResult
  }

  private async setModel(session: AcpSession, modelId: string): Promise<void> {
    if (!session.acpSessionId) return
    const wireModel = this.wrapperHooks.mapModelIdToWire?.(modelId) ?? modelId
    try {
      // Neither ACP generation currently has a dedicated "set model" RPC —
      // both use the generic config-option mechanism with configId 'model'.
      // Kept as its own branch point (rather than inlined at the call site)
      // so a future generation that *does* add a dedicated RPC only needs a
      // new case here.
      await this.sendRpcRequest(session, 'session/set_config_option', {
        sessionId: session.acpSessionId,
        configId: 'model',
        value: wireModel
      })
      console.log(`[AcpAgentAdapter] Model set to: ${modelId}`)
    } catch (error: unknown) {
      console.warn(`[AcpAgentAdapter] Failed to set model: ${errMsg(error)}`)
    }
  }

  async sendPrompt(sessionId: string, parts: MessagePart[], _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    const promptBlocks = this.buildPromptContentBlocks(parts, session)
    if (promptBlocks.length === 0) {
      throw new Error('No text content in message parts')
    }

    const promptText = parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n')
    console.log(`[AcpAgentAdapter] Sending prompt to session ${sessionId}:`)
    console.log(promptText.slice(0, 200) + (promptText.length > 200 ? '...' : ''))

    // Clear stale buffered events from the previous turn (see historical
    // comment in getAllMessages for why this matters for dedup).
    session.messageBuffer = []

    this.addToPermanentMessages(session, {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'user_message',
          content: { type: 'text', text: promptText },
          messageId: `user-prompt-${session.currentTurnId + 1}`
        }
      }
    } as unknown as JsonRpcNotification)

    session.status = SessionStatusType.BUSY
    session.lastError = null
    session.usageLimit = null
    session.currentTurnId++
    session.activeTurnId = session.currentTurnId
    session.lastChunkTime = null

    this.sendRpcRequestNoWait(session, 'session/prompt', {
      sessionId: session.acpSessionId,
      prompt: promptBlocks
    })
  }

  /** Builds ACP ContentBlocks for an outgoing prompt, including images only when advertised. */
  private buildPromptContentBlocks(parts: MessagePart[], session: AcpSession): AcpV1ContentBlock[] {
    const blocks: AcpV1ContentBlock[] = []
    for (const part of parts) {
      if (part.type === 'text' && part.text) {
        blocks.push({ type: 'text', text: part.text } as AcpV1ContentBlock)
      } else if (part.type === MessagePartType.IMAGE && part.content) {
        if (!session.capabilities.promptImage) {
          console.warn('[AcpAgentAdapter] Dropping image part: agent did not advertise promptCapabilities.image')
          continue
        }
        // part.content is expected to be a data URL ("data:<mime>;base64,<data>")
        // or a bare base64 string; MIME type falls back to image/png.
        const match = /^data:([^;]+);base64,(.*)$/.exec(part.content)
        const mimeType = match?.[1] || 'image/png'
        const data = match?.[2] || part.content
        blocks.push({ type: 'image', data, mimeType } as AcpV1ContentBlock)
      }
    }
    return blocks
  }

  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId)
    if (!session) return { type: SessionStatusType.ERROR, message: 'Session not found' }
    return {
      type: session.status,
      message: session.status === 'error' ? (session.lastError || 'Process error') : undefined,
      ...(session.status === 'error' && session.usageLimit ? { usageLimit: session.usageLimit } : {})
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

    const newParts: MessagePart[] = []
    for (const event of session.messageBuffer) {
      newParts.push(...this.convertAcpEventToMessageParts(event, seenMessageIds, seenPartIds, partContentLengths, session))
    }
    session.messageBuffer = []
    return newParts
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    console.log(`[AcpAgentAdapter] Sending session/cancel for ${sessionId}`)
    this.sendRpcNotification(session, 'session/cancel', { sessionId: session.acpSessionId })
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    console.log(`[AcpAgentAdapter] Destroying session ${sessionId}`)
    session.process.kill('SIGTERM')
    setTimeout(() => {
      if (!session.process.killed) session.process.kill('SIGKILL')
    }, 1000)
    for (const terminal of session.terminals.values()) {
      try { terminal.process.kill('SIGTERM') } catch { /* already gone */ }
    }
    session.permanentMessages.length = 0
    session.messageBuffer.length = 0
    session.toolCallMetadata.clear()
    session.pendingRequests.clear()
    session.terminals.clear()
    this.sessions.delete(sessionId)
  }

  async getAllMessages(sessionId: string, _config: SessionConfig): Promise<SessionMessage[]> {
    const session = this.sessions.get(sessionId)
    if (!session) return []

    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const partsByIdAndRole = new Map<string, MessagePart>()

    const savedTurnState = {
      currentTurnId: session.currentTurnId,
      activeTurnId: session.activeTurnId,
      currentUserTurnId: session.currentUserTurnId,
      lastChunkTime: session.lastChunkTime,
      lastSessionUpdateType: session.lastSessionUpdateType,
      pendingAssistantTurnSplit: session.pendingAssistantTurnSplit,
      toolCallMetadata: new Map(session.toolCallMetadata)
    }

    session.currentTurnId = 0
    session.activeTurnId = null
    session.currentUserTurnId = 0
    session.lastChunkTime = null
    session.lastSessionUpdateType = null
    session.pendingAssistantTurnSplit = false
    session.toolCallMetadata = new Map()

    for (const event of session.permanentMessages) {
      const parts = this.convertAcpEventToMessageParts(event, seenMessageIds, seenPartIds, partContentLengths, session)
      const receivedAt = (event as Record<string, unknown>)?._receivedAt as number | undefined
      for (const part of parts) {
        if (receivedAt) part.receivedAt = receivedAt
        const key = `${part.id}-${part.role || 'assistant'}`
        if (!partsByIdAndRole.has(key) || part.update) partsByIdAndRole.set(key, part)
      }
    }

    session.currentTurnId = savedTurnState.currentTurnId
    session.activeTurnId = savedTurnState.activeTurnId
    session.currentUserTurnId = savedTurnState.currentUserTurnId
    session.lastChunkTime = savedTurnState.lastChunkTime
    session.lastSessionUpdateType = savedTurnState.lastSessionUpdateType
    session.pendingAssistantTurnSplit = savedTurnState.pendingAssistantTurnSplit
    session.toolCallMetadata = savedTurnState.toolCallMetadata

    const allParts = Array.from(partsByIdAndRole.values())
    const messages: SessionMessage[] = []
    let currentMessage: SessionMessage | null = null
    let previousPart: MessagePart | null = null
    let messageIdCounter = 0

    for (const part of allParts) {
      const roleStr = part.role || 'assistant'
      const role = roleStr === 'user' ? MessageRole.USER : roleStr === 'system' ? MessageRole.SYSTEM : MessageRole.ASSISTANT
      const startsNewMessage = !currentMessage || currentMessage.role !== role || !previousPart || part.id !== previousPart.id
      if (startsNewMessage) {
        if (currentMessage) messages.push(currentMessage)
        currentMessage = { id: `msg-${messageIdCounter++}`, role, parts: [] }
      }
      currentMessage!.parts.push(part)
      previousPart = part
    }
    if (currentMessage) messages.push(currentMessage)
    return messages
  }

  async registerMcpServer(): Promise<void> {
    console.log('[AcpAgentAdapter] MCP server registration deferred to session creation')
  }

  // ==========================================================================
  // Health check: layered, generic
  // ==========================================================================

  /**
   * Cheap local check: the command/args are always "configured" here since
   * they're passed in fully resolved by the caller. A deep check (opt-in)
   * spawns the process, performs `initialize`, opens a disposable session,
   * and closes it immediately — categorizing failures without ever treating
   * a v1-vs-v2 shape difference as an error (see `performHandshake`).
   */
  async checkHealth(deep = false): Promise<{ available: boolean; reason?: string }> {
    if (!deep) {
      return { available: true }
    }
    const probeProcess = spawn(this.processConfig.command, this.processConfig.args, {
      env: { ...process.env, ...this.processConfig.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    guardChildStreams(probeProcess, '[AcpAgentAdapter/health]')

    return new Promise((resolve) => {
      let settled = false
      const finish = (result: { available: boolean; reason?: string }) => {
        if (settled) return
        settled = true
        try { probeProcess.kill('SIGTERM') } catch { /* already gone */ }
        resolve(result)
      }

      probeProcess.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          finish({ available: false, reason: `not-installed: ${error.message}` })
        } else {
          finish({ available: false, reason: `generic failure: ${error.message}` })
        }
      })

      const timer = setTimeout(() => finish({ available: false, reason: 'generic failure: health check timed out' }), 10000)

      const probeSession = this.initSessionState('__health__', probeProcess, { agentId: '', taskId: '__health__', workspaceDir: process.cwd() }, true)
      this.setupStdoutParser(probeProcess, probeSession)

      this.performHandshake(probeSession)
        .then(() => {
          clearTimeout(timer)
          finish({ available: true })
        })
        .catch((error: unknown) => {
          clearTimeout(timer)
          const message = errMsg(error).toLowerCase()
          if (message.includes('authenticate') || message.includes('credentials') || message.includes('login')) {
            finish({ available: false, reason: `needs-sign-in: ${errMsg(error)}` })
          } else if (message.includes('unrecognized') || message.includes('unsupported protocol')) {
            finish({ available: false, reason: `protocol-mismatch: ${errMsg(error)}` })
          } else {
            finish({ available: false, reason: `generic failure: ${errMsg(error)}` })
          }
        })
    })
  }

  // ==========================================================================
  // Permission handling (duck-typed by agent-manager.ts; keep method names)
  // ==========================================================================

  getPendingApproval(sessionId: string): AcpPermissionRequest | null {
    const session = this.sessions.get(sessionId)
    return session?.pendingApproval || null
  }

  async respondToApproval(sessionId: string, approved: boolean, optionId?: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.pendingApproval) {
      console.warn(`[AcpAgentAdapter] No pending approval for session ${sessionId}`)
      return
    }
    const approval = session.pendingApproval
    let selectedOptionId = approval.options.some((option) => option.optionId === optionId) ? optionId : undefined
    if (!selectedOptionId) {
      selectedOptionId = approved
        ? approval.options.find((option) => option.optionId === 'approved')?.optionId || 'approved'
        : approval.options.find((option) => option.optionId === 'reject-once')?.optionId || 'abort'
    }
    console.log(`[AcpAgentAdapter] Responding to approval with: ${selectedOptionId}`)
    this.sendRpcResponse(session, approval.requestId, {
      result: { outcome: { outcome: 'selected', optionId: selectedOptionId } }
    })
    session.pendingApproval = null
  }

  // ==========================================================================
  // Config options surface (new: model options separated from generic ones)
  // ==========================================================================

  getConfigOptions(sessionId: string): { options: AcpV1SessionConfigOption[]; models: AcpV1SessionConfigOption[] } {
    const session = this.sessions.get(sessionId)
    if (!session) return { options: [], models: [] }
    const models = session.configOptions.filter((option) => option.category === 'model')
    const options = session.configOptions.filter((option) => option.category !== 'model')
    return { options, models }
  }

  getCurrentMode(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.currentModeId ?? null
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.acpSessionId) return
    if (session.capabilities.hasDedicatedSetMode) {
      await this.sendRpcRequest(session, 'session/set_mode', { sessionId: session.acpSessionId, modeId })
    } else {
      // v2 (and any future generation without a dedicated RPC) selects modes
      // through the generic config-option mechanism instead.
      await this.sendRpcRequest(session, 'session/set_config_option', {
        sessionId: session.acpSessionId,
        configId: 'mode',
        value: modeId
      })
    }
  }

  // ==========================================================================
  // Sign-in flow
  //
  // NOTE for future wiring: "stop sibling sessions on logout" orchestration
  // intentionally does NOT live here — that's separate, later work that
  // belongs in agent-manager.ts once it exists. `sessionId` here already
  // identifies one connection/instance cleanly enough to bolt that on later.
  // ==========================================================================

  /** Categorizes one advertised auth method for the sign-in flow / wrapper hooks. */
  private categorizeAuthMethod(method: AcpV1AuthMethod): 'agent' | 'terminal' | 'browser' | 'env_var' {
    const asRecord = method as unknown as Record<string, unknown>
    if (asRecord.type === 'terminal') return 'terminal'
    const id = String(method.id || '')
    if (id === 'env_var' || id.endsWith('-env-var')) return 'env_var'
    if (/browser|oauth|chatgpt|web/i.test(id)) return 'browser'
    return 'agent'
  }

  /** Lists the agent's advertised auth methods with their category, for a session that has already run `initialize`. */
  getAuthMethods(sessionId: string): Array<{ id: string; category: 'agent' | 'terminal' | 'browser' | 'env_var'; name: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    return (session.lastAuthMethods ?? []).map((m) => ({ id: m.id, name: m.name, category: this.categorizeAuthMethod(m) }))
  }

  /**
   * Starts a sign-in flow for the given method category (or auto-selects one
   * via `preferredAuthMethod` when omitted). Every shape is wrapped in a
   * 5-minute timeout; call `cancelSignIn` to abort early. Retrying after a
   * timeout/cancel always starts a brand-new flow — there is no resuming a
   * stale one.
   */
  async startSignIn(
    sessionId: string,
    methodId?: string
  ): Promise<
    | { kind: 'agent'; ok: true }
    | { kind: 'terminal'; command: string; args: string[]; env: Record<string, string> }
    | { kind: 'browser'; url: string }
    | { kind: 'env_var'; envVarNames: string[] }
  > {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const methods = session.lastAuthMethods ?? []
    if (methods.length === 0) throw new Error('No auth methods advertised by agent')

    const chosen = methodId
      ? methods.find((m) => m.id === methodId)
      : this.autoSelectAuthMethod(methods)
    if (!chosen) throw new Error(`Unknown auth method: ${methodId}`)

    const category = this.categorizeAuthMethod(chosen)

    if (category === 'terminal') {
      const terminalMethod = chosen as unknown as { args?: string[]; env?: Record<string, string> }
      return {
        kind: 'terminal',
        command: this.processConfig.command,
        args: [...this.processConfig.args, ...(terminalMethod.args ?? [])],
        env: { ...this.processConfig.env, ...(terminalMethod.env ?? {}) }
      }
    }

    if (category === 'env_var') {
      // No formal ACP field for this; expected names are a heuristic derived
      // from the method id/description until a wrapper hook or a future spec
      // revision gives a authoritative list.
      const asRecord = chosen as unknown as { description?: string }
      const match = asRecord.description ? asRecord.description.match(/[A-Z][A-Z0-9_]{3,}/g) : null
      return { kind: 'env_var', envVarNames: match ?? [`${chosen.id.toUpperCase().replace(/-/g, '_')}`] }
    }

    return this.runTimedAuthFlow(session, chosen.id, category)
  }

  private autoSelectAuthMethod(methods: AcpV1AuthMethod[]): AcpV1AuthMethod | undefined {
    const categories = Array.from(new Set(methods.map((m) => this.categorizeAuthMethod(m))))
    const preferred = this.wrapperHooks.preferredAuthMethod?.({
      availableMethods: categories,
      hasEnvVar: (name: string) => !!process.env[name]
    })
    if (preferred) {
      const match = methods.find((m) => this.categorizeAuthMethod(m) === preferred)
      if (match) return match
    }
    return methods[0]
  }

  private async runTimedAuthFlow(
    session: AcpSession,
    methodId: string,
    category: 'agent' | 'browser'
  ): Promise<{ kind: 'agent'; ok: true } | { kind: 'browser'; url: string }> {
    const AUTH_TIMEOUT_MS = 5 * 60 * 1000
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.pendingAuth = null
        reject(new Error('Sign-in timed out after 5 minutes'))
      }, AUTH_TIMEOUT_MS)

      const authMethod = session.generation === 'v2' ? 'auth/login' : 'authenticate'
      const authParam = session.generation === 'v2' ? { methodId } : { methodId }

      // If the agent requests a URL-mode elicitation mid-flow, surface it as
      // a `browser` result instead of waiting for `authenticate` to resolve —
      // the caller must show consent UI and call `confirmElicitation` before
      // we forward "proceed" back to the agent.
      const browserWait = new Promise<{ kind: 'browser'; url: string }>((resolveBrowser) => {
        session.pendingAuth = {
          kind: 'browser',
          url: '',
          elicitationRequestId: '',
          resolve: () => { /* replaced once the real elicitation request arrives */ }
        }
        session._resolveBrowserWait = resolveBrowser
      })

      this.sendRpcRequest(session, authMethod, authParam)
        .then(() => {
          clearTimeout(timeout)
          session.pendingAuth = null
          resolve({ kind: 'agent', ok: true })
        })
        .catch((error) => {
          clearTimeout(timeout)
          session.pendingAuth = null
          reject(error instanceof Error ? error : new Error(String(error)))
        })

      if (category === 'browser') {
        void browserWait.then((result) => {
          clearTimeout(timeout)
          resolve(result)
        })
      }
    })
  }

  /** Caller confirms (or declines) a pending browser-elicitation sign-in; forwards the decision to the agent. */
  confirmElicitation(sessionId: string, proceed: boolean): void {
    const session = this.sessions.get(sessionId)
    if (!session?.pendingAuth) return
    session.pendingAuth.resolve(proceed)
    session.pendingAuth = null
  }

  cancelSignIn(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.pendingAuth) {
      session.pendingAuth.resolve(false)
      session.pendingAuth = null
    }
  }

  /** After the caller has run the terminal login command to completion, restarts the child and re-verifies with a real `session/new`. */
  async completeTerminalSignIn(sessionId: string, config: SessionConfig): Promise<void> {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.process.kill('SIGTERM')
      this.sessions.delete(sessionId)
    }
    await this.createSession(config)
  }

  // ==========================================================================
  // Private: stdout parsing / RPC dispatch
  // ==========================================================================

  private setupStdoutParser(childProcess: ChildProcess, session: AcpSession): void {
    childProcess.stdout?.on('data', (chunk: Buffer) => {
      session.stdoutBuffer += chunk.toString()
      let newlineIndex: number
      while ((newlineIndex = session.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = session.stdoutBuffer.slice(0, newlineIndex).trim()
        session.stdoutBuffer = session.stdoutBuffer.slice(newlineIndex + 1)
        if (!line) continue
        try {
          const message = JSON.parse(line) as JsonRpcMessage
          this.handleRpcMessage(session, message)
        } catch (error) {
          console.error('[AcpAgentAdapter] Failed to parse JSON-RPC message:', line, error)
        }
      }
    })
  }

  private handleRpcMessage(session: AcpSession, message: JsonRpcMessage): void {
    if (this.debugRpcLogs) {
      console.log('[AcpAgentAdapter] Received RPC message:', JSON.stringify(message))
    }

    // Responses to our own requests
    if ('id' in message && message.id !== undefined && !('method' in message)) {
      const pending = session.pendingRequests.get(message.id)
      const response = message as JsonRpcResponse | JsonRpcError

      if (pending) {
        session.pendingRequests.delete(message.id)
        if ('error' in response && response.error) {
          this.handlePossibleProviderError(session, response.error)
          pending.reject(new Error(response.error.message))
        } else if ('result' in response) {
          pending.resolve(response.result)
        }
        return
      }

      if ('error' in response && response.error) {
        if (this.handlePossibleProviderError(session, response.error)) return
        console.error('[AcpAgentAdapter] Unexpected error response:', response.error)
        const errorEvent = { _isError: true, message: response.error.message, data: response.error.data }
        session.messageBuffer.push(errorEvent)
        this.addToPermanentMessages(session, errorEvent)
        this.onDataAvailable?.(session.sessionId)
        return
      }

      if (session.promptRequestId === message.id && 'result' in response) {
        const result = response.result as Record<string, unknown> | undefined
        if (result?.stopReason) {
          console.log(`[AcpAgentAdapter] Prompt completed with stopReason: ${result.stopReason}`)
          this.reportPromptUsage(session, result)
          session.status = SessionStatusType.IDLE
          session.activeTurnId = null
        }
        return
      }
      return
    }

    // Requests from the agent (session/request_permission, fs/*, terminal/*, extensions)
    if ('method' in message && 'id' in message && message.id !== undefined) {
      void this.handleAgentRequest(session, message as JsonRpcRequest)
      return
    }

    // Notifications from the agent
    if ('method' in message && !('id' in message)) {
      this.handleAgentNotification(session, message as JsonRpcNotification)
    }
  }

  private async handleAgentRequest(session: AcpSession, request: JsonRpcRequest): Promise<void> {
    if (this.debugRpcLogs) console.log(`[AcpAgentAdapter] << Request: ${request.method}`)

    if (request.method === 'session/request_permission') {
      this.handlePermissionRequest(session, request)
      return
    }

    if (request.method === 'fs/read_text_file') {
      await this.handleFsReadRequest(session, request)
      return
    }
    if (request.method === 'fs/write_text_file') {
      await this.handleFsWriteRequest(session, request)
      return
    }

    if (request.method.startsWith('terminal/')) {
      await this.handleTerminalRequest(session, request)
      return
    }

    if (request.method === 'elicitation/create') {
      this.handleElicitationCreate(session, request)
      return
    }

    if (this.wrapperHooks.handleExtensionRequest) {
      try {
        const result = await this.wrapperHooks.handleExtensionRequest(request.method, request.params)
        this.sendRpcResponse(session, request.id, { result })
        return
      } catch (error) {
        this.sendRpcResponse(session, request.id, { error: { code: -32000, message: errMsg(error) } })
        return
      }
    }

    this.sendRpcResponse(session, request.id, { error: { code: -32601, message: `Method not found: ${request.method}` } })
  }

  private handleAgentNotification(session: AcpSession, notification: JsonRpcNotification): void {
    if (this.debugRpcLogs) {
      console.log(`[AcpAgentAdapter] << Notification: ${notification.method}`)
    }

    if (notification.method === 'session/update') {
      const update = (notification.params as { update?: Record<string, unknown> } | undefined)?.update
      if (update?.sessionUpdate === 'usage_update') {
        const cost = acpUsageUpdateCostUsd(update)
        if (cost !== null) session.usageCostUsd = cost
        return
      }
      if (update?.sessionUpdate === 'config_option_update') {
        session.configOptions = (update.configOptions as AcpV1SessionConfigOption[]) ?? []
        return
      }
      if (update?.sessionUpdate === 'current_mode_update') {
        session.currentModeId = (update.currentModeId as string) ?? null
        return
      }
      if (update?.sessionUpdate === 'available_commands_update') {
        session.availableCommands = (update.availableCommands as unknown[]) ?? []
        // Deliberately no message parts: matches existing turn-detection
        // behavior where non-content updates must not fragment a response.
        return
      }
      if (update?.sessionUpdate === 'compaction_update' || update?.sessionUpdate === 'compaction_summary_chunk') {
        // No UI surface for compaction yet — log only so it isn't silently lost.
        console.log(`[AcpAgentAdapter] Compaction update (${update.sessionUpdate}):`, JSON.stringify(update).slice(0, 300))
        return
      }
    }

    if (this.wrapperHooks.handleExtensionNotification) {
      const result = this.wrapperHooks.handleExtensionNotification(notification.method, notification.params)
      if (result?.retryClass) {
        this.handleRetryClassification(session, result.retryClass, notification.method)
        return
      }
    }

    session.messageBuffer.push(notification)
    this.addToPermanentMessages(session, notification)
    this.onDataAvailable?.(session.sessionId)
    this.updateSessionStatus(session, notification)
  }

  /** Folds a wrapper-classified retry into the same usage-limit/retry channel a classified error would use. */
  private handleRetryClassification(session: AcpSession, retryClass: AcpErrorClass, source: string): void {
    console.warn(`[AcpAgentAdapter] ${source} classified as ${retryClass}; treating as a transient provider retry`)
    if (retryClass === 'rate-limit' || retryClass === 'usage-limit') {
      session.usageLimit = { resetAt: null }
      session.status = SessionStatusType.RETRY
    }
  }

  /**
   * Checks an RPC error for a provider quota/rate-limit signal, either via
   * `classifyError` (wrapper hook, falling back to a generic pattern match
   * on "rate limit"/"usage limit"/"quota" wording) or a reserved
   * auth-required error code for the negotiated generation. Returns true
   * when the error was fully handled (pushed to the live buffer) here.
   */
  private handlePossibleProviderError(session: AcpSession, error: { code: number; message: string; data?: unknown }): boolean {
    const classification = this.wrapperHooks.classifyError?.(new Error(error.message)) ?? classifyErrorGeneric(error.message)
    if (!classification) return false

    const userMessage = classification === 'rate-limit'
      ? `Rate limit reached: ${error.message}. Please wait a moment before trying again.`
      : classification === 'usage-limit'
        ? `Quota exceeded: ${error.message}. Please check your plan and billing details to continue.`
        : `Provider error: ${error.message}`

    console.warn(`[AcpAgentAdapter] Provider error (${classification}):`, userMessage)
    session.status = SessionStatusType.ERROR
    session.lastError = userMessage
    session.activeTurnId = null
    if (classification === 'rate-limit' || classification === 'usage-limit') {
      session.usageLimit = { resetAt: null }
    }

    // Transient: live buffer only, never permanent history (see historical
    // rationale in the original adapter — a stale quota message must not
    // survive a resume once the window resets or the user re-authenticates).
    const errorEvent = { _isError: true, message: userMessage, data: null }
    session.messageBuffer.push(errorEvent)
    this.onDataAvailable?.(session.sessionId)
    return true
  }

  private updateSessionStatus(session: AcpSession, notification: JsonRpcNotification): void {
    if (notification.method === 'session/update') {
      const update = (notification.params as { update?: SessionUpdate })?.update
      if (!update) return
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        session.status = SessionStatusType.BUSY
      } else if (update.sessionUpdate === 'error' || update.sessionUpdate === 'failed') {
        session.status = SessionStatusType.ERROR
      } else if (update.sessionUpdate === 'completed' || update.sessionUpdate === 'finished') {
        session.status = SessionStatusType.IDLE
      }
    } else if (notification.method.includes('completed') || notification.method.includes('finished')) {
      session.status = SessionStatusType.IDLE
    } else if (notification.method.includes('error') || notification.method.includes('failed')) {
      session.status = SessionStatusType.ERROR
    } else if (notification.method.includes('started') || notification.method.includes('working')) {
      session.status = SessionStatusType.BUSY
    }
  }

  // ==========================================================================
  // fs/* — gated by enableFs, scoped strictly to config.workspaceDir
  // ==========================================================================

  /** Resolves `candidatePath` and asserts its real path is contained within `rootDir` (resolves symlinks). */
  private async assertWithinWorkspace(rootDir: string, candidatePath: string): Promise<string> {
    if (!isAbsolute(candidatePath)) {
      throw new Error(`Path must be absolute: ${candidatePath}`)
    }
    const realRoot = await realpathAsync(rootDir)
    let realCandidate: string
    try {
      realCandidate = await realpathAsync(candidatePath)
    } catch {
      // File may not exist yet (write case) — fall back to resolving its
      // parent directory's real path and re-attaching the file name.
      const parent = resolvePath(candidatePath, '..')
      const realParent = await realpathAsync(parent)
      realCandidate = resolvePath(realParent, candidatePath.slice(parent.length + 1))
    }
    const rel = relative(realRoot, realCandidate)
    if (rel.startsWith('..') || resolvePath(realRoot, rel) !== realCandidate) {
      throw new Error(`Path escapes the session workspace: ${candidatePath}`)
    }
    return realCandidate
  }

  private async handleFsReadRequest(session: AcpSession, request: JsonRpcRequest): Promise<void> {
    if (!this.enableFs) {
      this.sendRpcResponse(session, request.id, { error: { code: -32601, message: 'fs capability is disabled' } })
      return
    }
    const params = request.params as { path?: string; line?: number; limit?: number } | undefined
    try {
      const safePath = await this.assertWithinWorkspace(session.config.workspaceDir, params?.path ?? '')
      const { readFile } = await import('fs/promises')
      let content = await readFile(safePath, 'utf-8')
      if (params?.line || params?.limit) {
        const lines = content.split('\n')
        const start = Math.max(0, (params.line ?? 1) - 1)
        const end = params.limit ? start + params.limit : lines.length
        content = lines.slice(start, end).join('\n')
      }
      this.sendRpcResponse(session, request.id, { result: { content } })
    } catch (error) {
      this.sendRpcResponse(session, request.id, { error: { code: -32000, message: errMsg(error) } })
    }
  }

  private async handleFsWriteRequest(session: AcpSession, request: JsonRpcRequest): Promise<void> {
    if (!this.enableFs) {
      this.sendRpcResponse(session, request.id, { error: { code: -32601, message: 'fs capability is disabled' } })
      return
    }
    const params = request.params as { path?: string; content?: string } | undefined
    try {
      const safePath = await this.assertWithinWorkspace(session.config.workspaceDir, params?.path ?? '')
      const { writeFile } = await import('fs/promises')
      await writeFile(safePath, params?.content ?? '', 'utf-8')
      this.sendRpcResponse(session, request.id, { result: {} })
    } catch (error) {
      this.sendRpcResponse(session, request.id, { error: { code: -32000, message: errMsg(error) } })
    }
  }

  // ==========================================================================
  // terminal/* — gated by enableTerminal, off by default. When enabled,
  // spawns REAL processes on the user's machine on the agent's behalf.
  // ==========================================================================

  private async handleTerminalRequest(session: AcpSession, request: JsonRpcRequest): Promise<void> {
    if (!this.enableTerminal) {
      this.sendRpcResponse(session, request.id, { error: { code: -32601, message: 'terminal capability is disabled' } })
      return
    }
    const params = request.params as Record<string, unknown> | undefined

    switch (request.method) {
      case 'terminal/create': {
        const command = String(params?.command ?? '')
        const args = Array.isArray(params?.args) ? (params?.args as string[]) : []
        const cwd = typeof params?.cwd === 'string' ? params.cwd : session.config.workspaceDir
        const terminalId = randomUUID()
        const child = spawn(command, args, { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] })
        guardChildStreams(child, '[AcpAgentAdapter/terminal]')
        const entry: AcpTerminalProcess = { process: child, stdout: '', stderr: '', exitCode: null, exitSignal: null, exited: false }
        child.stdout?.on('data', (chunk: Buffer) => { entry.stdout += chunk.toString() })
        child.stderr?.on('data', (chunk: Buffer) => { entry.stderr += chunk.toString() })
        child.on('exit', (code, signal) => { entry.exited = true; entry.exitCode = code; entry.exitSignal = signal })
        session.terminals.set(terminalId, entry)
        this.sendRpcResponse(session, request.id, { result: { terminalId } })
        return
      }
      case 'terminal/output': {
        const entry = session.terminals.get(String(params?.terminalId ?? ''))
        if (!entry) { this.sendRpcResponse(session, request.id, { error: { code: -32000, message: 'Unknown terminal' } }); return }
        this.sendRpcResponse(session, request.id, {
          result: { output: entry.stdout + entry.stderr, exitStatus: entry.exited ? { exitCode: entry.exitCode, signal: entry.exitSignal } : null }
        })
        return
      }
      case 'terminal/wait_for_exit': {
        const entry = session.terminals.get(String(params?.terminalId ?? ''))
        if (!entry) { this.sendRpcResponse(session, request.id, { error: { code: -32000, message: 'Unknown terminal' } }); return }
        if (entry.exited) {
          this.sendRpcResponse(session, request.id, { result: { exitCode: entry.exitCode, signal: entry.exitSignal } })
        } else {
          entry.process.once('exit', (code, signal) => {
            this.sendRpcResponse(session, request.id, { result: { exitCode: code, signal } })
          })
        }
        return
      }
      case 'terminal/kill': {
        const entry = session.terminals.get(String(params?.terminalId ?? ''))
        entry?.process.kill('SIGTERM')
        this.sendRpcResponse(session, request.id, { result: {} })
        return
      }
      case 'terminal/release': {
        session.terminals.delete(String(params?.terminalId ?? ''))
        this.sendRpcResponse(session, request.id, { result: {} })
        return
      }
      default:
        this.sendRpcResponse(session, request.id, { error: { code: -32601, message: `Method not found: ${request.method}` } })
    }
  }

  // ==========================================================================
  // elicitation/create — used here specifically to detect URL-mode
  // (browser) sign-in prompts mid-authenticate call.
  // ==========================================================================

  private handleElicitationCreate(session: AcpSession, request: JsonRpcRequest): void {
    const params = request.params as { url?: string; mode?: string } | undefined
    const url = params?.url
    if (url && session.pendingAuth) {
      const resolveBrowserWait = session._resolveBrowserWait
      session.pendingAuth = {
        kind: 'browser',
        url,
        elicitationRequestId: request.id,
        resolve: (proceed: boolean) => {
          this.sendRpcResponse(session, request.id, {
            result: proceed ? { action: 'accept' } : { action: 'decline' }
          })
        }
      }
      resolveBrowserWait?.({ kind: 'browser', url })
      return
    }
    // No pending auth flow waiting on this — decline politely rather than
    // hanging the agent's request indefinitely.
    this.sendRpcResponse(session, request.id, { result: { action: 'decline' } })
  }

  // ==========================================================================
  // Authentication (automatic, at session creation)
  // ==========================================================================

  private async authenticateSession(session: AcpSession, initResult: Record<string, unknown>): Promise<void> {
    const authMethods = (Array.isArray(initResult.authMethods) ? initResult.authMethods : []) as AcpV1AuthMethod[]
    session.lastAuthMethods = authMethods
    if (authMethods.length === 0) {
      console.log('[AcpAgentAdapter] No auth methods advertised by agent (already authenticated)')
      return
    }

    const chosen = this.autoSelectAuthMethod(authMethods)
    if (!chosen) {
      console.log('[AcpAgentAdapter] No usable auth method found; skipping authenticate')
      return
    }
    const category = this.categorizeAuthMethod(chosen)
    if (category === 'terminal' || category === 'env_var') {
      // These require out-of-band action from the caller; createSession does
      // not block on them. The caller should use getAuthMethods/startSignIn
      // ahead of session creation when the agent needs explicit sign-in.
      console.log(`[AcpAgentAdapter] Auth method ${chosen.id} needs out-of-band sign-in (${category}); skipping auto-authenticate`)
      return
    }

    console.log(`[AcpAgentAdapter] Authenticating with method: ${chosen.id}`)
    try {
      const method = session.generation === 'v2' ? 'auth/login' : 'authenticate'
      await this.sendRpcRequest(session, method, { methodId: chosen.id })
    } catch (error) {
      console.warn(`[AcpAgentAdapter] authenticate failed: ${errMsg(error)}`)
    }
  }

  // ==========================================================================
  // Usage reporting (generic — no longer gated to any one agent)
  // ==========================================================================

  private reportPromptUsage(session: AcpSession, result: Record<string, unknown>): void {
    if (this.onUsage) {
      try {
        const bucket = normalizeAcpPromptUsage(result.usage, session.config.model || 'auto', session.usageCostUsd)
        if (bucket && session.acpSessionId) {
          this.onUsage({
            provider: 'acp',
            providerSessionId: session.acpSessionId,
            taskId: session.config.taskId,
            agentId: session.config.agentId,
            newSession: session.createdInApp,
            buckets: [bucket]
          })
        }
      } catch (error) {
        console.warn('[AcpAgentAdapter] Failed to report token usage:', error)
      }
    }
    // Throttled background refresh of plan limits (generic — only produces a
    // real snapshot when `probeUsageLimits` has been overridden for this
    // instance; the default implementation always resolves to null).
    if (this.onUsageLimits && !this.limitsRead && Date.now() - this.lastLimitsReadAt >= 5 * 60 * 1000) {
      this.lastLimitsReadAt = Date.now()
      const pending = this.probeUsageLimits().finally(() => { this.limitsRead = null })
      this.limitsRead = pending
      void pending.then((limits) => {
        if (limits && limits.windows.length > 0) this.onUsageLimits?.({ kind: 'snapshot', limits })
      })
    }
  }

  // ==========================================================================
  // RPC send helpers
  // ==========================================================================

  private async sendRpcRequest(session: AcpSession, method: string, params?: unknown): Promise<unknown> {
    const id = session.nextRequestId++
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      session.pendingRequests.set(id, { resolve, reject })
      const jsonString = JSON.stringify(request) + '\n'
      session.process.stdin?.write(jsonString, (error) => {
        if (error) {
          session.pendingRequests.delete(id)
          reject(new Error(`Failed to send request: ${error.message}`))
        }
      })
      setTimeout(() => {
        if (session.pendingRequests.has(id)) {
          session.pendingRequests.delete(id)
          reject(new Error(`Request timeout: ${method}`))
        }
      }, 30000)
    })
  }

  private sendRpcRequestNoWait(session: AcpSession, method: string, params?: unknown): void {
    const id = session.nextRequestId++
    if (method === 'session/prompt') session.promptRequestId = id
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    const jsonString = JSON.stringify(request) + '\n'
    session.process.stdin?.write(jsonString, (error) => {
      if (error) console.error(`[AcpAgentAdapter] Error sending ${method}:`, error)
    })
  }

  private sendRpcResponse(session: AcpSession, id: string | number, response: { result?: unknown; error?: { code: number; message: string; data?: unknown } }): void {
    const rpcResponse: JsonRpcResponse | JsonRpcError = {
      jsonrpc: '2.0',
      id,
      ...(response.error ? { error: response.error } : { result: response.result })
    } as JsonRpcResponse | JsonRpcError
    const jsonString = JSON.stringify(rpcResponse) + '\n'
    session.process.stdin?.write(jsonString, (error) => {
      if (error) console.error('[AcpAgentAdapter] Error sending response:', error)
    })
  }

  private sendRpcNotification(session: AcpSession, method: string, params?: unknown): void {
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    const jsonString = JSON.stringify(notification) + '\n'
    session.process.stdin?.write(jsonString, (error) => {
      if (error) console.error(`[AcpAgentAdapter] Error sending notification ${method}:`, error)
    })
  }

  private handlePermissionRequest(session: AcpSession, request: JsonRpcRequest): void {
    const params = request.params as {
      toolCall?: { rawInput?: { reason?: string }; content?: Array<{ content?: { text?: string } }>; title?: string; kind?: string; toolCallId?: string }
      options?: Array<{ optionId: string; name: string; kind: string }>
    } | undefined

    const toolCall = params?.toolCall
    const options = params?.options || []
    const question = toolCall?.rawInput?.reason || toolCall?.content?.[0]?.content?.text || `Execute: ${toolCall?.title || 'unknown command'}`

    console.log(`[AcpAgentAdapter] Permission request: ${question}`)
    const approvalOptions = options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }))

    if (session.config.permissionMode === 'allow') {
      const autoApprovedOptionId = approvalOptions.find((o) => o.optionId === 'approved-for-session')?.optionId
        || approvalOptions.find((o) => o.optionId === 'allow-always')?.optionId
        || approvalOptions.find((o) => o.optionId === 'approved')?.optionId
        || 'approved'
      console.log(`[AcpAgentAdapter] Auto-approving permission with: ${autoApprovedOptionId}`)
      this.sendRpcResponse(session, request.id, { result: { outcome: { outcome: 'selected', optionId: autoApprovedOptionId } } })
      return
    }

    session.pendingApproval = { requestId: request.id, toolCallId: toolCall?.toolCallId || '', question, options: approvalOptions }
    session.status = SessionStatusType.WAITING_APPROVAL
    console.log('[AcpAgentAdapter] Awaiting user approval...')
  }

  private extractAcpSessionId(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null
    const obj = result as Record<string, unknown>
    return (obj.sessionId || obj.session_id || obj.id) as string | null
  }

  /**
   * Converts the internal McpServerConfig map into the ACP-spec McpServer
   * array. `stdio` entries are always injected (every ACP agent must support
   * stdio). `http`/`sse` entries are injected only when the negotiated
   * agent capabilities advertise that transport; otherwise that one entry
   * is skipped (with a warning) rather than failing the whole session.
   */
  private convertMcpServers(servers: Record<string, McpServerConfig> | undefined, session: AcpSession): AcpV1McpServer[] {
    if (!servers) return []
    const result: AcpV1McpServer[] = []
    for (const [name, config] of Object.entries(servers)) {
      if (config.type === 'stdio') {
        const envArray = config.env ? Object.entries(config.env).map(([k, v]) => ({ name: k, value: v })) : []
        result.push({ name, command: config.command ?? '', args: config.args || [], env: envArray } as AcpV1McpServer)
        continue
      }
      if (config.type === 'http' && !session.capabilities.mcpHttp) {
        console.warn(`[AcpAgentAdapter] Skipping MCP server "${name}": agent does not advertise http MCP transport support`)
        continue
      }
      if (config.type === 'sse' && !session.capabilities.mcpSse) {
        console.warn(`[AcpAgentAdapter] Skipping MCP server "${name}": agent does not advertise sse MCP transport support`)
        continue
      }
      const headersArray = config.headers ? Object.entries(config.headers).map(([k, v]) => ({ name: k, value: v })) : []
      result.push({ type: config.type, name, url: config.url ?? '', headers: headersArray } as AcpV1McpServer)
    }
    return result
  }

  // ==========================================================================
  // Permanent message history (unchanged proven pruning/consolidation logic)
  // ==========================================================================

  private addToPermanentMessages(session: AcpSession, event: unknown): void {
    const notification = event as JsonRpcNotification
    const lastMsg = session.permanentMessages[session.permanentMessages.length - 1] as JsonRpcNotification | undefined
    let consolidated = false

    if (lastMsg?.method === 'session/update' && notification.method === 'session/update') {
      const lastParams = lastMsg.params as { update?: SessionUpdate } | undefined
      const nextParams = notification.params as { update?: SessionUpdate } | undefined
      const lastUpdate = lastParams?.update
      const nextUpdate = nextParams?.update
      if (lastUpdate && nextUpdate && lastUpdate.sessionUpdate === nextUpdate.sessionUpdate && this.isAssistantChunkUpdateType(nextUpdate.sessionUpdate)) {
        const lastText = this.extractTextFromUpdateContent(lastUpdate.content)
        const nextText = this.extractTextFromUpdateContent(nextUpdate.content)
        if (typeof lastUpdate.content === 'object' && lastUpdate.content !== null) {
          (lastUpdate.content as Record<string, unknown>).text = this.mergeStreamingText(lastText, nextText)
          consolidated = true
        }
      }
    }

    if (!consolidated) {
      const stored = structuredClone(notification)
      if (stored.method === 'session/update') {
        const update = (stored.params as { update?: SessionUpdate })?.update
        if (update?.rawOutput && typeof update.rawOutput === 'object') {
          const ro = update.rawOutput as Record<string, unknown>
          const MAX_HISTORY_OUTPUT_CHARS = 100_000
          if (typeof ro.stdout === 'string' && ro.stdout.length > MAX_HISTORY_OUTPUT_CHARS) {
            ro.stdout = ro.stdout.slice(0, MAX_HISTORY_OUTPUT_CHARS) + '\n... (truncated in history)'
          }
          if (typeof ro.formatted_output === 'string' && ro.formatted_output.length > MAX_HISTORY_OUTPUT_CHARS) {
            ro.formatted_output = ro.formatted_output.slice(0, MAX_HISTORY_OUTPUT_CHARS) + '\n... (truncated in history)'
          }
        }
      }
      ;(stored as unknown as Record<string, unknown>)._receivedAt = Date.now()
      session.permanentMessages.push(stored)
    }

    if (session.permanentMessages.length > AcpAgentAdapter.MAX_PERMANENT_MESSAGES) {
      session.permanentMessages.splice(0, Math.ceil(AcpAgentAdapter.MAX_PERMANENT_MESSAGES * 0.25))
    }
  }

  private extractTextFromUpdateContent(content: SessionUpdate['content']): string {
    if (!content) return ''
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map((entry) => this.extractTextFromUpdateContent(entry)).filter(Boolean).join('\n')
    if (typeof content !== 'object') return ''
    const value = content as Record<string, unknown>
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
    if (value.content) {
      const nestedContent = this.extractTextFromUpdateContent(value.content as SessionUpdate['content'])
      if (nestedContent) return nestedContent
    }
    if (value.message) {
      const nestedMessage = this.extractTextFromUpdateContent(value.message as SessionUpdate['content'])
      if (nestedMessage) return nestedMessage
    }
    return ''
  }

  private mergeStreamingText(currentText: string, incomingChunk: string): string {
    if (!currentText) return incomingChunk
    if (!incomingChunk) return currentText
    if (incomingChunk.startsWith(currentText)) return incomingChunk
    if (currentText.endsWith(incomingChunk)) return currentText

    const MIN_OVERLAP_CHARS = 8
    const maxSkippedPrefix = Math.min(32, currentText.length - MIN_OVERLAP_CHARS)
    for (let skipped = 1; skipped <= maxSkippedPrefix; skipped++) {
      const replayedText = currentText.slice(skipped)
      if (incomingChunk.startsWith(replayedText)) return currentText.slice(0, skipped) + incomingChunk
    }

    const maxOverlap = Math.min(currentText.length, incomingChunk.length)
    for (let length = maxOverlap; length > 0; length--) {
      if (length >= MIN_OVERLAP_CHARS && currentText.endsWith(incomingChunk.slice(0, length))) {
        return currentText + incomingChunk.slice(length)
      }
    }
    return currentText + incomingChunk
  }

  private isUserUpdateType(sessionUpdate?: string | null): boolean {
    return sessionUpdate === 'user_message_chunk' || sessionUpdate === 'human_message_chunk' || sessionUpdate === 'user_message' || sessionUpdate === 'human_message'
  }

  private isAssistantChunkUpdateType(sessionUpdate?: string | null): boolean {
    return sessionUpdate === 'agent_message_chunk' || sessionUpdate === 'assistant_message_chunk' || sessionUpdate === 'agent_thought_chunk'
  }

  private isToolingUpdateType(sessionUpdate?: string | null): boolean {
    return sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update'
  }

  private getAssistantTurnId(session: AcpSession): number {
    const now = Date.now()
    const previousType = session.lastSessionUpdateType
    const mustSplitAfterTool = session.pendingAssistantTurnSplit

    if (session.activeTurnId && !mustSplitAfterTool && !this.isToolingUpdateType(previousType) && !this.isUserUpdateType(previousType)) {
      session.lastChunkTime = now
      return session.activeTurnId
    }

    const timeSinceLastChunk = session.lastChunkTime ? now - session.lastChunkTime : Infinity
    const TIME_GAP_THRESHOLD = 2000
    const shouldStartNewTurn = session.currentTurnId === 0
      || mustSplitAfterTool
      || this.isUserUpdateType(previousType)
      || this.isToolingUpdateType(previousType)
      || (this.isAssistantChunkUpdateType(previousType) && timeSinceLastChunk > TIME_GAP_THRESHOLD)

    if (shouldStartNewTurn) {
      session.currentTurnId += 1
    }
    session.pendingAssistantTurnSplit = false
    if (session.activeTurnId) session.activeTurnId = session.currentTurnId
    session.lastChunkTime = now
    return session.currentTurnId
  }

  private getUserTurnId(session: AcpSession): number {
    if (!this.isUserUpdateType(session.lastSessionUpdateType)) {
      session.currentUserTurnId += 1
    }
    return session.currentUserTurnId
  }

  private normalizeToolName(rawToolName?: string): string {
    switch (rawToolName) {
      case 'exec_command': return 'command'
      case 'write_stdin': return 'stdin'
      case 'update_plan': return 'plan'
      default: return rawToolName || 'tool'
    }
  }

  private buildToolTitle(rawToolName?: string, rawInput?: Record<string, unknown>, fallback?: string): string | undefined {
    const trimmedFallback = fallback?.trim()
    switch (rawToolName) {
      case 'exec_command': {
        const command = rawInput?.command
        if (Array.isArray(command)) return command.join(' ') || trimmedFallback
        if (typeof command === 'string' && command.trim()) return command.trim()
        const cmd = typeof rawInput?.cmd === 'string' ? rawInput.cmd.trim() : ''
        if (cmd) return cmd
        return trimmedFallback
      }
      case 'write_stdin': {
        const chars = typeof rawInput?.chars === 'string' ? rawInput.chars.trim() : ''
        if (chars) return chars.replace(/\s+/g, ' ').slice(0, 80)
        return 'poll'
      }
      case 'update_plan': {
        const plan = Array.isArray(rawInput?.plan) ? rawInput.plan : []
        const firstStep = plan.find((item): item is { step: string } => typeof item === 'object' && item !== null && typeof (item as { step?: unknown }).step === 'string')
        if (firstStep) return `${plan.length} steps: ${firstStep.step}`
        const explanation = typeof rawInput?.explanation === 'string' ? rawInput.explanation.trim() : ''
        if (explanation) return explanation.slice(0, 80)
        return trimmedFallback
      }
      default:
        return trimmedFallback
    }
  }

  private convertAcpEventToMessageParts(
    event: unknown,
    _seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    session?: AcpSession
  ): MessagePart[] {
    const parts: MessagePart[] = []
    const wrappedEvent = event as Record<string, unknown>
    const actualEvent = (wrappedEvent._notification || event) as Record<string, unknown>

    if (actualEvent._isError) {
      const errorId = `error-${Date.now()}`
      if (!seenPartIds.has(errorId)) {
        seenPartIds.add(errorId)
        parts.push({ id: errorId, type: MessagePartType.TEXT, text: `Error: ${actualEvent.message}${actualEvent.data ? ` - ${actualEvent.data}` : ''}`, role: 'assistant' })
      }
      return parts
    }

    const notification = actualEvent as unknown as JsonRpcNotification
    if (notification.method !== 'session/update') return parts

    const params = notification.params as { update?: SessionUpdate }
    const update = params?.update
    if (!update) return []

    const partId = update.toolCallId || randomUUID()

    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      if (session) session.pendingAssistantTurnSplit = true

      const rawInput = update.rawInput as { cmd?: string; command?: string | string[]; parsed_cmd?: Array<{ cmd?: string }>; tool?: string; server?: string } | undefined

      if (update.status !== 'completed' && session && partId) {
        const commandFromInput = Array.isArray(rawInput?.command) ? rawInput.command.join(' ') : rawInput?.command
        const commandFromCmd = rawInput?.cmd
        const commandFromParsed = rawInput?.parsed_cmd?.map((c) => c.cmd).join('; ')
        const cachedInput = commandFromInput || commandFromCmd || commandFromParsed || update.title || ''
        const toolFromRawInput = rawInput?.tool ? (rawInput.server ? `${rawInput.server}/${rawInput.tool}` : rawInput.tool) : undefined
        const toolFromTitle = update.title?.startsWith('Tool: ') ? update.title.slice(6) : undefined
        const cachedName = update.kind || toolFromRawInput || toolFromTitle || ''
        const cachedTitle = this.buildToolTitle(cachedName || update.title, rawInput as Record<string, unknown>, cachedInput)
        if (cachedName || cachedInput || cachedTitle) {
          if (session.toolCallMetadata.size >= AcpAgentAdapter.MAX_TOOL_CALL_METADATA) {
            const toEvict = Math.ceil(AcpAgentAdapter.MAX_TOOL_CALL_METADATA * 0.5)
            let evicted = 0
            for (const key of session.toolCallMetadata.keys()) {
              if (evicted >= toEvict) break
              session.toolCallMetadata.delete(key)
              evicted++
            }
          }
          session.toolCallMetadata.set(partId, { name: cachedName, input: cachedInput, title: cachedTitle })
        }

        if (!seenPartIds.has(partId)) {
          seenPartIds.add(partId)
          const inProgressToolName = this.normalizeToolName(cachedName || update.title || 'tool')
          parts.push({ id: partId, type: MessagePartType.TOOL, tool: { name: inProgressToolName, title: cachedTitle, status: 'running', input: cachedInput || undefined } })
        }
      }

      if (update.status === 'completed') {
        const alreadySeen = seenPartIds.has(partId)
        seenPartIds.add(partId)
        const cachedMeta = session?.toolCallMetadata.get(partId)
        const rawOutput = update.rawOutput as { command?: string | string[]; stdout?: string; stderr?: string; formatted_output?: string; content?: Array<{ text?: string; type?: string }>; isError?: boolean } | undefined

        const commandFromInput = Array.isArray(rawInput?.command) ? rawInput.command.join(' ') : rawInput?.command
        const commandFromCmd = rawInput?.cmd
        const commandFromOutput = Array.isArray(rawOutput?.command) ? rawOutput.command.join(' ') : rawOutput?.command
        const commandFromParsed = rawInput?.parsed_cmd?.map((c) => c.cmd).join('; ')
        const contentArray = update.content as Array<{ type?: string; content?: { type?: string; text?: string }; text?: string }> | undefined
        const inputFromContent = Array.isArray(contentArray) ? contentArray.map((c) => c.content?.text || c.text || '').filter(Boolean).join('\n') : undefined
        const command = commandFromInput || commandFromCmd || commandFromOutput || commandFromParsed || update.title || cachedMeta?.input || inputFromContent || 'Unknown'

        const outputFromContent = Array.isArray(rawOutput?.content) ? rawOutput.content.map((c) => c.text || '').filter(Boolean).join('\n') : undefined
        const output = rawOutput?.formatted_output || rawOutput?.stdout || rawOutput?.stderr || outputFromContent || ''

        if (session) session.toolCallMetadata.delete(partId)

        const completedToolFromTitle = update.title?.startsWith('Tool: ') ? update.title.slice(6) : undefined
        const rawToolName = update.kind || cachedMeta?.name || completedToolFromTitle || update.title || 'tool'
        const toolName = this.normalizeToolName(rawToolName)
        const toolTitle = this.buildToolTitle(rawToolName, rawInput as Record<string, unknown> | undefined, cachedMeta?.title || (command && command !== rawToolName ? command : undefined))

        parts.push({
          id: partId,
          type: MessagePartType.TOOL,
          tool: { name: toolName, title: toolTitle, status: update.status, input: command, output },
          update: alreadySeen
        })
      }
    } else if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'assistant_message_chunk') {
      const turnId = session ? this.getAssistantTurnId(session) : 0
      const messageId = turnId > 0 ? `agent-response-${turnId}` : 'agent-response'
      const chunk = this.extractTextFromUpdateContent(update.content)
      if (chunk) {
        const currentText = partContentLengths.get(messageId) || ''
        const newText = this.mergeStreamingText(currentText, chunk)
        partContentLengths.set(messageId, newText)
        parts.push({ id: messageId, type: MessagePartType.TEXT, text: newText, role: 'assistant', update: seenPartIds.has(messageId) })
        seenPartIds.add(messageId)
      }
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      const turnId = session ? this.getAssistantTurnId(session) : 0
      const thinkingId = turnId > 0 ? `agent-thinking-${turnId}` : 'agent-thinking'
      const chunk = this.extractTextFromUpdateContent(update.content)
      if (chunk) {
        const currentText = partContentLengths.get(thinkingId) || ''
        const newText = this.mergeStreamingText(currentText, chunk)
        partContentLengths.set(thinkingId, newText)
        parts.push({ id: thinkingId, type: MessagePartType.REASONING, text: newText, role: 'assistant', update: seenPartIds.has(thinkingId) })
        seenPartIds.add(thinkingId)
      }
    } else if (update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'human_message_chunk') {
      const turnId = session ? this.getUserTurnId(session) : 0
      const userId = turnId > 0 ? `user-message-${turnId}` : 'user-message'
      const chunk = this.extractTextFromUpdateContent(update.content)
      if (chunk) {
        const currentText = partContentLengths.get(userId) || ''
        const newText = this.mergeStreamingText(currentText, chunk)
        partContentLengths.set(userId, newText)
        parts.push({ id: userId, type: MessagePartType.TEXT, text: newText, role: 'user', update: seenPartIds.has(userId) })
        seenPartIds.add(userId)
      }
    } else if (
      update.sessionUpdate === 'agent_message' || update.sessionUpdate === 'assistant_message'
      || update.sessionUpdate === 'user_message' || update.sessionUpdate === 'human_message'
    ) {
      const text = this.extractTextFromUpdateContent(update.content)
      if (!text) return parts
      const role = update.sessionUpdate === 'user_message' || update.sessionUpdate === 'human_message' ? 'user' : 'assistant'

      let partId2: string
      if (update.messageId) {
        partId2 = update.messageId
      } else if (role === 'assistant' && session) {
        const turnId = this.getAssistantTurnId(session)
        partId2 = turnId > 0 ? `agent-response-${turnId}` : 'agent-response'
      } else {
        partId2 = `${update.sessionUpdate}-${randomUUID()}`
      }

      const alreadySeen = seenPartIds.has(partId2)
      if (!alreadySeen) {
        seenPartIds.add(partId2)
        partContentLengths.set(partId2, text)
        parts.push({ id: partId2, type: MessagePartType.TEXT, text, role })
      } else if (role === 'assistant') {
        const existingText = partContentLengths.get(partId2) || ''
        if (text.length > existingText.length) {
          partContentLengths.set(partId2, text)
          parts.push({ id: partId2, type: MessagePartType.TEXT, text, role, update: true })
        }
      }
    } else if (update.sessionUpdate === 'plan') {
      // Map into the existing todo/plan convention (`tool.todos`) the
      // renderer already knows how to display (see claude-code-adapter.ts).
      const entries = update.entries || []
      const planPartId = 'plan'
      const alreadySeenPlan = seenPartIds.has(planPartId)
      seenPartIds.add(planPartId)
      parts.push({
        id: planPartId,
        type: 'todowrite' as MessagePartType,
        tool: {
          name: 'plan',
          todos: entries.map((e, i) => ({ id: `plan-${i}`, content: e.content, status: e.status, priority: e.priority }))
        },
        update: alreadySeenPlan
      })
    }

    if (session && update.sessionUpdate) {
      const isTurnRelevant = this.isAssistantChunkUpdateType(update.sessionUpdate)
        || this.isToolingUpdateType(update.sessionUpdate)
        || this.isUserUpdateType(update.sessionUpdate)
        || update.sessionUpdate === 'agent_message'
        || update.sessionUpdate === 'assistant_message'
      if (isTurnRelevant) session.lastSessionUpdateType = update.sessionUpdate
    }

    return parts
  }
}

// ============================================================================
// Free functions
// ============================================================================

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Generic fallback when no wrapper hook classifies a prompt/turn failure. */
function classifyErrorGeneric(message: string): AcpErrorClass | undefined {
  const text = message.toLowerCase()
  if (text.includes('rate limit') || text.includes('too many requests')) return 'rate-limit'
  if (text.includes('usage limit') || text.includes('quota')) return 'usage-limit'
  return undefined
}

/**
 * Decides which ACP generation an `initialize` response belongs to from its
 * shape. v2 responses carry a required `info` field and an optional
 * `capabilities` field; v1 responses carry `agentCapabilities` and an
 * optional, nullable `agentInfo`. The numeric `protocolVersion` is
 * deliberately NOT used as the decision signal — it's only a hint an agent
 * could misreport.
 */
export function detectAcpGeneration(initResult: Record<string, unknown>): AcpGeneration {
  const hasV2Shape = initResult.info !== undefined || (initResult.capabilities !== undefined && initResult.agentCapabilities === undefined)
  return hasV2Shape ? 'v2' : 'v1'
}

function deriveNegotiatedCapabilities(generation: AcpGeneration, initResult: Record<string, unknown>): AcpNegotiatedCapabilities {
  const raw = (generation === 'v2' ? initResult.capabilities : initResult.agentCapabilities) as (AcpV1AgentCapabilities & Partial<AcpV2InitializeResponse['capabilities']>) | undefined
  const mcp = raw?.mcpCapabilities as { http?: boolean; sse?: boolean } | undefined
  const prompt = raw?.promptCapabilities as { image?: boolean } | undefined
  return {
    canResume: generation === 'v2' ? true : !!raw?.loadSession,
    mcpHttp: !!mcp?.http,
    mcpSse: !!mcp?.sse,
    promptImage: !!prompt?.image,
    supportsLogout: generation === 'v2' ? true : !!(initResult.authMethods as unknown[] | undefined)?.length,
    hasDedicatedSetMode: generation === 'v1'
  }
}
