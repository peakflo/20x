/**
 * The one Spaces runners client: machines (Settings → Machines, Connect this
 * computer) and running tasks on runners (task-linked sessions, messages, the
 * SSE transcript, artifacts), all through the enterprise auth (`apiRequest`
 * refreshes the JWT on 401). The SSE stream uses a fresh JWT per connection and
 * `Last-Event-ID`, so a token that expires mid-stream is replaced on reconnect.
 *
 * `RunnerApi` is the small interface the adapter and runner service depend on,
 * so tests can drive them with a fake.
 */

import { computerServiceInstance } from './service-instance'
import { assertRequestBodySafe, redactLocalServices, scrubForLog } from './scrub'
import {
  type ConnectionRecord,
  isPublishedHarnessVersion,
  normaliseMachines,
  type ConnectVendor,
  type MachineActionResult,
  type MachinesFailure,
  type MachinesResult,
  type RawByoMachine,
  type RawRunner
} from '../../shared/enterprise-runners'

// ── Wire types ───────────────────────────────────────────────────────

/** A transcript part exactly as the control plane serves it. */
export interface WirePart {
  partId: string
  seq: number
  role: 'user' | 'assistant' | 'system'
  content: string
  partType: string
  tool: string | null
  payload: unknown
  /** ISO 8601 UTC. */
  createdAt: string
  rev: number
  userId?: string | null
}

export type WireSessionStatus = 'idle' | 'queued' | 'leased' | 'running' | 'completed' | 'failed' | 'aborted'

export interface WireSession {
  id: string
  userId?: string | null
  agentId?: string
  humanTaskId?: string | null
  title?: string
  status: WireSessionStatus
  runtime?: string
  runnerId: string | null
  metadata?: Record<string, unknown>
  repositories?: Array<{ fullName: string; status: string; reason?: string }>
  lastActivityAt?: string
  canReply?: boolean
  canAnswer?: boolean
}

export interface WireTranscriptPage {
  parts: WirePart[]
  maxRev: number
  session?: WireSession
  truncated?: boolean
}

export type StreamEvent =
  | { type: 'parts'; id: number | null; page: WireTranscriptPage }
  | { type: 'session'; id: number | null; session: WireSession }
  | { type: 'heartbeat'; id: number | null }

export interface CodingAgentRow {
  agentId: string
  name: string
  backend: string
  permissionMode: string
  runnerId?: string | null
}

export interface WireArtifactFile {
  filename: string
  encoding: string
  sizeBytes: number
  updatedAt: string | null
  content?: string | null
}

export interface WireArtifact {
  artifactId: string
  title: string
  type: string
  previewFilename: string | null
  fileCount: number
  totalBytes: number
  createdAt: string | null
  updatedAt: string | null
  files: WireArtifactFile[]
}

export interface StartSessionInput {
  agentId: string
  runnerId?: string
  title?: string
  message: string
  /** `owner/name` tags. */
  repositories?: string[]
  /** Idempotency key. TODO(server): not honoured by POST /sessions yet. */
  clientRequestId: string
}

export class RunnerHttpError extends Error {
  constructor(message: string, readonly status: number | null, readonly kind: 'auth' | 'forbidden' | 'not-found' | 'network' | 'server') {
    super(message)
    this.name = 'RunnerHttpError'
  }
}

// ── Interface ────────────────────────────────────────────────────────

export interface RunnerApi {
  listRunnersRaw(): Promise<RawRunner[]>
  listAgents(): Promise<CodingAgentRow[]>
  /**
   * Starts a chat on a runner and links it to a Spaces task.
   *
   * Uses the task-linked route `POST /api/tasks/:taskId/session` with
   * `runnerId` and `clientRequestId` (idempotent: a retry returns the same
   * chat, and reusing the id on another task is 409 CLIENT_REQUEST_ID_REUSED).
   * A server that predates it refuses the extra keys; then this falls back to
   * `POST /sessions` followed by `POST /sessions/:id/task`.
   *
   * `onCreated` runs as soon as the session id is known (`attached` is false on
   * the fallback path, before the attach call), so the caller can persist it and
   * repair a crash between the two calls.
   */
  startTaskSession(
    taskId: string,
    input: StartSessionInput,
    onCreated?: (session: WireSession, attached: boolean) => void
  ): Promise<{ session: WireSession }>
  attachTask(sessionId: string, taskId: string): Promise<void>
  getSession(sessionId: string): Promise<WireSession | null>
  sendMessage(sessionId: string, input: { content: string; clientMessageId: string; delivery?: 'auto' | 'stop-and-send' }): Promise<void>
  answer(sessionId: string, input: { partId: string; answer: string; optionId?: string }): Promise<void>
  abort(sessionId: string): Promise<void>
  end(sessionId: string): Promise<void>
  transcript(sessionId: string): Promise<WireTranscriptPage>
  delta(sessionId: string, sinceRev: number): Promise<WireTranscriptPage>
  /** Opens one SSE connection. Resolves events until the server closes it. */
  stream(sessionId: string, sinceRev: number, signal: AbortSignal): AsyncGenerator<StreamEvent>
  listArtifacts(sessionId: string): Promise<WireArtifact[]>
  /** Local secret values that must never appear in a request body. */
  setKnownSecrets(values: Iterable<string>): void
  /** Ports of local services (broker, local MCP): their URLs are removed from message text. */
  setLocalServicePorts?(ports: Iterable<number>): void
}

// ── SSE parsing ──────────────────────────────────────────────────────

/** Incremental SSE parser. Exported for tests. */
export class SseParser {
  private buffer = ''
  private event = 'message'
  private data: string[] = []
  private id: string | null = null

  push(chunk: string): Array<{ event: string; data: string; id: string | null }> {
    this.buffer += chunk
    const out: Array<{ event: string; data: string; id: string | null }> = []
    let nl: number
    while ((nl = this.buffer.search(/\r\n|\n|\r/)) >= 0) {
      const sep = this.buffer.slice(nl).startsWith('\r\n') ? 2 : 1
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + sep)
      if (line === '') {
        if (this.data.length > 0) out.push({ event: this.event, data: this.data.join('\n'), id: this.id })
        this.event = 'message'
        this.data = []
        this.id = null
      } else if (line.startsWith(':')) {
        // comment / keep-alive
      } else {
        const idx = line.indexOf(':')
        const field = idx < 0 ? line : line.slice(0, idx)
        const value = idx < 0 ? '' : line.slice(idx + 1).replace(/^ /, '')
        if (field === 'event') this.event = value
        else if (field === 'data') this.data.push(value)
        else if (field === 'id') this.id = value
      }
    }
    return out
  }
}

export function parseStreamFrame(frame: { event: string; data: string; id: string | null }): StreamEvent | null {
  const id = frame.id !== null && /^\d+$/.test(frame.id) ? Number(frame.id) : null
  if (frame.event === 'heartbeat' || frame.event === 'ping') return { type: 'heartbeat', id }
  let json: unknown
  try { json = JSON.parse(frame.data) } catch { return null }
  if (!json || typeof json !== 'object') return null
  if (frame.event === 'parts') {
    const page = json as WireTranscriptPage
    return { type: 'parts', id, page: { ...page, parts: Array.isArray(page.parts) ? page.parts : [], maxRev: Number(page.maxRev) || 0 } }
  }
  if (frame.event === 'session') {
    const session = (json as { session?: WireSession }).session
    return session ? { type: 'session', id, session } : null
  }
  return null
}

// ── HTTP implementation ──────────────────────────────────────────────

/**
 * The slice of `EnterpriseAuth` this module needs. Kept as an interface so the
 * sibling "run tasks on enterprise runners" work shares this client and tests
 * can pass a fake.
 */
export interface EnterpriseRequester {
  apiRequest(method: string, path: string, body?: unknown): Promise<unknown>
  getApiUrl(): string
  isSignedIn(): Promise<boolean>
  /** Fresh JWT for an SSE connection (a long-lived stream cannot use `apiRequest`). */
  getJwt?(): Promise<string>
  refreshToken?(): Promise<{ token: string }>
  /** Tenant and user ids of the signed-in session (not secrets). */
  getIdentity?(): Promise<{ tenantId: string; userId: string } | null>
}

export class EnterpriseRunnersApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message)
    this.name = 'EnterpriseRunnersApiError'
  }
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

/** Map any thrown value to a UI state. 401/session errors mean "sign in". */
export function toFailure(error: unknown): MachinesFailure {
  const message = error instanceof Error ? error.message : String(error)
  const status = statusOf(error)
  if (status === 403) return { kind: 'permission_denied', message }
  if (status === 401 || /sign in again|session expired|not signed in|not authenticated/i.test(message)) {
    return { kind: 'not_signed_in', message: 'Sign in to Peakflo Enterprise to manage machines.' }
  }
  return { kind: 'unavailable', message }
}

export interface HarnessVersionInfo {
  /** `null` until the server publishes a pin. */
  version: string | null
  nodeEngines: string | null
}

export interface ConnectionInfo {
  /** The one-time connection id. This is all the CLI is given. */
  connectionId: string
  expiresAt: string | null
}

/**
 * Machines and runners API. Routes (workflow-api):
 *
 *   GET    /api/onboarding/byo/machines
 *   PATCH  /api/onboarding/byo/machines/:id        { name }
 *   DELETE /api/onboarding/byo/machines/:id
 *   POST   /api/onboarding/byo/machines/:id/update-now
 *   GET    /api/coding-agents/runners
 *   GET    /api/onboarding/byo/harness-version      (public; the server's pin)
 *   POST   /api/onboarding/byo/tokens               (connection id)
 *
 * TODO(server): a first-class `protocolRefused` flag on both list routes. Until
 * then "refused (426)" is read from `update.state === 'refused'` or the runner's
 * unselectable reason.
 */
const SESSIONS_BASE = '/api/coding-agents'

/**
 * The one Spaces runners client: machines (Settings → Machines, Connect this
 * computer) and running tasks on runners (task-linked sessions, messages, the
 * SSE transcript, artifacts). It implements `RunnerApi`, the seam the adapter
 * and the runner service depend on.
 */
export class EnterpriseRunnersApi implements RunnerApi {
  private knownSecrets = new Set<string>()
  private localPorts = new Set<number>()

  constructor(
    private readonly requester: EnterpriseRequester,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async requireJwt(): Promise<string> {
    if (!this.requester.getJwt) throw new RunnerHttpError('Streaming needs an authenticated session.', 401, 'auth')
    return this.requester.getJwt()
  }

  getApiUrl(): string {
    return this.requester.getApiUrl()
  }

  /** `computer-<scope>` for the signed-in user on this control plane, if it can be computed. */
  async getComputerInstance(): Promise<string | null> {
    try {
      const identity = await this.requester.getIdentity?.()
      if (!identity) return null
      // The exact string 20x passes as --control-plane (see buildConnectCommand: the origin).
      return computerServiceInstance(new URL(this.requester.getApiUrl()).origin, identity.tenantId, identity.userId)
    } catch {
      return null
    }
  }

  async getHarnessVersion(): Promise<HarnessVersionInfo> {
    const raw = (await this.requester.apiRequest('GET', '/api/onboarding/byo/harness-version')) as {
      version?: unknown
      nodeEngines?: unknown
    } | null
    return {
      version: isPublishedHarnessVersion(raw?.version) ? raw.version : null,
      nodeEngines: typeof raw?.nodeEngines === 'string' ? raw.nodeEngines : null
    }
  }

  /**
   * Create the connection id with the user's session. The server returns no
   * enrolment token for a computer connection (the browser approval exchanges
   * one directly with the CLI), and this method refuses a response that does.
   */
  async createConnection(vendors: ConnectVendor[], replacesRunnerId?: string): Promise<ConnectionInfo> {
    const raw = (await this.requester.apiRequest('POST', '/api/onboarding/byo/tokens', {
      discover: true,
      allowed_vendor_backends: vendors,
      ...(replacesRunnerId ? { replaces_runner_id: replacesRunnerId } : {})
    })) as { tokenId?: unknown; expiresAt?: unknown; enrolmentToken?: unknown } | null
    if (typeof raw?.tokenId !== 'string') {
      throw new EnterpriseRunnersApiError('The server did not return a connection id.', null)
    }
    // Never carry a secret the CLI does not need. If a server ever returns one,
    // it is dropped here and never stored or passed on.
    return { connectionId: raw.tokenId, expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null }
  }

  async listMachinesRaw(): Promise<RawByoMachine[]> {
    const raw = (await this.requester.apiRequest('GET', '/api/onboarding/byo/machines')) as {
      machines?: RawByoMachine[]
    } | null
    return Array.isArray(raw?.machines) ? raw.machines : []
  }

  async listRunnersRaw(): Promise<RawRunner[]> {
    const raw = (await this.requester.apiRequest('GET', '/api/coding-agents/runners')) as {
      runners?: RawRunner[]
    } | null
    return Array.isArray(raw?.runners) ? raw.runners : []
  }

  /**
   * One snapshot for the table. A failing runners list degrades to the
   * machines list (and the other way round) rather than failing the page; a
   * permission or sign-in problem on both is reported as such.
   */
  async listMachines(hostname?: string | null, connectionRecords: readonly ConnectionRecord[] = []): Promise<MachinesResult> {
    if (!(await this.requester.isSignedIn())) {
      return { ok: false, error: { kind: 'not_signed_in', message: 'Sign in to Peakflo Enterprise to manage machines.' } }
    }
    const [machines, runners, version] = await Promise.allSettled([
      this.listMachinesRaw(),
      this.listRunnersRaw(),
      this.getHarnessVersion()
    ])
    if (machines.status === 'rejected' && runners.status === 'rejected') {
      return { ok: false, error: toFailure(machines.reason) }
    }
    const pinned = version.status === 'fulfilled' ? version.value : { version: null, nodeEngines: null }
    return {
      ok: true,
      snapshot: {
        fetchedAt: Date.now(),
        pinnedVersion: pinned.version,
        nodeEngines: pinned.nodeEngines,
        machines: normaliseMachines({
          machines: machines.status === 'fulfilled' ? machines.value : null,
          runners: runners.status === 'fulfilled' ? runners.value : null,
          pinnedVersion: pinned.version,
          hostname,
          connectionRecords
        })
      }
    }
  }

  private async act(method: string, path: string, body?: unknown): Promise<MachineActionResult> {
    try {
      await this.requester.apiRequest(method, path, body)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: toFailure(error) }
    }
  }

  renameMachine(runnerId: string, name: string): Promise<MachineActionResult> {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 255) {
      return Promise.resolve({ ok: false, error: { kind: 'unavailable', message: 'Enter a name up to 255 characters.' } })
    }
    return this.act('PATCH', `/api/onboarding/byo/machines/${encodeURIComponent(runnerId)}`, { name: trimmed })
  }

  /** Deregisters. The service keeps running on that computer until uninstalled there. */
  removeMachine(runnerId: string): Promise<MachineActionResult> {
    return this.act('DELETE', `/api/onboarding/byo/machines/${encodeURIComponent(runnerId)}`)
  }

  /** Allowed while the machine is busy; the machine keeps its id and pinned agents. */
  updateMachine(runnerId: string): Promise<MachineActionResult> {
    return this.act('POST', `/api/onboarding/byo/machines/${encodeURIComponent(runnerId)}/update-now`)
  }

  // ── Running tasks on runners (sessions) ────────────────────────
  /** Adds to the guard: the set only grows for the life of the runtime. */
  setKnownSecrets(values: Iterable<string>): void {
    for (const v of values) if (v) this.knownSecrets.add(v)
  }

  private async callAbsolute<T>(method: string, path: string, body?: unknown): Promise<T> {
    assertRequestBodySafe(body, this.knownSecrets)
    try {
      return (await this.requester.apiRequest(method, path, body)) as T
    } catch (error) {
      console.warn(`[EnterpriseRunner] ${method} ${path} failed: ${scrubForLog(error, this.knownSecrets)}`)
      throw classify(error)
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    assertRequestBodySafe(body, this.knownSecrets)
    try {
      return (await this.requester.apiRequest(method, `${SESSIONS_BASE}${path}`, body)) as T
    } catch (error) {
      // The message can echo server text; never let a token or secret into logs.
      console.warn(`[EnterpriseRunner] ${method} ${path} failed: ${scrubForLog(error, this.knownSecrets)}`)
      throw classify(error)
    }
  }

  async listAgents(): Promise<CodingAgentRow[]> {
    const res = await this.call<CodingAgentRow[] | { agents: CodingAgentRow[] }>('GET', '/agents')
    return Array.isArray(res) ? res : res?.agents ?? []
  }

  setLocalServicePorts(ports: Iterable<number>): void {
    this.localPorts = new Set(ports)
  }

  async attachTask(sessionId: string, taskId: string): Promise<void> {
    await this.call('POST', `/sessions/${encodeURIComponent(sessionId)}/task`, { taskId })
  }

  async startTaskSession(
    taskId: string,
    input: StartSessionInput,
    onCreated?: (session: WireSession, attached: boolean) => void
  ): Promise<{ session: WireSession }> {
    // Explicit allowlist: nothing from the local session config is copied.
    const message = redactLocalServices(input.message, this.localPorts)
    const body = {
      agentId: input.agentId,
      ...(input.runnerId ? { runnerId: input.runnerId } : {}),
      ...(input.title ? { title: input.title } : {}),
      message,
      ...(input.repositories?.length ? { repositories: input.repositories } : {}),
      clientRequestId: input.clientRequestId
    }
    try {
      const linked = await this.callAbsolute<{ sessionId: string }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/session`, {
        agentId: input.agentId,
        ...(input.runnerId ? { runnerId: input.runnerId } : {}),
        message,
        ...(input.repositories?.length ? { repositories: input.repositories } : {}),
        clientRequestId: input.clientRequestId
      })
      const session = (await this.getSession(linked.sessionId)) ?? { id: linked.sessionId, status: 'queued' as const, runnerId: input.runnerId ?? null }
      onCreated?.(session, true)
      return { session }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      // Never fall back on a real refusal (reused id, policy, auth): only on a server that predates the route.
      if (/CLIENT_REQUEST_ID_REUSED/.test(text) || !/unrecognized|unknown key|\(400\)|\(404\)|not found|invalid (request|body)/i.test(text)) throw error
    }
    const created = await this.call<{ session: WireSession }>('POST', '/sessions', body)
    onCreated?.(created.session, false)
    await this.attachTask(created.session.id, taskId)
    return created
  }

  async getSession(sessionId: string): Promise<WireSession | null> {
    try {
      const res = await this.call<{ session: WireSession } | WireSession>('GET', `/sessions/${encodeURIComponent(sessionId)}`)
      return (res as { session?: WireSession }).session ?? (res as WireSession)
    } catch (error) {
      if (error instanceof RunnerHttpError && error.kind === 'not-found') return null
      throw error
    }
  }

  async sendMessage(sessionId: string, input: { content: string; clientMessageId: string; delivery?: 'auto' | 'stop-and-send' }): Promise<void> {
    await this.call('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, {
      content: redactLocalServices(input.content, this.localPorts),
      clientMessageId: input.clientMessageId,
      ...(input.delivery ? { delivery: input.delivery } : {})
    })
  }

  async answer(sessionId: string, input: { partId: string; answer: string; optionId?: string }): Promise<void> {
    await this.call('POST', `/sessions/${encodeURIComponent(sessionId)}/answer`, {
      partId: input.partId,
      answer: input.answer,
      ...(input.optionId ? { optionId: input.optionId } : {})
    })
  }

  async abort(sessionId: string): Promise<void> {
    await this.call('POST', `/sessions/${encodeURIComponent(sessionId)}/abort`)
  }

  async end(sessionId: string): Promise<void> {
    await this.call('POST', `/sessions/${encodeURIComponent(sessionId)}/end`)
  }

  transcript(sessionId: string): Promise<WireTranscriptPage> {
    return this.call('GET', `/sessions/${encodeURIComponent(sessionId)}/transcript`)
  }

  delta(sessionId: string, sinceRev: number): Promise<WireTranscriptPage> {
    return this.call('GET', `/sessions/${encodeURIComponent(sessionId)}/transcript/delta?sinceRev=${sinceRev}`)
  }

  async listArtifacts(sessionId: string): Promise<WireArtifact[]> {
    const res = await this.call<{ artifacts: WireArtifact[] }>('GET', `/sessions/${encodeURIComponent(sessionId)}/artifacts`)
    return res?.artifacts ?? []
  }

  async *stream(sessionId: string, sinceRev: number, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const url = `${this.requester.getApiUrl()}${SESSIONS_BASE}/sessions/${encodeURIComponent(sessionId)}/stream?sinceRev=${sinceRev}`
    let response: Response | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      // A fresh JWT per connection: a token that expired during the previous
      // stream is refreshed here, and `Last-Event-ID` resumes where it stopped.
      const jwt = await this.requireJwt()
      try {
        response = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${jwt}`, Accept: 'text/event-stream', 'Last-Event-ID': String(sinceRev) },
          signal
        })
      } catch (error) {
        throw classify(error)
      }
      if (response.status === 401 && attempt === 0) {
        await this.requester.refreshToken?.().catch(() => undefined)
        continue
      }
      break
    }
    if (!response || !response.ok || !response.body) {
      const status = response?.status ?? null
      throw new RunnerHttpError(`Stream failed (${status ?? 'no response'})`, status, status === 401 ? 'auth' : status === 403 ? 'forbidden' : status === 404 ? 'not-found' : 'server')
    }
    const parser = new SseParser()
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const event = parseStreamFrame(frame)
          if (event) yield event
        }
      }
    } catch (error) {
      if (signal.aborted) return
      throw classify(error)
    } finally {
      reader.cancel().catch(() => undefined)
    }
  }
}

function classify(error: unknown): RunnerHttpError {
  if (error instanceof RunnerHttpError) return error
  const message = error instanceof Error ? error.message : String(error)
  const status = statusOf(error)
  if (status === 401) return new RunnerHttpError(message, 401, 'auth')
  if (status === 403) return new RunnerHttpError(message, 403, 'forbidden')
  if (status === 404) return new RunnerHttpError(message, 404, 'not-found')
  if (/Session expired|sign in again/i.test(message)) return new RunnerHttpError(message, 401, 'auth')
  if (/Permission denied|\(403\)/i.test(message)) return new RunnerHttpError(message, 403, 'forbidden')
  if (/\(404\)|not found/i.test(message)) return new RunnerHttpError(message, 404, 'not-found')
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|socket|aborted/i.test(message)) return new RunnerHttpError(message, null, 'network')
  return new RunnerHttpError(message, null, 'server')
}

