import { create } from 'zustand'
import { api, type TranscriptPartRecord } from '../api/client'
import { onEvent } from '../api/websocket'
import { captureAnalyticsEvent } from '@/lib/analytics'

// ── Message types (mirrors desktop agent-store) ──────────────

export interface StepMeta {
  durationMs?: number
  tokens?: { input: number; output: number; cache: number }
}

export interface TaskProgressData {
  taskId: string
  status: 'started' | 'running' | 'completed' | 'failed' | 'stopped'
  description: string
  lastToolName?: string
  summary?: string
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  partType?: string
  stepMeta?: StepMeta
  tool?: {
    name: string
    status: string
    title?: string
    description?: string
    input?: string
    output?: string
    error?: string
    questions?: Array<{
      header: string
      question: string
      options: Array<{ label: string; description: string }>
    }>
    todos?: Array<{
      id: string
      content: string
      status: 'pending' | 'in_progress' | 'completed'
      priority?: string
    }>
  }
  taskProgress?: TaskProgressData
}

export enum SessionStatus {
  IDLE = 'idle',
  WORKING = 'working',
  ERROR = 'error',
  WAITING_APPROVAL = 'waiting_approval',
}

export interface TaskSession {
  sessionId: string | null
  agentId: string
  taskId: string
  status: SessionStatus
  /** Derived, read-only render list — a pure projection of the durable transcript. */
  messages: AgentMessage[]
  systemStatus?: string | null
  /**
   * True from the moment the user sends a message until the backend confirms the
   * turn is running (a non-idle status). Resuming an idle session is slow
   * (worktree + MCP + adapter.resumeSession) and even emits an interim `idle`
   * status, so we can't rely on status alone to show "starting". Cleared on the
   * first working/waiting/error status or a safety timeout.
   */
  pendingSend?: boolean
}

export interface Agent {
  id: string
  name: string
  server_url: string
  config: Record<string, unknown>
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface Skill {
  id: string
  name: string
  description: string
  agent_id: string | null
}

// ── Projection cache (SINGLE source of truth for the transcript) ──
// Identical model to the desktop store: the main process owns the durable
// transcript; the mobile client keeps a per-task cache keyed by stable part id
// and renders a derived sorted list. One write path: applyParts(), fed by a
// full snapshot on bind (REST) and idempotent `transcript:changed` deltas (WS).

interface ProjectionCache {
  parts: Map<string, TranscriptPartRecord>
  rev: number
}

const projections = new Map<string, ProjectionCache>()
const bindingTasks = new Set<string>()

/** Test-only: reset the module-level projection cache between tests. */
export function __clearProjectionsForTest(): void {
  projections.clear()
  bindingTasks.clear()
}

function getProjection(taskId: string): ProjectionCache {
  let p = projections.get(taskId)
  if (!p) { p = { parts: new Map(), rev: 0 }; projections.set(taskId, p) }
  return p
}

// Memoize the part → message projection per part record. Unchanged parts keep
// their exact record reference across deltas (applyParts only replaces changed
// entries), so reusing the derived AgentMessage preserves object identity and
// lets React.memo'd rows skip re-rendering the entire transcript on every
// streamed delta. Entries are GC'd with their part records (WeakMap).
const messageProjectionCache = new WeakMap<TranscriptPartRecord, AgentMessage>()

function toAgentMessage(p: TranscriptPartRecord): AgentMessage {
  const cached = messageProjectionCache.get(p)
  if (cached) return cached
  const payload = (p.payload || {}) as { taskProgress?: unknown }
  const message: AgentMessage = {
    id: p.partId,
    role: p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : 'system',
    content: p.content,
    timestamp: new Date(p.createdAt),
    partType: p.partType,
    tool: p.tool as AgentMessage['tool'],
    taskProgress: payload.taskProgress as AgentMessage['taskProgress']
  }
  messageProjectionCache.set(p, message)
  return message
}

function deriveMessages(cache: ProjectionCache): AgentMessage[] {
  return [...cache.parts.values()]
    .sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq))
    .map(toAgentMessage)
}

function findBySessionId(sessions: Map<string, TaskSession>, sid: string): TaskSession | undefined {
  for (const s of sessions.values()) {
    if (s.sessionId === sid) return s
  }
  return undefined
}

// ── Store ─────────────────────────────────────────────────────

interface AgentState {
  agents: Agent[]
  skills: Skill[]
  sessions: Map<string, TaskSession>
  fetchAgents: () => Promise<void>
  fetchSkills: () => Promise<void>
  syncActiveSessions: () => Promise<void>
  /** Bind a task view to the durable transcript projection (load snapshot). */
  bindTranscript: (taskId: string) => Promise<void>
  initSession: (taskId: string, sessionId: string, agentId: string) => void
  /** Mark a task as "starting" after the user sends, until a turn is confirmed. */
  beginSend: (taskId: string) => void
  /** Clear the "starting" indicator (e.g. the send request failed). */
  endSend: (taskId: string) => void
  endSession: (taskId: string) => void
  removeSession: (taskId: string) => void
  clearMessageDedup: (taskId: string) => void
  getSession: (taskId: string) => TaskSession | undefined
}

export const useAgentStore = create<AgentState>((set, get) => {
  const commitMessages = (taskId: string): void => {
    const messages = deriveMessages(getProjection(taskId))
    set((state) => {
      const existing = state.sessions.get(taskId)
      const session: TaskSession = existing
        ? { ...existing, messages }
        : { sessionId: null, agentId: '', taskId, status: SessionStatus.IDLE, messages }
      return { sessions: new Map(state.sessions).set(taskId, session) }
    })
  }

  const applyParts = (taskId: string, parts: TranscriptPartRecord[], maxRev?: number): void => {
    if (parts.length === 0 && maxRev == null) return
    const cache = getProjection(taskId)
    for (const p of parts) cache.parts.set(p.partId, p)
    if (typeof maxRev === 'number') cache.rev = Math.max(cache.rev, maxRev)
    commitMessages(taskId)
  }

  const bindTranscript = async (taskId: string): Promise<void> => {
    if (!taskId || bindingTasks.has(taskId)) return
    bindingTasks.add(taskId)
    try {
      const snapshot = await api.transcript.snapshot(taskId)
      if (!Array.isArray(snapshot) || snapshot.length === 0) return
      const maxRev = snapshot.reduce((m, p) => Math.max(m, p.rev || 0), 0)
      projections.set(taskId, { parts: new Map(snapshot.map((p) => [p.partId, p])), rev: maxRev })
      commitMessages(taskId)
    } catch (e) {
      console.error(`[mobile] bindTranscript failed for ${taskId}:`, e)
    } finally {
      bindingTasks.delete(taskId)
    }
  }

  const reconcileDelta = async (taskId: string): Promise<void> => {
    try {
      const sinceRev = getProjection(taskId).rev
      const { parts, maxRev } = await api.transcript.delta(taskId, sinceRev)
      if (parts.length > 0) applyParts(taskId, parts, maxRev)
      else if (maxRev > sinceRev) getProjection(taskId).rev = maxRev
    } catch (e) {
      console.error(`[mobile] reconcileDelta failed for ${taskId}:`, e)
    }
  }

  // ── WebSocket event subscriptions ──

  // Transcript content: the ONLY writer of messages. Idempotent delta apply.
  onEvent('transcript:changed', (payload) => {
    const event = payload as { taskId?: string; parts?: TranscriptPartRecord[]; maxRev?: number }
    if (!event?.taskId) return
    applyParts(event.taskId, event.parts || [], event.maxRev)
    const parts = event.parts || []
    if (parts.length > 0) {
      const s = get().sessions.get(event.taskId)
      const toolNames = Array.from(
        new Set(parts.map((p) => (p.tool as { name?: string } | undefined)?.name).filter(Boolean) as string[])
      ).sort()
      captureAnalyticsEvent('agent_output_batch_received', {
        task_id: event.taskId,
        agent_id: s?.agentId,
        session_id: s?.sessionId,
        message_count: parts.length,
        tool_names: toolNames
      })
    }
  })

  // Session state only (status / sessionId) — never messages.
  onEvent('agent:status', (payload) => {
    const event = payload as { sessionId: string; agentId: string; taskId: string; status: SessionStatus }
    const state = get()
    const session = findBySessionId(state.sessions, event.sessionId) || state.sessions.get(event.taskId)
    if (!session) {
      if (event.taskId && event.sessionId && event.status !== SessionStatus.IDLE) {
        set({
          sessions: new Map(state.sessions).set(event.taskId, {
            sessionId: event.sessionId,
            agentId: event.agentId || '',
            taskId: event.taskId,
            status: event.status,
            messages: deriveMessages(getProjection(event.taskId))
          })
        })
      } else if (event.taskId && event.status === SessionStatus.IDLE) {
        void bindTranscript(event.taskId)
      }
      return
    }
    const previousStatus = session.status
    const updated = { ...session, status: event.status }
    if (event.sessionId && session.sessionId !== event.sessionId) updated.sessionId = event.sessionId
    // The turn is confirmed running (or errored/awaiting input) — stop showing
    // "starting". Interim `idle` events during resume must NOT clear it.
    if (event.status !== SessionStatus.IDLE) updated.pendingSend = false
    set({ sessions: new Map(state.sessions).set(session.taskId, updated) })
    if (previousStatus !== event.status) {
      captureAnalyticsEvent('agent_session_status_changed', {
        task_id: session.taskId,
        agent_id: event.agentId || session.agentId,
        session_id: event.sessionId,
        previous_status: previousStatus,
        next_status: event.status,
        source: 'backend'
      })
    }
    if (event.status === SessionStatus.IDLE) void reconcileDelta(session.taskId)
  })

  // Clear a stuck "starting" indicator if the backend never reports a turn.
  const clearPendingSend = (taskId: string): void => {
    set((state) => {
      const s = state.sessions.get(taskId)
      if (!s?.pendingSend) return state
      return { sessions: new Map(state.sessions).set(taskId, { ...s, pendingSend: false }) }
    })
  }

  return {
    agents: [],
    skills: [],
    sessions: new Map(),

    fetchAgents: async () => {
      try {
        const agents = (await api.agents.list()) as Agent[]
        set({ agents })
      } catch (e) {
        console.error('Failed to fetch agents:', e)
      }
    },

    fetchSkills: async () => {
      try {
        const skills = (await api.skills.list()) as Skill[]
        set({ skills })
      } catch (e) {
        console.error('Failed to fetch skills:', e)
      }
    },

    bindTranscript,

    /**
     * Reconnect / first-connect: register active sessions and bind each one's
     * transcript from the durable projection (no replay push needed). Idle tasks
     * are bound on demand when their view opens (bindTranscript in the page).
     */
    syncActiveSessions: async () => {
      try {
        const activeSessions = (await api.sessions.list()) as Array<{
          sessionId: string; agentId: string; taskId: string; status: string
        }>
        if (activeSessions.length === 0) return

        set((state) => {
          const nextSessions = new Map(state.sessions)
          for (const active of activeSessions) {
            const existing = state.sessions.get(active.taskId)
            nextSessions.set(active.taskId, {
              sessionId: active.sessionId,
              agentId: active.agentId,
              taskId: active.taskId,
              status: active.status as SessionStatus,
              messages: existing?.messages || deriveMessages(getProjection(active.taskId))
            })
          }
          return { sessions: nextSessions }
        })

        await Promise.all(activeSessions.map((a) => bindTranscript(a.taskId)))
      } catch (e) {
        console.error('Failed to sync active sessions:', e)
      }
    },

    initSession: (taskId, sessionId, agentId) => {
      set((state) => {
        const existing = state.sessions.get(taskId)
        return {
          sessions: new Map(state.sessions).set(taskId, {
            sessionId,
            agentId,
            taskId,
            status: existing?.status || SessionStatus.WORKING,
            messages: existing?.messages || deriveMessages(getProjection(taskId))
          })
        }
      })
    },

    beginSend: (taskId) => {
      set((state) => {
        const s = state.sessions.get(taskId)
        if (!s) return state
        return { sessions: new Map(state.sessions).set(taskId, { ...s, pendingSend: true }) }
      })
      // Safety net: never leave the composer stuck if no status ever arrives.
      setTimeout(() => clearPendingSend(taskId), 120_000)
    },

    endSend: (taskId) => clearPendingSend(taskId),

    endSession: (taskId) => {
      set((state) => {
        const session = state.sessions.get(taskId)
        if (!session) return state
        return {
          sessions: new Map(state.sessions).set(taskId, { ...session, sessionId: null, status: SessionStatus.IDLE })
        }
      })
    },

    removeSession: (taskId) => {
      projections.delete(taskId)
      set((state) => {
        const next = new Map(state.sessions)
        next.delete(taskId)
        return { sessions: next }
      })
    },

    // No-op in the projection model (no client dedup state; the durable
    // projection is the source of truth).
    clearMessageDedup: () => {},

    getSession: (taskId) => get().sessions.get(taskId)
  }
})
