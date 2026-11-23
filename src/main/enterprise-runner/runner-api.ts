/**
 * Client for the Spaces coding-agent routes (`/api/coding-agents/*`).
 *
 * `RunnerApi` is the small interface the adapter and service depend on, so the
 * server routes that do not exist yet live behind one seam (see the TODO
 * markers) and tests can drive the adapter with a fake.
 *
 * Every request goes through the enterprise auth (`apiRequest` refreshes the
 * JWT on 401). The SSE stream uses a fresh JWT per connection and
 * `Last-Event-ID`, so a token that expires mid-stream is replaced on reconnect.
 */

import type { RawRunnerSummary } from '../../shared/enterprise-runners'
import { assertRequestBodySafe, scrubForLog } from './scrub'

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
  listRunners(): Promise<RawRunnerSummary[]>
  listAgents(): Promise<CodingAgentRow[]>
  /**
   * Starts a chat on a runner and links it to a Spaces task.
   *
   * TODO(server): `POST /api/tasks/:taskId/session` does not accept `runnerId`,
   * `runtime` or `clientRequestId` yet (companion server task). Until it does
   * this is `POST /sessions` (which takes `runnerId`) followed by
   * `POST /sessions/:id/task` (attach). A crash between the two calls can leave
   * an unlinked session; the adapter re-attaches on the next start.
   */
  startTaskSession(taskId: string, input: StartSessionInput): Promise<{ session: WireSession }>
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

export interface RunnerAuth {
  apiRequest(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<unknown>
  getJwt(): Promise<string>
  getApiUrl(): string
  refreshToken(): Promise<{ token: string }>
}

const BASE = '/api/coding-agents'

function classify(error: unknown): RunnerHttpError {
  if (error instanceof RunnerHttpError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/Session expired|sign in again/i.test(message)) return new RunnerHttpError(message, 401, 'auth')
  if (/Permission denied|\(403\)/i.test(message)) return new RunnerHttpError(message, 403, 'forbidden')
  if (/\(404\)|not found/i.test(message)) return new RunnerHttpError(message, 404, 'not-found')
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|socket|aborted/i.test(message)) return new RunnerHttpError(message, null, 'network')
  return new RunnerHttpError(message, null, 'server')
}

export class HttpRunnerApi implements RunnerApi {
  private knownSecrets = new Set<string>()

  constructor(private readonly auth: RunnerAuth, private readonly fetchImpl: typeof fetch = fetch) {}

  setKnownSecrets(values: Iterable<string>): void {
    this.knownSecrets = new Set([...values].filter(Boolean))
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    assertRequestBodySafe(body, this.knownSecrets)
    try {
      return (await this.auth.apiRequest(method, `${BASE}${path}`, body)) as T
    } catch (error) {
      // The message can echo server text; never let a token or secret into logs.
      console.warn(`[EnterpriseRunner] ${method} ${path} failed: ${scrubForLog(error, this.knownSecrets)}`)
      throw classify(error)
    }
  }

  async listRunners(): Promise<RawRunnerSummary[]> {
    const res = await this.call<RawRunnerSummary[] | { runners: RawRunnerSummary[] }>('GET', '/runners')
    return Array.isArray(res) ? res : res?.runners ?? []
  }

  async listAgents(): Promise<CodingAgentRow[]> {
    const res = await this.call<CodingAgentRow[] | { agents: CodingAgentRow[] }>('GET', '/agents')
    return Array.isArray(res) ? res : res?.agents ?? []
  }

  async startTaskSession(taskId: string, input: StartSessionInput): Promise<{ session: WireSession }> {
    // Explicit allowlist: nothing from the local session config is copied.
    const body = {
      agentId: input.agentId,
      ...(input.runnerId ? { runnerId: input.runnerId } : {}),
      ...(input.title ? { title: input.title } : {}),
      message: input.message,
      ...(input.repositories?.length ? { repositories: input.repositories } : {}),
      clientRequestId: input.clientRequestId
    }
    const created = await this.call<{ session: WireSession }>('POST', '/sessions', body)
    await this.call('POST', `/sessions/${encodeURIComponent(created.session.id)}/task`, { taskId })
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
      content: input.content,
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
    const url = `${this.auth.getApiUrl()}${BASE}/sessions/${encodeURIComponent(sessionId)}/stream?sinceRev=${sinceRev}`
    let response: Response | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      // A fresh JWT per connection: a token that expired during the previous
      // stream is refreshed here, and `Last-Event-ID` resumes where it stopped.
      const jwt = await this.auth.getJwt()
      try {
        response = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${jwt}`, Accept: 'text/event-stream', 'Last-Event-ID': String(sinceRev) },
          signal
        })
      } catch (error) {
        throw classify(error)
      }
      if (response.status === 401 && attempt === 0) {
        await this.auth.refreshToken().catch(() => undefined)
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
