/**
 * EnterpriseRunnerAdapter — runs a task's chat on a Spaces enterprise runner.
 *
 * The task is a Spaces task and its chat a coding-agent session linked to it,
 * so the work can continue on the Spaces web and 20x mirrors it live. The
 * server owns completion: this adapter only ever reports session status and
 * never completes a task.
 *
 * Transport: REST for commands, SSE (`/stream?sinceRev`) for the transcript.
 * Parts are upserted by `partId`; `rev` is persisted so a restart resumes where
 * it stopped, and `/transcript/delta` is the fallback while the stream is down.
 *
 * Secrets: nothing from `SessionConfig` other than the explicit fields listed
 * in `createSession` ever reaches a request. Local MCP servers, the secret
 * broker and `secretEnvVars` are local-only (see `registerMcpServer`).
 */

import { randomUUID } from 'crypto'
import {
  MessagePartType,
  SessionStatusType,
  type AdapterUsageReport,
  type CodingAgentAdapter,
  type MessagePart,
  type SessionConfig,
  type SessionMessage,
  type SessionStatus,
  MessageRole
} from './coding-agent-adapter'
import {
  APPROVAL_TTL_MS,
  type EnterpriseRunner,
  normaliseRunners
} from '../../shared/enterprise-runners'
import {
  RunnerHttpError,
  type RunnerApi,
  type WirePart,
  type WireSession,
  type WireTranscriptPage
} from '../enterprise-runners/runner-api'
import {
  extractTurnUsage,
  isAnswered,
  isQuestionPart,
  parseApproval,
  wirePartToMessagePart,
  type ParsedApproval,
  type TurnUsage
} from '../enterprise-runners/transcript-mapper'
import { scrubForLog } from '../enterprise-runners/scrub'
import { ZERO_TOKEN_COUNTS } from '../../shared/usage'
import type { UsageTotals } from '../usage/usage-normalize'

export const MCP_NOTE_TEXT = 'Local MCP servers aren’t available on remote runners. This session uses the tools your Spaces agent grants it.'

/** Durable key-value store (backed by the app settings table). */
export interface RunnerKeyValueStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
}

export interface RunnerSyncSnapshot {
  taskId: string
  remoteSessionId: string | null
  serverTaskId: string | null
  runnerId: string | null
  /** SSE connection state: false while reconnecting. */
  connected: boolean
  session: WireSession | null
  rev: number
  /** Unix ms of the last event from the server. */
  lastEventAt: number | null
  /** Unix ms of the last time a message from another participant arrived. */
  lastForeignMessageAt: number | null
  usage: { tokens: number; costUsd: number; credits: number }
}

export interface EnterpriseRunnerHost {
  api: RunnerApi
  store: RunnerKeyValueStore
  /** Creates or syncs the Spaces task for a 20x task; returns the Spaces task id. */
  ensureServerTask(taskId: string): Promise<string>
  /** The Spaces agent id (`enterprise_agent_id`) of a 20x agent. */
  getEnterpriseAgentId(agentId: string): string | null
  /** The task's chosen runner (from the "Run on" picker) or the agent's pin. */
  getRunnerId(taskId: string, agentId: string): string | null
  getTaskInfo(taskId: string): { title: string; repositories: string[] } | null
  currentUserId(): string | null
  /** False once the user signed out or access was revoked: the stream stops until sign-in. */
  isSignedIn?(): boolean
  /** Values of the user's local secrets, loaded into the request guard. */
  localSecretValues?(): string[]
  /** Called whenever the sync snapshot changes (connection, status, parts). */
  onSnapshot?(snapshot: RunnerSyncSnapshot): void
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

interface SessionState {
  /** The id handed to agent-manager. Starts as a placeholder, then the remote id. */
  localId: string
  remoteId: string | null
  config: SessionConfig
  taskId: string
  serverTaskId: string | null
  runnerId: string | null
  clientRequestId: string
  parts: Map<string, WirePart>
  /** Content signature last emitted per part: skips replays, emits real changes. */
  emitted: Map<string, string>
  buffer: MessagePart[]
  rev: number
  persistedRev: number
  session: WireSession | null
  connected: boolean
  streaming: boolean
  closed: boolean
  controller: AbortController | null
  reconnectAttempts: number
  lastEventAt: number | null
  lastForeignMessageAt: number | null
  /** `clientMessageId`s we sent whose echo has not come back yet (each is consumed once). */
  sentMessageIds: Set<string>
  attached: boolean
  /** Stream/polling stopped because the session is no longer authorised. */
  authPaused: boolean
  /** Aborts backoff sleeps and the stream on detach. */
  loopAbort: AbortController
  approvals: Map<string, ParsedApproval>
  usage: { tokens: number; costUsd: number; credits: number }
  usageSeen: Set<string>
  noteSent: boolean
  lastDeltaAt: number
  startPromise: Promise<void> | null
}

function signature(part: WirePart): string {
  return `${part.rev}:${part.content}:${JSON.stringify(part.payload ?? null)}`
}

function partsText(parts: MessagePart[]): string {
  return parts
    .map((p) => p.text ?? p.content ?? '')
    .filter((t) => t.length > 0)
    .join('\n\n')
}

export class EnterpriseRunnerAdapter implements CodingAgentAdapter {
  onDataAvailable?: (sessionId: string) => void
  onUsage?: (report: AdapterUsageReport) => void

  private readonly sessions = new Map<string, SessionState>()
  /** placeholder / remote ids → state, so a re-keyed session still resolves. */
  private readonly aliases = new Map<string, SessionState>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly host: EnterpriseRunnerHost) {
    this.now = host.now ?? Date.now
    this.sleep = host.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // Auth is resolved per request by the enterprise auth; nothing to start.
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.host.api.listRunnersRaw()
      return { available: true }
    } catch (error) {
      return { available: false, reason: scrubForLog(error) }
    }
  }

  private lookup(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId) ?? this.aliases.get(sessionId)
  }

  private sessionKey(taskId: string): string { return `enterprise-runner:session:${taskId}` }
  private revKey(remoteId: string): string { return `enterprise-runner:rev:${remoteId}` }

  private newState(localId: string, config: SessionConfig, clientRequestId: string, remoteId: string | null): SessionState {
    return {
      localId, remoteId, config, taskId: config.taskId, serverTaskId: null, runnerId: null, clientRequestId,
      parts: new Map(), emitted: new Map(), buffer: [], rev: 0, persistedRev: 0, session: null, connected: false, streaming: false,
      closed: false, controller: null, reconnectAttempts: 0, lastEventAt: null, lastForeignMessageAt: null,
      sentMessageIds: new Set(), attached: false, authPaused: false, loopAbort: new AbortController(), approvals: new Map(), usage: { tokens: 0, costUsd: 0, credits: 0 },
      usageSeen: new Set(), noteSent: false, lastDeltaAt: 0, startPromise: null
    }
  }

  /**
   * Lazy and idempotent. Syncs the 20x task to Spaces, then records the intent
   * to start a task-linked session on the chosen runner. The server session is
   * created by the first `sendPrompt` (the server requires a first message).
   * Calling this again for the same task returns the same session id.
   */
  async createSession(config: SessionConfig): Promise<string> {
    const stored = this.host.store.get(this.sessionKey(config.taskId))
    let record: { clientRequestId: string; remoteSessionId: string | null; runnerId: string | null; attached?: boolean } | null = null
    if (stored) {
      try { record = JSON.parse(stored) } catch { record = null }
    }
    const existing = [...this.sessions.values()].find((s) => s.taskId === config.taskId && !s.closed)
    if (existing) return existing.localId

    // Local secrets stay local: remember them only so the request guard can
    // refuse a body that would contain one.
    this.host.api.setKnownSecrets([
      ...(this.host.localSecretValues?.() ?? []),
      ...Object.values(config.secretEnvVars ?? {}),
      ...Object.values(config.apiKeys ?? {}).filter((v): v is string => typeof v === 'string'),
      ...(config.secretSessionToken ? [config.secretSessionToken] : [])
    ])
    this.host.api.setLocalServicePorts?.(localServicePorts(config))
    const serverTaskId = await this.host.ensureServerTask(config.taskId)
    const clientRequestId = record?.clientRequestId ?? `20x:${config.taskId}:${randomUUID()}`
    const remoteId = record?.remoteSessionId ?? null
    const localId = remoteId ?? `er-pending:${clientRequestId}`
    const state = this.newState(localId, config, clientRequestId, remoteId)
    state.serverTaskId = serverTaskId
    state.runnerId = this.host.getRunnerId(config.taskId, config.agentId) ?? record?.runnerId ?? null
    state.attached = record?.attached ?? false
    this.persistRecord(state)
    this.register(state)
    if (remoteId) {
      // A crash between "session created" and "linked to the task": finish the link now.
      if (!state.attached) void this.retryAttach(state)
      state.rev = Number(this.host.store.get(this.revKey(remoteId)) ?? 0) || 0
      state.persistedRev = state.rev
      void this.startStream(state)
    }
    return localId
  }

  private register(state: SessionState): void {
    this.sessions.set(state.localId, state)
    this.aliases.set(state.localId, state)
    if (state.remoteId) this.aliases.set(state.remoteId, state)
  }

  private persistRecord(state: SessionState): void {
    this.host.store.set(this.sessionKey(state.taskId), JSON.stringify({
      clientRequestId: state.clientRequestId,
      remoteSessionId: state.remoteId,
      runnerId: state.runnerId,
      attached: state.attached
    }))
  }

  private async retryAttach(state: SessionState): Promise<void> {
    if (!state.remoteId || state.attached || !state.serverTaskId) return
    try {
      await this.host.api.attachTask(state.remoteId, state.serverTaskId)
      state.attached = true
      this.persistRecord(state)
    } catch (error) {
      console.warn('[EnterpriseRunner] attach retry failed:', scrubForLog(error))
    }
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    let state = this.lookup(sessionId)
    if (!state) {
      state = this.newState(sessionId, config, `20x:${config.taskId}:resume`, sessionId)
      state.serverTaskId = null
      state.runnerId = this.host.getRunnerId(config.taskId, config.agentId)
      this.register(state)
    }
    const page = await this.host.api.transcript(state.remoteId ?? sessionId)
    state.remoteId = state.remoteId ?? sessionId
    if (this.applyPage(state, page, { emit: false })) await this.catchUp(state)
    this.persistRecord(state)
    void this.startStream(state)
    return this.messagesFromState(state)
  }

  // ── commands ───────────────────────────────────────────────────────

  async sendPrompt(sessionId: string, parts: MessagePart[], config: SessionConfig): Promise<void> {
    const state = this.lookup(sessionId)
    if (!state) throw new Error(`Session not found: ${sessionId}`)
    const content = partsText(parts)
    if (!content.trim()) return
    this.emitMcpNote(state, config)

    if (!state.remoteId) {
      if (!state.startPromise) {
        await this.startRemoteSession(state, content)
        return
      }
      // A message that arrives while the session is still being created is
      // not dropped: it goes through /messages as soon as the id is known.
      await state.startPromise
    }
    if (!state.remoteId) throw new Error('The runner session could not be created.')
    // Concurrent messages from the web and 20x are both sent; the server
    // orders them. Nothing is deduplicated by content.
    const clientMessageId = randomUUID()
    state.sentMessageIds.add(clientMessageId)
    const previous = state.session
    state.session = previous ? { ...previous, status: 'queued' } : previous
    try {
      await this.host.api.sendMessage(state.remoteId, { content, clientMessageId })
    } catch (error) {
      // The send failed: do not stay BUSY waiting for a turn that never started.
      state.sentMessageIds.delete(clientMessageId)
      state.session = previous
      this.publish(state)
      throw error
    }
    this.publish(state)
  }

  private async startRemoteSession(state: SessionState, message: string): Promise<void> {
    if (state.startPromise) return state.startPromise
    state.startPromise = (async () => {
      const agentId = this.host.getEnterpriseAgentId(state.config.agentId)
      if (!agentId) throw new Error('This agent is not synced from Spaces, so it cannot run on a runner.')
      const serverTaskId = state.serverTaskId ?? await this.host.ensureServerTask(state.taskId)
      state.serverTaskId = serverTaskId
      const info = this.host.getTaskInfo(state.taskId)
      // Explicit allowlist. Never copy `config` wholesale: it holds local
      // secrets, broker/proxy settings and local MCP configuration.
      const { session } = await this.host.api.startTaskSession(serverTaskId, {
        agentId,
        runnerId: state.runnerId ?? undefined,
        title: info?.title,
        message,
        repositories: info?.repositories,
        clientRequestId: state.clientRequestId
      }, (created, attached) => {
        // Persist the id the moment the server returns it, before the attach
        // call, so a crash in between can be repaired on the next start.
        state.remoteId = created.id
        state.attached = attached
        state.runnerId = created.runnerId ?? state.runnerId
        this.aliases.set(created.id, state)
        this.persistRecord(state)
      })
      state.attached = true
      state.remoteId = session.id
      state.session = session
      state.runnerId = session.runnerId ?? state.runnerId
      this.aliases.set(session.id, state)
      this.persistRecord(state)
      // Tell agent-manager the real id so the task row and polling are re-keyed.
      state.buffer.push({ id: `er-session-${session.id}`, type: MessagePartType.TEXT, text: '', content: '', realSessionId: session.id, update: true })
      this.notify(state)
      void this.startStream(state)
    })().finally(() => { state.startPromise = null })
    return state.startPromise
  }

  private emitMcpNote(state: SessionState, config: SessionConfig): void {
    if (state.noteSent) return
    state.noteSent = true
    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) return
    state.buffer.push({ id: `er-note-mcp-${state.localId}`, type: MessagePartType.TEXT, role: 'system', text: MCP_NOTE_TEXT, content: MCP_NOTE_TEXT, receivedAt: this.now() })
    this.notify(state)
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const state = this.lookup(sessionId)
    if (!state?.remoteId) return
    await this.host.api.abort(state.remoteId)
  }

  /**
   * Detach only: stop the stream and drop in-memory state, but keep the session
   * record and the rev, so quitting the app (or an idle release) never ends the
   * remote work and the next start resumes where it stopped.
   */
  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    const state = this.lookup(sessionId)
    if (!state) return
    state.closed = true
    state.controller?.abort()
    state.loopAbort.abort()
    this.sessions.delete(state.localId)
    for (const [k, v] of this.aliases) if (v === state) this.aliases.delete(k)
  }

  /** Explicit end (user Stop or Reassign): ends the server session and forgets it. */
  async endSession(sessionId: string, _config: SessionConfig): Promise<void> {
    const state = this.lookup(sessionId)
    if (!state) return
    this.host.store.delete(this.sessionKey(state.taskId))
    if (state.remoteId) {
      this.host.store.delete(this.revKey(state.remoteId))
      try { await this.host.api.end(state.remoteId) } catch (error) {
        console.warn('[EnterpriseRunner] end failed:', scrubForLog(error))
      }
    }
  }

  /**
   * Local MCP servers (including 20x's task tools) cannot reach a runner. This
   * is a deliberate no-op; the user sees MCP_NOTE_TEXT in the transcript.
   */
  async registerMcpServer(): Promise<void> {
    // intentionally empty
  }

  // ── approvals and questions ────────────────────────────────────────

  getPendingApproval(sessionId: string): { requestId: string; toolCallId: string; question: string; options: Array<{ optionId: string; name: string; kind: string }> } | null {
    const state = this.lookup(sessionId)
    if (!state) return null
    const now = this.now()
    for (const approval of state.approvals.values()) {
      if (approval.answered || now - approval.requestedAt >= APPROVAL_TTL_MS) continue
      return { requestId: approval.partId, toolCallId: approval.partId, question: approval.question, options: approval.options }
    }
    return null
  }

  /**
   * Allow / Reject only. A request older than 30 minutes was auto-denied by
   * the server; answering it would be a no-op, so it resolves as stale
   * (`false`) without calling the server.
   */
  async respondToApproval(sessionId: string, approved: boolean, optionId?: string, requestId?: string): Promise<boolean> {
    const state = this.lookup(sessionId)
    if (!state?.remoteId) throw new Error(`Session not found: ${sessionId}`)
    const approval = requestId ? state.approvals.get(requestId) : [...state.approvals.values()].find((a) => !a.answered)
    if (!approval || approval.answered) return false
    if (this.now() - approval.requestedAt >= APPROVAL_TTL_MS) {
      this.markAnswered(state, approval.partId, 'Approval expired')
      return false
    }
    const wanted = approved ? 'allow_once' : 'reject_once'
    // Never "always allow": pick only from the server's allow/reject options.
    const option = approval.options.find((o) => o.optionId === optionId && o.kind === wanted) ?? approval.options.find((o) => o.kind === wanted)
    if (!option) return false
    await this.host.api.answer(state.remoteId, { partId: approval.partId, answer: option.name, optionId: option.optionId })
    this.markAnswered(state, approval.partId, approved ? 'Approved' : 'Declined')
    return true
  }

  async respondToQuestion(
    sessionId: string,
    answers: Record<string, string>,
    _config: SessionConfig,
    requestId?: string
  ): Promise<boolean> {
    const state = this.lookup(sessionId)
    if (!state?.remoteId) throw new Error(`Session not found: ${sessionId}`)
    const partId = requestId ?? [...state.parts.values()].reverse().find((p) => isQuestionPart(p) && !isAnswered(p))?.partId
    if (!partId) return false
    const part = state.parts.get(partId)
    if (part && this.now() - (Date.parse(part.createdAt) || 0) >= APPROVAL_TTL_MS) return false
    const answer = Object.values(answers).join('\n')
    const questions = (part?.payload as { questions?: Array<{ options?: Array<{ id?: string; label?: string }> }> } | undefined)?.questions
    const optionId = questions?.[0]?.options?.find((o) => o.label === answer)?.id
    await this.host.api.answer(state.remoteId, { partId, answer, ...(optionId ? { optionId } : {}) })
    this.markAnswered(state, partId, answer)
    return true
  }

  private markAnswered(state: SessionState, partId: string, output: string): void {
    const approval = state.approvals.get(partId)
    if (approval) approval.answered = true
    state.buffer.push({
      id: partId, type: MessagePartType.QUESTION, update: true,
      tool: { name: 'permission', status: 'completed', requestId: partId, output }
    })
    this.notify(state)
  }

  // ── status and polling ─────────────────────────────────────────────

  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const state = this.lookup(sessionId)
    if (!state) return { type: SessionStatusType.ERROR, message: 'Session not found' }
    if (!state.remoteId) return { type: state.startPromise ? SessionStatusType.BUSY : SessionStatusType.IDLE }
    if (this.getPendingApproval(state.localId)) return { type: SessionStatusType.WAITING_APPROVAL }
    switch (state.session?.status) {
      case 'queued': case 'leased': case 'running': return { type: SessionStatusType.BUSY }
      case 'failed': return { type: SessionStatusType.ERROR, message: 'The runner reported a failure.' }
      default: return { type: SessionStatusType.IDLE }
    }
  }

  async pollMessages(sessionId: string): Promise<MessagePart[]> {
    const state = this.lookup(sessionId)
    if (!state) return []
    // Signed out or access revoked: nothing is polled until the user signs in again.
    if (state.authPaused) {
      if (this.host.isSignedIn?.() === false) return state.buffer.splice(0)
      state.authPaused = false
      void this.startStream(state)
    }
    // Fallback while the stream is down: poll the delta endpoint (rate limited).
    if (state.remoteId && !state.connected && !state.closed && this.now() - state.lastDeltaAt >= 2000) {
      state.lastDeltaAt = this.now()
      try {
        await this.catchUp(state)
        state.lastEventAt = this.now()
      } catch (error) {
        if (error instanceof RunnerHttpError && error.kind === 'auth') { state.authPaused = true; this.publish(state) }
        // Otherwise offline: keep what we have; the stream loop keeps retrying.
      }
    }
    return state.buffer.splice(0)
  }

  async getAllMessages(sessionId: string): Promise<SessionMessage[]> {
    const state = this.lookup(sessionId)
    return state ? this.messagesFromState(state) : []
  }

  async getPersistedMessages(sessionId: string): Promise<SessionMessage[]> {
    const state = this.lookup(sessionId)
    const remoteId = state?.remoteId ?? sessionId
    const page = await this.host.api.transcript(remoteId)
    const scratch = state ?? this.newState(sessionId, { agentId: '', taskId: '', workspaceDir: '' }, '', remoteId)
    if (!state) this.applyPage(scratch, page, { emit: false })
    else this.applyPage(state, page, { emit: false })
    return this.messagesFromState(scratch)
  }

  private messagesFromState(state: SessionState): SessionMessage[] {
    return [...state.parts.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((p) => ({
        id: p.partId,
        role: p.role === 'user' ? MessageRole.USER : p.role === 'system' ? MessageRole.SYSTEM : MessageRole.ASSISTANT,
        parts: [wirePartToMessagePart(p)]
      }))
  }

  async getProviders(): Promise<{ providers: { id: string; name: string; models: unknown }[]; default: Record<string, string> } | null> {
    try {
      const runners = normaliseRunners(await this.host.api.listRunnersRaw(), this.now())
      return providersFromRunners(runners)
    } catch {
      return null
    }
  }

  // ── transcript ingestion ───────────────────────────────────────────

  /** Returns true when the page was truncated and more parts are waiting. */
  private applyPage(state: SessionState, page: WireTranscriptPage, opts: { emit: boolean }): boolean {
    const ordered = [...page.parts].sort((a, b) => a.seq - b.seq || a.rev - b.rev)
    for (const part of ordered) this.upsert(state, part, opts.emit)
    if (page.session) state.session = page.session
    // A truncated page only advances the cursor to the highest part actually
    // applied (done per part in `upsert`); `maxRev` would skip the rest.
    if (!page.truncated) this.bumpRev(state, page.maxRev)
    this.publish(state)
    return page.truncated === true
  }

  /** Fetches deltas from the cursor until the server says nothing is left. */
  private async catchUp(state: SessionState): Promise<void> {
    if (!state.remoteId) return
    for (let i = 0; i < 100; i++) {
      const before = state.rev
      const page = await this.host.api.delta(state.remoteId, state.rev)
      const more = this.applyPage(state, page, { emit: true })
      if (!more || state.rev === before) return
    }
  }

  /** Advances the cursor and persists it, so a restart resumes from here. */
  private bumpRev(state: SessionState, rev: number): void {
    if (rev > state.rev) state.rev = rev
    if (state.remoteId && state.rev !== state.persistedRev) {
      state.persistedRev = state.rev
      this.host.store.set(this.revKey(state.remoteId), String(state.rev))
    }
  }

  /** Idempotent by `partId`: a replay is a no-op, a changed part is an update. */
  private upsert(state: SessionState, part: WirePart, emit: boolean): void {
    const prev = state.parts.get(part.partId)
    const sig = signature(part)
    if (prev && state.emitted.get(part.partId) === sig) return
    // A rev lower than what we hold is an old copy (reordered delivery).
    if (prev && part.rev < prev.rev) return
    state.parts.set(part.partId, part)
    state.emitted.set(part.partId, sig)
    this.bumpRev(state, part.rev)

    const approval = parseApproval(part)
    if (approval) state.approvals.set(part.partId, approval)

    const usage = extractTurnUsage(part)
    if (usage && !state.usageSeen.has(part.partId)) {
      state.usageSeen.add(part.partId)
      state.usage.tokens += usage.tokens
      state.usage.costUsd += usage.costUsd ?? 0
      state.usage.credits += usage.credits ?? 0
      if (emit) {
        this.onUsage?.({
          kind: 'discrete', provider: 'enterprise-runner', providerSessionId: state.remoteId ?? undefined,
          taskId: state.taskId, agentId: state.config.agentId,
          items: [{
            sourceKey: `${state.remoteId}:${part.partId}`, model: usage.model, occurredAt: Date.parse(part.createdAt) || undefined,
            usage: usageTotals(usage)
          }]
        })
      }
      return
    }

    if (part.role === 'user' && this.consumeOwnEcho(state, part)) return
    if (part.role === 'user' && part.userId && part.userId !== this.host.currentUserId()) {
      state.lastForeignMessageAt = this.now()
    }
    if (emit) state.buffer.push(wirePartToMessagePart(part, { update: !!prev }))
  }

  /**
   * Our own message comes back as a part carrying our `clientMessageId`; hide
   * that one echo. Matching is by id only: identical text typed in Spaces is a
   * different message and is always shown.
   */
  private consumeOwnEcho(state: SessionState, part: WirePart): boolean {
    const id = (part.payload as { clientMessageId?: unknown } | null)?.clientMessageId
    return typeof id === 'string' && state.sentMessageIds.delete(id)
  }

  // ── stream loop ────────────────────────────────────────────────────

  private async startStream(state: SessionState): Promise<void> {
    if (state.streaming || state.closed || !state.remoteId) return
    state.streaming = true
    const base = this.host.reconnectBaseMs ?? 1000
    const max = this.host.reconnectMaxMs ?? 30_000
    try {
      while (!state.closed && state.remoteId) {
        const controller = new AbortController()
        state.controller = controller
        try {
          for await (const event of this.host.api.stream(state.remoteId, state.rev, controller.signal)) {
            if (!state.connected) { state.connected = true; state.reconnectAttempts = 0; this.publish(state) }
            state.lastEventAt = this.now()
            if (event.type === 'parts') {
              if (this.applyPage(state, event.page, { emit: true })) await this.catchUp(state)
            } else if (event.type === 'session') { state.session = event.session; this.publish(state); this.notify(state) }
            if (event.id !== null && !(event.type === 'parts' && event.page.truncated)) this.bumpRev(state, event.id)
            this.notify(state)
          }
        } catch (error) {
          if (state.closed) return
          if (error instanceof RunnerHttpError && error.kind === 'auth') {
            // Signed out or revoked: stop looping; `pollMessages` restarts after sign-in.
            state.authPaused = true
            state.connected = false
            this.publish(state)
            return
          }
          if (error instanceof RunnerHttpError && (error.kind === 'forbidden' || error.kind === 'not-found')) {
            state.session = state.session ? { ...state.session, status: 'failed' } : state.session
            state.connected = false
            this.publish(state)
            return
          }
        }
        if (state.closed) return
        state.connected = false
        this.publish(state)
        state.reconnectAttempts++
        // Abortable: detaching the session ends the wait at once.
        const signal = state.loopAbort.signal
        await Promise.race([
          this.sleep(Math.min(max, base * 2 ** Math.min(state.reconnectAttempts - 1, 10))),
          new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
        ])
      }
    } finally {
      state.streaming = false
    }
  }

  private notify(state: SessionState): void {
    if (state.buffer.length > 0 || state.session) this.onDataAvailable?.(state.localId)
  }

  private publish(state: SessionState): void {
    this.host.onSnapshot?.(this.snapshot(state))
  }

  private snapshot(state: SessionState): RunnerSyncSnapshot {
    return {
      taskId: state.taskId, remoteSessionId: state.remoteId, serverTaskId: state.serverTaskId, runnerId: state.runnerId,
      connected: state.connected, session: state.session, rev: state.rev, lastEventAt: state.lastEventAt,
      lastForeignMessageAt: state.lastForeignMessageAt, usage: { ...state.usage }
    }
  }

  /** For the sync service and tests. */
  getSnapshot(sessionId: string): RunnerSyncSnapshot | null {
    const state = this.lookup(sessionId)
    return state ? this.snapshot(state) : null
  }
}

function usageTotals(usage: TurnUsage): UsageTotals {
  return { ...ZERO_TOKEN_COUNTS, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd }
}

/** Ports of local services (secret broker, local MCP servers) whose URLs must never reach a runner. */
function localServicePorts(config: SessionConfig): number[] {
  const ports = new Set<number>()
  if (config.secretBrokerPort) ports.add(config.secretBrokerPort)
  for (const server of Object.values(config.mcpServers ?? {})) {
    if (!server.url) continue
    try {
      const u = new URL(server.url)
      if (u.port) ports.add(Number(u.port))
    } catch { /* not a URL */ }
  }
  return [...ports]
}

export function providersFromRunners(runners: EnterpriseRunner[]): { providers: { id: string; name: string; models: unknown }[]; default: Record<string, string> } {
  const seen = new Map<string, string>()
  for (const r of runners) for (const h of r.harnesses) if (!seen.has(h.name)) seen.set(h.name, h.name)
  return {
    providers: [...seen.keys()].map((id) => ({ id, name: id, models: {} })),
    default: {}
  }
}
