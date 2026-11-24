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

import type { RawRunner } from '../../shared/enterprise-runners'

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

