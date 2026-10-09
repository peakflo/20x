/**
 * Cursor Adapter — implements CodingAgentAdapter on the official `@cursor/sdk`
 * package (local runtime only; this app never sets `cloud` on any SDK call).
 *
 * Replaces the earlier approach of spawning `cursor-agent acp` and talking to
 * it through the generic ACP client (see `acp-adapter.ts`). This adapter owns
 * the whole Cursor-specific surface directly: session lifecycle, streaming
 * delta → transcript projection, MCP server translation, usage/cost
 * reporting, auth (API key and browser login), and plan-limit probing.
 *
 * Known, permanent limitation: the SDK has no interactive per-tool-call
 * approval surface (neither `SendOptions` nor `SDKAgent` exposes an approval
 * callback). 20x's three coarse run-permission levels are mapped onto the
 * SDK's two static knobs (`local.sandboxOptions.enabled`, `local.autoReview`)
 * — see `mapPermissionMode` below. There is no "pause and ask" mode here.
 */

import { randomUUID } from 'crypto'
import type {
  SDKAgent,
  SendOptions,
  AgentOptions,
  LocalAgentOptions,
  ModelSelection,
  Run,
  RunResult,
  SDKUserMessage,
  SDKImage,
  SdkCredentialStore,
  SDKModel,
  AgentMessage,
  SettingSource,
  McpServerConfig as SdkMcpServerConfig
} from '@cursor/sdk'
import type { InteractionUpdate, NestedTaskUpdate } from '@cursor/sdk'
import type { ToolCall } from '@cursor/sdk'
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
import type { DatabaseManager } from '../database'
import { CURSOR_KEYCHAIN_ACCESS_SETTING, probeCursorUsageLimits } from '../usage/cursor-limits'
import { DbSdkCredentialStore, resolveCursorApiKey } from './cursor-sdk-auth'

type CursorSdkModule = typeof import('@cursor/sdk')

// ── Lazy ESM-only SDK load (mirrors ClaudeCodeAdapter's `ensureSDKLoaded` house pattern) ──

let CursorSDK: CursorSdkModule | null = null

async function loadCursorSdk(): Promise<void> {
  try {
    CursorSDK = await import('@cursor/sdk')
    console.log('[CursorSdkAdapter] @cursor/sdk loaded successfully')
  } catch (error) {
    console.error('[CursorSdkAdapter] Failed to load @cursor/sdk:', error)
    CursorSDK = null
  }
}

/** Small, hardcoded fallback shown when the live model catalog hasn't loaded yet or fails. */
const CURSOR_FALLBACK_MODELS: Array<{ id: string; name: string }> = [
  { id: 'composer-2.5', name: 'Composer 2.5' },
  { id: 'grok-4.5', name: 'Grok 4.5' }
]

const MODEL_CATALOG_TTL_MS = 30 * 60 * 1000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** Default Cursor backend host, matching the one `usage/cursor-limits.ts` already talks to. */
const DEFAULT_CURSOR_BACKEND_URL = 'https://api2.cursor.sh'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringifyToolError(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') return error.message
  if (typeof error === 'string') return error
  if (error === undefined) return 'Unknown error'
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Accumulated, latest-known projection of one native tool call, keyed by its callId. */
interface CursorToolAccum {
  kind: 'tool' | 'todowrite' | 'planreview'
  name: string
  title?: string
  input?: unknown
  output?: unknown
  error?: string
  todos?: Array<{ id: string; content: string; status: string }>
}

interface CursorSession {
  /** Cursor's own agent id. Also the map key and the string returned to the caller as the session id. */
  sessionId: string
  agent: SDKAgent
  taskId: string
  config: SessionConfig
  /** True for resumeSession-created sessions — gates the stuck-run recovery retry (never on a fresh session). */
  wasResumed: boolean
  status: SessionStatusType
  lastError: string | null
  usageLimit: UsageLimitStop | null
  currentRun: Run | null
  /** Parts produced since the last pollMessages() drain. */
  messageBuffer: MessagePart[]
  /** Latest snapshot of every part ever emitted, by id — the source of truth for getAllMessages(). */
  finalizedParts: Map<string, MessagePart>
  /** First-seen order of part ids, for getAllMessages() grouping. */
  partOrder: string[]
  textAccum: string
  textPartId: string | null
  reasoningAccum: string
  reasoningPartId: string | null
  toolAccum: Map<string, CursorToolAccum>
  runningTools: Map<string, { toolName: string; startTime: number; lastActivityTime: number; input?: Record<string, unknown> }>
  turnIndex: number
}

export interface CursorSdkAdapterOptions {
  db: Pick<DatabaseManager, 'getSetting' | 'setSetting' | 'deleteSetting'>
}

export class CursorSdkAdapter implements CodingAgentAdapter {
  private sessions = new Map<string, CursorSession>()
  private db: Pick<DatabaseManager, 'getSetting' | 'setSetting' | 'deleteSetting'>
  private credentialStore: SdkCredentialStore
  private sdkLoading: Promise<void>
  private modelCatalogCache: { models: SDKModel[]; fetchedAt: number } | null = null
  private pendingLogin: { abort: AbortController } | null = null
  private planLimitsInFlight: Promise<ProviderUsageLimits | null> | null = null

  /** Callback set by agent-manager to trigger an immediate poll cycle. */
  onDataAvailable?: (sessionId: string) => void
  /** Set by agent-manager: receives per-turn discrete usage. */
  onUsage?: (report: AdapterUsageReport) => void
  /** Set by agent-manager: receives plan-limit snapshots/updates (unused by this adapter; probeUsageLimits is pull-only). */
  onUsageLimits?: (event: AdapterUsageLimitsEvent) => void
  /**
   * Set by the caller that drives the browser-login UI. Fires once with the
   * terminal outcome of a `startBrowserLogin()` call (success, with the email
   * when known, or failure with a message) — `startBrowserLogin()` itself
   * only resolves early with the URL to display; this is how the eventual
   * success/failure of the flow it kicked off is observed.
   */
  onLoginComplete?: (result: { success: true; email?: string } | { success: false; error: string }) => void

  constructor(options: CursorSdkAdapterOptions) {
    this.db = options.db
    this.credentialStore = new DbSdkCredentialStore(this.db)
    this.sdkLoading = loadCursorSdk()
  }

  private async ensureSDKLoaded(): Promise<CursorSdkModule> {
    if (!CursorSDK) await this.sdkLoading
    if (!CursorSDK) throw new Error('Cursor SDK failed to load')
    return CursorSDK
  }

  async initialize(): Promise<void> {
    await this.ensureSDKLoaded()
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.ensureSDKLoaded()
      return { available: true }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async registerMcpServer(): Promise<void> {
    // No-op: MCP servers are recomputed fresh from SessionConfig.mcpServers on
    // every createSession/resumeSession/sendPrompt call (see convertMcpServers),
    // never cached at registration time. Matches AcpAgentAdapter's stub.
  }

  // ── Permission mapping ───────────────────────────────────────

  /**
   * Cursor's SDK has no live per-tool-call approval prompt — this is a real,
   * permanent limitation of this integration, not a TODO. 20x's coarse run
   * modes collapse onto the SDK's two static knobs:
   *   - full access          → { sandbox: false, autoReview: false }
   *   - auto-accept edits    → { sandbox: true,  autoReview: false }
   *   - ask every time       → { sandbox: true,  autoReview: true  }
   * `permissionMode` ('ask' | 'allow') is the only one of these Cursor's own
   * AgentForm UI currently sets; `sandboxMode` is read too (Codex-only UI
   * today) so the middle tier activates automatically if a future UI change
   * starts setting it for Cursor agents.
   */
  private mapPermissionMode(config: SessionConfig): { sandbox: boolean; autoReview: boolean } {
    if (config.permissionMode === 'allow' && config.sandboxMode !== 'workspace-write') {
      return { sandbox: false, autoReview: false }
    }
    if (config.permissionMode === 'allow' && config.sandboxMode === 'workspace-write') {
      return { sandbox: true, autoReview: false }
    }
    return { sandbox: true, autoReview: true }
  }

  private localAgentOptions(config: SessionConfig): LocalAgentOptions {
    const { sandbox, autoReview } = this.mapPermissionMode(config)
    return {
      cwd: config.workspaceDir,
      autoReview,
      sandboxOptions: { enabled: sandbox },
      settingSources: ['all'] as SettingSource[],
      enableAgentRetries: true
    }
  }

  private toModelSelection(model: string | undefined): ModelSelection {
    return { id: !model || model === 'auto' ? 'default' : model }
  }

  // ── MCP translation ──────────────────────────────────────────

  /**
   * Recomputed fresh on every call (never cached): a live MCP endpoint can
   * appear/disappear between a session's creation and a later send.
   */
  private convertMcpServers(servers: Record<string, McpServerConfig> | undefined): Record<string, SdkMcpServerConfig> | undefined {
    if (!servers || Object.keys(servers).length === 0) return undefined
    const result: Record<string, SdkMcpServerConfig> = {}
    for (const [name, server] of Object.entries(servers)) {
      if (server.type === 'stdio') {
        if (!server.command) continue
        result[name] = { type: 'stdio', command: server.command, args: server.args, env: server.env }
      } else if (server.url) {
        result[name] = { type: server.type, url: server.url, headers: server.headers }
      }
    }
    return Object.keys(result).length > 0 ? result : undefined
  }

  // ── Session lifecycle ────────────────────────────────────────

  private initSession(sessionId: string, agent: SDKAgent, config: SessionConfig, wasResumed: boolean): CursorSession {
    return {
      sessionId,
      agent,
      taskId: config.taskId,
      config,
      wasResumed,
      status: SessionStatusType.IDLE,
      lastError: null,
      usageLimit: null,
      currentRun: null,
      messageBuffer: [],
      finalizedParts: new Map(),
      partOrder: [],
      textAccum: '',
      textPartId: null,
      reasoningAccum: '',
      reasoningPartId: null,
      toolAccum: new Map(),
      runningTools: new Map(),
      turnIndex: 0
    }
  }

  async createSession(config: SessionConfig): Promise<string> {
    const sdk = await this.ensureSDKLoaded()
    const apiKey = await resolveCursorApiKey(config, this.credentialStore)
    const agent = await sdk.Agent.create({
      model: this.toModelSelection(config.model),
      apiKey,
      local: this.localAgentOptions(config),
      mcpServers: this.convertMcpServers(config.mcpServers),
      mode: 'agent'
    } satisfies AgentOptions)
    const session = this.initSession(agent.agentId, agent, config, false)
    this.sessions.set(agent.agentId, session)
    console.log(`[CursorSdkAdapter] Session created: ${agent.agentId}`)
    return agent.agentId
  }

  /**
   * Resumes an existing Cursor-SDK agent. A `AgentNotFoundError` here means
   * `sessionId` isn't a real Cursor-SDK agent id — almost certainly a
   * leftover id from the old ACP-based integration (a completely different id
   * namespace). That's translated into the app-wide "resume target is gone"
   * signal (`SESSION_GONE_MARKERS` in agent-manager.ts) so the existing
   * context-handoff fallback kicks in instead of a hard failure.
   *
   * `UnknownAgentError` is deliberately NOT treated the same way: per the
   * SDK's own doc comment it is a generic fallback bucket, "NOT a not-found
   * signal despite the name" — masking it as session-gone would misfire a
   * handoff on what could be a transient/unrelated failure.
   */
  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    const sdk = await this.ensureSDKLoaded()
    const apiKey = await resolveCursorApiKey(config, this.credentialStore)
    let agent: SDKAgent
    try {
      agent = await sdk.Agent.resume(sessionId, {
        model: this.toModelSelection(config.model),
        apiKey,
        local: this.localAgentOptions(config),
        mcpServers: this.convertMcpServers(config.mcpServers),
        mode: 'agent'
      })
    } catch (error) {
      if (error instanceof sdk.AgentNotFoundError) {
        throw new Error(`Session no longer exists on server: ${error.message}`)
      }
      throw error
    }
    const session = this.initSession(sessionId, agent, config, true)
    this.sessions.set(sessionId, session)
    console.log(`[CursorSdkAdapter] Session resumed: ${sessionId}`)
    return await this.getPersistedMessages(sessionId, config)
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    try {
      session.agent.close()
    } catch (error) {
      console.warn(`[CursorSdkAdapter] Error closing agent ${sessionId}:`, error)
    }
    this.sessions.delete(sessionId)
  }

  // ── Prompting ─────────────────────────────────────────────────

  private buildUserMessage(parts: MessagePart[]): SDKUserMessage {
    const text = parts
      .filter((p) => p.type === MessagePartType.TEXT && p.text)
      .map((p) => p.text)
      .join('\n')
    const images: SDKImage[] = []
    for (const part of parts) {
      if (part.type !== MessagePartType.IMAGE || !part.content) continue
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.content)
      images.push(match ? { data: match[2], mimeType: match[1] } : { data: part.content, mimeType: 'image/png' })
    }
    return { text, ...(images.length > 0 ? { images } : {}) }
  }

  async sendPrompt(sessionId: string, parts: MessagePart[], config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const sdk = await this.ensureSDKLoaded()

    const message = this.buildUserMessage(parts)
    if (!message.text && !message.images?.length) {
      throw new Error('No content in message parts')
    }

    session.turnIndex++
    session.textAccum = ''
    session.textPartId = null
    session.reasoningAccum = ''
    session.reasoningPartId = null
    session.status = SessionStatusType.BUSY
    session.lastError = null
    session.usageLimit = null

    this.emitPart(session, {
      id: `user-${session.turnIndex}`,
      type: MessagePartType.TEXT,
      role: 'user',
      text: message.text
    })

    const sendOptions: SendOptions = {
      model: this.toModelSelection(config.model),
      mcpServers: this.convertMcpServers(config.mcpServers),
      mode: 'agent',
      onDelta: ({ update }) => this.handleDelta(session, update)
    }

    let run: Run
    try {
      run = await this.sendWithStuckRunRecovery(sdk, session, message, sendOptions)
    } catch (error) {
      this.handleTurnFailure(sdk, session, error)
      return
    }
    session.currentRun = run
    void this.watchRun(session, run)
  }

  /**
   * `AgentBusyError` ("agent already has an active run in progress") on a
   * resumed session means the backend thinks a previous run is still live —
   * typically a stale run left behind by a crashed process. Finds and cancels
   * that run, then retries the original send exactly once. Never attempted on
   * a freshly-created session, which cannot have a stale run.
   */
  private async sendWithStuckRunRecovery(
    sdk: CursorSdkModule,
    session: CursorSession,
    message: SDKUserMessage,
    options: SendOptions
  ): Promise<Run> {
    try {
      return await session.agent.send(message, options)
    } catch (error) {
      if (!(error instanceof sdk.AgentBusyError) || !session.wasResumed) throw error
      console.warn(`[CursorSdkAdapter] Agent busy on resumed session ${session.sessionId}; recovering stuck run`)
      try {
        const runs = await sdk.Agent.listRuns(session.sessionId, { runtime: 'local', cwd: session.config.workspaceDir })
        const stuckRun = runs.items.find((r) => r.status === 'running')
        if (stuckRun) await stuckRun.cancel()
      } catch (recoveryError) {
        console.warn('[CursorSdkAdapter] Stuck-run recovery lookup/cancel failed:', recoveryError)
      }
      return await session.agent.send(message, options)
    }
  }

  private handleTurnFailure(sdk: CursorSdkModule, session: CursorSession, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    session.status = SessionStatusType.ERROR
    session.lastError = message
    if (error instanceof sdk.RateLimitError) {
      session.usageLimit = { resetAt: null }
    }
    this.emitPart(session, { id: `error-${randomUUID()}`, type: MessagePartType.ERROR, role: 'assistant', text: message })
  }

  private async watchRun(session: CursorSession, run: Run): Promise<void> {
    const sdk = await this.ensureSDKLoaded()
    let result: RunResult
    try {
      result = await run.wait()
    } catch (error) {
      this.handleTurnFailure(sdk, session, error)
      return
    }
    if (session.currentRun === run) session.currentRun = null

    if (result.status === 'error') {
      const message = result.error?.message || 'Cursor run failed'
      session.status = SessionStatusType.ERROR
      session.lastError = message
      this.emitPart(session, { id: `error-${randomUUID()}`, type: MessagePartType.ERROR, role: 'assistant', text: message })
    } else {
      session.status = SessionStatusType.IDLE
    }
    this.onDataAvailable?.(session.sessionId)

    if (result.usage) void this.reportUsage(session, run, result)
  }

  /**
   * Reports token usage via `onUsage` once per run (`sourceKey: run.id`
   * prevents double-counting on replay). Cost is fetched best-effort via
   * `agent.getUsage({runId})` and threaded into the SAME report rather than a
   * follow-up one: `usage-store`'s `recordDiscreteUsage` is `INSERT OR
   * IGNORE` keyed by `sourceKey`, so a later report for the same run would be
   * silently dropped — reporting twice would just lose the refined cost, not
   * add it. Cost is also eventually-consistent server-side per
   * `UsageCost`'s own doc comment, so a cost-fetch failure or a cost that
   * simply isn't ready yet both fall back to `costUsd: null`, not a thrown error.
   */
  private async reportUsage(session: CursorSession, run: Run, result: RunResult): Promise<void> {
    if (!this.onUsage || !result.usage) return
    const usage = result.usage
    const model = result.model?.id || session.config.model || 'default'

    let costUsd: number | null = null
    try {
      const agentUsage = await session.agent.getUsage({ runId: run.id })
      const cost = agentUsage.runs.find((r) => r.runId === run.id)?.cost ?? agentUsage.cost
      if (cost) costUsd = cost.chargedCents / 100
    } catch (error) {
      console.warn('[CursorSdkAdapter] Failed to fetch usage cost (reporting token counts only):', error)
    }

    this.onUsage({
      kind: 'discrete',
      provider: 'cursor',
      providerSessionId: session.sessionId,
      taskId: session.taskId,
      agentId: session.config.agentId,
      items: [{
        sourceKey: run.id,
        model,
        usage: {
          inputTokens: usage.inputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens ?? 0,
          costUsd
        },
        occurredAt: Date.now()
      }]
    })
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    if (session.currentRun) await session.currentRun.cancel()
  }

  async getRunningTools(sessionId: string, _config: SessionConfig): Promise<Array<{
    partId: string
    toolName: string
    startTime?: number
    lastActivityTime?: number
    lastActivityMonotonicTime?: number
    input?: Record<string, unknown>
  }>> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    return Array.from(session.runningTools.entries()).map(([callId, info]) => ({
      partId: callId,
      toolName: info.toolName,
      startTime: info.startTime,
      lastActivityTime: info.lastActivityTime,
      input: info.input
    }))
  }

  // ── Status / message draining ────────────────────────────────

  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId)
    if (!session) return { type: SessionStatusType.ERROR, message: 'Session not found' }
    return {
      type: session.status,
      message: session.status === SessionStatusType.ERROR ? (session.lastError || 'Unknown error') : undefined,
      ...(session.status === SessionStatusType.ERROR && session.usageLimit ? { usageLimit: session.usageLimit } : {})
    }
  }

  async pollMessages(
    sessionId: string,
    _seenMessageIds: Set<string>,
    _seenPartIds: Set<string>,
    _partContentLengths: Map<string, string>,
    _config: SessionConfig
  ): Promise<MessagePart[]> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    const parts = session.messageBuffer
    session.messageBuffer = []
    return parts
  }

  async getAllMessages(sessionId: string, _config: SessionConfig): Promise<SessionMessage[]> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    const parts = session.partOrder
      .map((id) => session.finalizedParts.get(id))
      .filter((part): part is MessagePart => !!part)
    return this.groupPartsIntoMessages(parts)
  }

  /**
   * Reads persisted history from the Cursor-SDK local agent store directly
   * (no live agent instance needed) via `Agent.messages.list`. `AgentMessage.message`
   * is deliberately typed `unknown` by the SDK (no further public shape), so
   * this is a best-effort text projection — full rich tool-call history isn't
   * reconstructed from durable storage, only from a live streamed session.
   */
  async getPersistedMessages(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    try {
      const sdk = await this.ensureSDKLoaded()
      const messages = await sdk.Agent.messages.list(sessionId, { limit: 1000, runtime: 'local', cwd: config.workspaceDir })
      return this.groupPartsIntoMessages(messages.map((m, i) => this.projectPersistedMessage(m, i)))
    } catch (error) {
      console.warn(`[CursorSdkAdapter] getPersistedMessages failed for ${sessionId}:`, error)
      return []
    }
  }

  private projectPersistedMessage(message: AgentMessage, index: number): MessagePart {
    return {
      id: message.uuid || `persisted-${index}`,
      type: MessagePartType.TEXT,
      role: message.type === 'user' ? 'user' : 'assistant',
      text: this.extractPersistedText(message.message)
    }
  }

  private extractPersistedText(message: unknown): string {
    if (typeof message === 'string') return message
    if (isRecord(message)) {
      if (typeof message.text === 'string') return message.text
      if (typeof message.content === 'string') return message.content
    }
    try {
      return JSON.stringify(message)
    } catch {
      return String(message)
    }
  }

  private groupPartsIntoMessages(parts: MessagePart[]): SessionMessage[] {
    const messages: SessionMessage[] = []
    let current: SessionMessage | null = null
    let previous: MessagePart | null = null
    let counter = 0
    for (const part of parts) {
      const roleStr = part.role || 'assistant'
      const role = roleStr === 'user' ? MessageRole.USER : roleStr === 'system' ? MessageRole.SYSTEM : MessageRole.ASSISTANT
      const startsNew = !current || current.role !== role || !previous || part.id !== previous.id
      if (startsNew) {
        if (current) messages.push(current)
        current = { id: `msg-${counter++}`, role, parts: [] }
      }
      current!.parts.push(part)
      previous = part
    }
    if (current) messages.push(current)
    return messages
  }

  /** Records (or re-records, as an update) one finalized part and queues it for the next poll. */
  private emitPart(session: CursorSession, part: MessagePart): void {
    const id = part.id!
    const isUpdate = session.finalizedParts.has(id)
    if (!isUpdate) session.partOrder.push(id)
    const finalized: MessagePart = { ...part, update: isUpdate }
    session.finalizedParts.set(id, finalized)
    session.messageBuffer.push(finalized)
    this.onDataAvailable?.(session.sessionId)
  }

  // ── Delta → transcript mapping ───────────────────────────────

  /**
   * Maps the full `InteractionUpdate` streaming union (see `delta-types.d.ts`)
   * onto MessagePart updates:
   *  - `text-delta` accumulates into a running per-turn text segment, flushed
   *    as a `TEXT` part on every delta (turn-scoped id, so later turns don't
   *    collide).
   *  - `thinking-delta` / `thinking-completed` accumulate the same way into a
   *    `REASONING` part; `thinking-completed` carries only a duration, which
   *    isn't surfaced on MessagePart today, so it's a no-op once the
   *    accumulated text has already been flushed by the deltas.
   *  - `tool-call-started` / `partial-tool-call` / `tool-call-completed` key
   *    off the native `callId` and update the SAME logical TOOL part across
   *    the lifecycle (mirrors every other adapter's incremental tool-call
   *    convention) via `handleToolCallUpdate` → `projectToolCall`.
   *  - `shell-output-delta` appends to the running shell tool call's output
   *    best-effort (the event payload is an untyped `Record<string, unknown>`
   *    on the SDK's own surface).
   *  - `tool-call-delta` is one level of nested task/subagent streaming;
   *    projected via `handleNestedTaskUpdate` onto child parts namespaced
   *    under the parent callId.
   *  - `user-message-appended` is dropped: `sendPrompt` already emits the
   *    user's part itself before sending, so echoing the SDK's own copy would
   *    duplicate it.
   *  - `summary*`, `token-delta`, `step-started`/`step-completed`,
   *    `tool-requests-listed`, `turn-ended` have no UI surface today (mirrors
   *    how AcpAgentAdapter drops non-content updates like
   *    `config_option_update`); turn-level usage is reported separately from
   *    `RunResult.usage` after `run.wait()`.
   *  - Anything unrecognized falls to a generic logged no-op — never thrown,
   *    never silently mis-rendered.
   */
  private handleDelta(session: CursorSession, update: InteractionUpdate): void {
    switch (update.type) {
      case 'text-delta': {
        session.textAccum += update.text
        if (!session.textPartId) session.textPartId = `agent-response-${session.turnIndex}`
        this.emitPart(session, { id: session.textPartId, type: MessagePartType.TEXT, role: 'assistant', text: session.textAccum })
        break
      }
      case 'thinking-delta': {
        session.reasoningAccum += update.text
        if (!session.reasoningPartId) session.reasoningPartId = `agent-thinking-${session.turnIndex}`
        this.emitPart(session, { id: session.reasoningPartId, type: MessagePartType.REASONING, role: 'assistant', text: session.reasoningAccum })
        break
      }
      case 'tool-call-started':
      case 'partial-tool-call':
        this.handleToolCallUpdate(session, update.callId, update.toolCall, 'running')
        break
      case 'tool-call-completed':
        this.handleToolCallUpdate(session, update.callId, update.toolCall, 'completed')
        break
      case 'tool-call-delta':
        this.handleNestedTaskUpdate(session, update.callId, update.taskUpdate)
        break
      case 'shell-output-delta':
        this.handleShellOutputDelta(session, update.event)
        break
      case 'thinking-completed':
      case 'user-message-appended':
      case 'summary':
      case 'summary-started':
      case 'summary-completed':
      case 'token-delta':
      case 'step-started':
      case 'step-completed':
      case 'tool-requests-listed':
      case 'turn-ended':
        break
      default:
        console.log('[CursorSdkAdapter] Unhandled delta kind:', (update as { type?: string }).type)
    }
  }

  private handleShellOutputDelta(session: CursorSession, event: Record<string, unknown>): void {
    const callId = typeof event.callId === 'string' ? event.callId : undefined
    if (!callId) return
    const existing = session.toolAccum.get(callId)
    if (!existing) return
    const chunk = typeof event.stdout === 'string' ? event.stdout : typeof event.data === 'string' ? event.data : ''
    if (!chunk) return
    const previousOutput = typeof existing.output === 'string' ? existing.output : ''
    existing.output = previousOutput + chunk
    session.toolAccum.set(callId, existing)
    const running = session.runningTools.get(callId)
    if (running) running.lastActivityTime = Date.now()
    this.emitPart(session, {
      id: callId,
      type: MessagePartType.TOOL,
      tool: { name: existing.name, title: existing.title, status: 'running', input: existing.input, output: existing.output }
    })
  }

  private handleToolCallUpdate(session: CursorSession, callId: string, toolCall: ToolCall, phase: 'running' | 'completed'): void {
    const projected = this.projectToolCall(toolCall)
    const status = phase === 'completed' ? (projected.error ? 'error' : 'success') : 'running'
    session.toolAccum.set(callId, projected)

    if (phase === 'completed') {
      session.runningTools.delete(callId)
    } else {
      const now = Date.now()
      const running = session.runningTools.get(callId)
      session.runningTools.set(callId, {
        toolName: projected.name,
        startTime: running?.startTime ?? now,
        lastActivityTime: now,
        input: isRecord(projected.input) ? projected.input : undefined
      })
    }

    const partType: MessagePartType = projected.kind === 'todowrite'
      ? ('todowrite' as MessagePartType)
      : projected.kind === 'planreview'
        ? ('planreview' as MessagePartType)
        : MessagePartType.TOOL

    this.emitPart(session, {
      id: callId,
      type: partType,
      tool: {
        name: projected.name,
        title: projected.title,
        status,
        input: projected.input,
        output: projected.output,
        error: projected.error,
        todos: projected.todos
      }
    })
  }

  /**
   * One level of nested task/subagent streaming (`tool-call-delta`'s
   * `taskUpdate`). Projected onto child parts namespaced under the parent
   * callId so they never collide with top-level parts. The SDK itself only
   * exposes one level — a grandchild `tool-call-delta` inside this union is
   * dropped at the SDK's own convert step, per its doc comment.
   */
  private handleNestedTaskUpdate(session: CursorSession, parentCallId: string, taskUpdate: NestedTaskUpdate): void {
    switch (taskUpdate.type) {
      case 'text-delta': {
        const id = `${parentCallId}-text`
        const existing = session.toolAccum.get(id)
        const text = (typeof existing?.output === 'string' ? existing.output : '') + taskUpdate.text
        session.toolAccum.set(id, { kind: 'tool', name: 'task-output', output: text })
        this.emitPart(session, { id, type: MessagePartType.TEXT, role: 'assistant', text })
        break
      }
      case 'tool-call-started':
        this.handleToolCallUpdate(session, `${parentCallId}:${taskUpdate.callId}`, taskUpdate.toolCall, 'running')
        break
      case 'tool-call-completed':
        this.handleToolCallUpdate(session, `${parentCallId}:${taskUpdate.callId}`, taskUpdate.toolCall, 'completed')
        break
      default:
        // step-started / tool-requests-listed / step-completed carry no displayable content.
        break
    }
  }

  /**
   * Projects every native tool-call kind (`tool-call-types.d.ts`) onto a
   * MessagePart.tool shape:
   *  - `shell` → command/stdout/stderr/exit code in input/output.
   *  - `write` / `edit` / `delete` → diff-ish info (path, diff string,
   *    lines added/removed, or file size for a delete).
   *  - `read` / `glob` / `grep` / `ls` / `semSearch` / `readLints` →
   *    search/read-style results, passed through close to their native shape.
   *  - `updateTodos` → `tool.todos`, matching the existing plan/todo UI
   *    convention other adapters use (see claude-code-adapter.ts's TodoWrite
   *    handling and AcpAgentAdapter's `plan` → `todowrite` mapping).
   *  - `createPlan` → the `planreview` convention (claude-code-adapter.ts's
   *    EnterPlanMode/ExitPlanMode), with the plan markdown in `tool.output`.
   *  - `task` (subagent) → a generic tool part (description/prompt in input,
   *    duration/background-ness in output) — no richer subagent-specific UI
   *    convention exists elsewhere in this codebase to match.
   *  - `mcp` and anything unrecognized (`generateImage`, `computerUse`,
   *    `recordScreen`, future kinds) → a generic tool part carrying raw
   *    input/output, never dropped.
   */
  private projectToolCall(toolCall: ToolCall): CursorToolAccum {
    // `toolCall.result` is re-read inside each case (not hoisted above the
    // switch): only once `toolCall` itself is narrowed to one discriminated
    // member does `.result.value` carry that member's specific shape instead
    // of the near-unusable common type TS falls back to across the full
    // (very large) union.
    switch (toolCall.type) {
      case 'shell': {
        const result = toolCall.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        return {
          kind: 'tool',
          name: 'shell',
          title: toolCall.args.command,
          input: { command: toolCall.args.command, workingDirectory: toolCall.args.workingDirectory },
          output: value ? { stdout: value.stdout, stderr: value.stderr, exitCode: value.exitCode, signal: value.signal } : undefined,
          error
        }
      }
      case 'write': {
        const result = toolCall.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        return {
          kind: 'tool',
          name: 'write',
          title: toolCall.args.path,
          input: { path: toolCall.args.path, fileText: toolCall.args.fileText },
          output: value ? { linesCreated: value.linesCreated, fileSize: value.fileSize } : undefined,
          error
        }
      }
      case 'edit': {
        const result = toolCall.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        return {
          kind: 'tool',
          name: 'edit',
          title: toolCall.args.path,
          input: { path: toolCall.args.path },
          output: value ? { diff: value.diffString, linesAdded: value.linesAdded, linesRemoved: value.linesRemoved } : undefined,
          error
        }
      }
      case 'delete': {
        const result = toolCall.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        return {
          kind: 'tool',
          name: 'delete',
          title: toolCall.args.path,
          input: { path: toolCall.args.path },
          output: value ? { fileSize: value.fileSize } : undefined,
          error
        }
      }
      case 'glob': {
        const result = toolCall.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        return {
          kind: 'tool',
          name: 'glob',
          title: toolCall.args.globPattern,
          input: { globPattern: toolCall.args.globPattern, targetDirectory: toolCall.args.targetDirectory },
          output: value ? { files: value.files, totalFiles: value.totalFiles } : undefined,
          error
        }
      }
      case 'grep': {
        const result = toolCall.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        return {
          kind: 'tool',
          name: 'grep',
          title: toolCall.args.pattern,
          input: { pattern: toolCall.args.pattern, path: toolCall.args.path, glob: toolCall.args.glob },
          output: value,
          error
        }
      }
      case 'read': {
        const result = toolCall.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        return {
          kind: 'tool',
          name: 'read',
          title: toolCall.args.path,
          input: { path: toolCall.args.path },
          output: value ? { content: value.content, totalLines: value.totalLines, fileSize: value.fileSize } : undefined,
          error
        }
      }
      case 'ls': {
        const result = toolCall.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        return { kind: 'tool', name: 'ls', title: toolCall.args.path, input: { path: toolCall.args.path }, output: value, error }
      }
      case 'readLints': {
        const result = toolCall.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        return {
          kind: 'tool',
          name: 'readLints',
          title: toolCall.args.paths.join(', '),
          input: { paths: toolCall.args.paths },
          output: value,
          error
        }
      }
      case 'semSearch': {
        const result = toolCall.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        return {
          kind: 'tool',
          name: 'semSearch',
          title: toolCall.args.query,
          input: { query: toolCall.args.query, targetDirectories: toolCall.args.targetDirectories },
          output: value ? { results: value.results } : undefined,
          error
        }
      }
      case 'mcp': {
        const result = toolCall.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        const name = toolCall.args.providerIdentifier && toolCall.args.toolName
          ? `${toolCall.args.providerIdentifier}/${toolCall.args.toolName}`
          : (toolCall.args.toolName || 'mcp')
        const outputText = value?.content.map((c) => c.text?.text).filter((t): t is string => !!t).join('\n')
        return { kind: 'tool', name, title: name, input: toolCall.args.args, output: outputText, error }
      }
      case 'updateTodos': {
        return {
          kind: 'todowrite',
          name: 'updateTodos',
          todos: toolCall.args.todos.map((t, i) => ({
            id: `todo-${i}`,
            content: t.content,
            status: t.status === 'inProgress' ? 'in_progress' : t.status
          }))
        }
      }
      case 'createPlan': {
        return { kind: 'planreview', name: 'createPlan', title: 'Plan', output: toolCall.args.plan }
      }
      case 'task': {
        const result = toolCall.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        return {
          kind: 'tool',
          name: 'task',
          title: toolCall.args.description,
          input: { description: toolCall.args.description, prompt: toolCall.args.prompt, subagentType: toolCall.args.subagentType?.kind },
          output: value ? { durationMs: value.durationMs, isBackground: value.isBackground, agentId: value.agentId } : undefined,
          error
        }
      }
      default: {
        const raw = toolCall as { type: string; args?: unknown; result?: { status: 'success' | 'error'; value?: unknown; error?: unknown } }
        const result = raw.result
        const value = result?.status === 'success' ? result.value : undefined
        const error = result?.status === 'error' ? stringifyToolError(result.error) : undefined
        return { kind: 'tool', name: raw.type, input: raw.args, output: value, error }
      }
    }
  }

  // ── Model catalog ────────────────────────────────────────────

  private fallbackModels(): SDKModel[] {
    return CURSOR_FALLBACK_MODELS.map((m) => ({ id: m.id, displayName: m.name }))
  }

  private providersFromModels(models: SDKModel[]): {
    providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
    default: Record<string, string>
  } {
    return {
      providers: [{ id: 'cursor', name: 'Cursor', models: models.map((m) => ({ id: m.id, name: m.displayName })) }],
      default: { cursor: models[0]?.id ?? 'default' }
    }
  }

  /**
   * Backed by `Cursor.models.list`, cached in-memory for 30 minutes — but
   * ONLY on a successful, non-empty result, so a failure or empty catalog
   * doesn't poison the cache and the next read retries immediately.
   */
  async getProvidersOrThrow(_serverUrl?: string, _directory?: string): Promise<{
    providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
    default: Record<string, string>
  }> {
    const sdk = await this.ensureSDKLoaded()
    const apiKey = (await resolveCursorApiKey(undefined, this.credentialStore)) ?? process.env.CURSOR_API_KEY
    const models = await sdk.Cursor.models.list({ apiKey })
    if (models.length > 0) this.modelCatalogCache = { models, fetchedAt: Date.now() }
    return this.providersFromModels(models.length > 0 ? models : this.fallbackModels())
  }

  async getProviders(serverUrl?: string, directory?: string): Promise<{
    providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
    default: Record<string, string>
  } | null> {
    const cached = this.modelCatalogCache
    if (cached && Date.now() - cached.fetchedAt < MODEL_CATALOG_TTL_MS) {
      return this.providersFromModels(cached.models)
    }
    try {
      return await this.getProvidersOrThrow(serverUrl, directory)
    } catch (error) {
      console.warn('[CursorSdkAdapter] getProviders failed, using fallback catalog:', error)
      return this.providersFromModels(this.fallbackModels())
    }
  }

  // ── Account / auth ────────────────────────────────────────────

  /** "Am I signed in, as whom" — always live, never cached. ~15s timeout. */
  async whoAmI(): Promise<{ authenticated: boolean; email?: string; reason?: string }> {
    const sdk = await this.ensureSDKLoaded()
    const apiKey = await resolveCursorApiKey(undefined, this.credentialStore)
    if (!apiKey) return { authenticated: false, reason: 'Not signed in' }
    try {
      const user = await Promise.race([
        sdk.Cursor.me({ apiKey }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Cursor account lookup timed out')), 15_000))
      ])
      return { authenticated: true, email: user.userEmail }
    } catch (error) {
      if (error instanceof sdk.AuthenticationError) return { authenticated: false, reason: 'Not authenticated' }
      return { authenticated: false, reason: 'Status unknown' }
    }
  }

  /**
   * Begins a browser-login flow. Resolves as soon as the SDK hands back the
   * login URL (`onLoginUrl`); the overall login keeps polling in the
   * background after that. Credentials are copied from the throwaway
   * in-memory store into 20x's persistent, encrypted store ONLY after
   * `Cursor.auth.login()`'s returned promise resolves successfully — never
   * mid-flow, so a cancelled/timed-out attempt can't leak a late credential
   * into persistent storage. The eventual outcome (success/failure) is
   * reported through `onLoginComplete`, not through this method's return
   * value. Refuses to start while an explicit `CURSOR_API_KEY` is set in the
   * environment (API-key auth is authoritative then; remove it first).
   */
  async startBrowserLogin(): Promise<{ url: string }> {
    if (process.env.CURSOR_API_KEY) {
      throw new Error('A CURSOR_API_KEY environment variable is set. Remove it before signing in with a browser.')
    }
    if (this.pendingLogin) {
      throw new Error('A Cursor sign-in is already in progress.')
    }
    const sdk = await this.ensureSDKLoaded()
    const abort = new AbortController()
    this.pendingLogin = { abort }
    const timeout = setTimeout(() => abort.abort(), LOGIN_TIMEOUT_MS)

    const finish = (outcome: { success: true; email?: string } | { success: false; error: string }): void => {
      clearTimeout(timeout)
      this.pendingLogin = null
      this.onLoginComplete?.(outcome)
    }

    return await new Promise<{ url: string }>((resolveUrl, rejectUrl) => {
      let urlDelivered = false
      sdk.Cursor.auth.login({
        openBrowser: false,
        store: new sdk.InMemoryCredentialStore(),
        signal: abort.signal,
        apiKeyName: 'peakflo-20x-desktop',
        onLoginUrl: (url) => {
          urlDelivered = true
          resolveUrl({ url })
        }
      }).then(async (result) => {
        try {
          await this.credentialStore.save({
            version: 1,
            backendUrl: process.env.CURSOR_BACKEND_URL || DEFAULT_CURSOR_BACKEND_URL,
            apiKey: result.apiKey,
            apiKeyExpiresAtMs: result.apiKeyExpiresAtMs,
            email: result.email,
            createdAtMs: Date.now()
          })
          finish({ success: true, email: result.email })
        } catch (saveError) {
          finish({ success: false, error: saveError instanceof Error ? saveError.message : String(saveError) })
        }
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (!urlDelivered) {
          clearTimeout(timeout)
          this.pendingLogin = null
          rejectUrl(error instanceof Error ? error : new Error(message))
          return
        }
        finish({ success: false, error: message })
      })
    })
  }

  /** Cancels an in-flight startBrowserLogin(); its promise settles via the SDK's own AbortSignal handling (AuthenticationError). */
  cancelBrowserLogin(): void {
    this.pendingLogin?.abort.abort()
  }

  /** Forgets the stored browser-login credential. Refused while an explicit CURSOR_API_KEY is set. */
  async logout(): Promise<void> {
    if (process.env.CURSOR_API_KEY) {
      throw new Error('A CURSOR_API_KEY environment variable is set. Remove it to manage the browser-login session instead.')
    }
    await this.credentialStore.clear()
  }

  // ── Plan-limit probing ───────────────────────────────────────

  /**
   * Independent of the SDK: reads the Cursor CLI's own login token (env var /
   * `~/.cursor/auth.json` / opt-in macOS Keychain) and calls the Cursor
   * dashboard API directly, exactly as the pre-refactor Cursor-specific ACP
   * shim's `wireCursorPlanLimits` did — mirrored here directly since this is
   * now a first-class Cursor adapter, not a generic one needing an external
   * override. Keychain-access consent is re-read live on every call (not
   * captured once at construction) so toggling the setting takes effect on
   * the next probe. De-duplicates concurrent probes.
   */
  probeUsageLimits = (): Promise<ProviderUsageLimits | null> => {
    if (this.planLimitsInFlight) return this.planLimitsInFlight
    const pending = probeCursorUsageLimits({
      allowKeychain: this.db.getSetting(CURSOR_KEYCHAIN_ACCESS_SETTING) === 'true'
    }).finally(() => { this.planLimitsInFlight = null })
    this.planLimitsInFlight = pending
    return pending
  }
}
