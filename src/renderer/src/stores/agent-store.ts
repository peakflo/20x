import { create } from 'zustand'
import type { Agent, CreateAgentDTO, UpdateAgentDTO } from '@/types'
import { agentApi, agentSessionApi, onAgentStatus, onAgentApproval, onTranscriptChanged } from '@/lib/ipc-client'
import type { AgentStatusEvent, AgentApprovalRequest, TranscriptPartRecord, TranscriptChangedEvent } from '@/types/electron'
import { captureAnalyticsEvent } from '@/lib/analytics'

// ── Message type ──────────────────────────────────────────────

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

// ── Per-task session ──────────────────────────────────────────

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
  /** Derived, read-only render list — a pure projection of the durable transcript
   *  (`projections` cache), never mutated directly by live events. */
  messages: AgentMessage[]
  pendingApproval: AgentApprovalRequest | null
  /** Transient system status indicator (e.g. 'compacting'). */
  systemStatus?: string | null
  /**
   * True from the moment the user sends until the backend confirms the turn is
   * running (a non-idle status). Resuming an idle session is slow (worktree +
   * MCP + adapter.resumeSession) and emits an interim `idle` status, so status
   * alone can't drive a "starting" indicator. Cleared on the first
   * working/waiting/error status or a safety timeout.
   */
  pendingSend?: boolean
}

// ── Projection cache (SINGLE source of truth for the transcript) ──
//
// The main process owns the durable transcript (`transcript_parts`) and is the
// authoritative source. The renderer keeps a per-task cache keyed by stable
// part id and renders a *derived* sorted list. There is exactly one write path
// into a task's messages: applyParts(), fed by (a) a full snapshot on bind and
// (b) idempotent `transcript:changed` deltas. Because parts are keyed by id and
// sorted by (createdAt, seq), reordering, duplication, and collapse are
// structurally impossible — no dedup sets, no accumulation, no clear/replay.

interface ProjectionCache {
  parts: Map<string, TranscriptPartRecord>
  rev: number
}

const projections = new Map<string, ProjectionCache>()
const bindingTasks = new Set<string>()

function getProjection(taskId: string): ProjectionCache {
  let p = projections.get(taskId)
  if (!p) { p = { parts: new Map(), rev: 0 }; projections.set(taskId, p) }
  return p
}

function resetProjection(taskId: string): void {
  projections.delete(taskId)
}

/** Test-only: clear all projection caches between tests. */
export function __clearProjectionsForTest(): void {
  projections.clear()
  bindingTasks.clear()
}

function toAgentMessage(p: TranscriptPartRecord): AgentMessage {
  const payload = (p.payload || {}) as { taskProgress?: unknown }
  return {
    id: p.partId,
    role: p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : 'system',
    content: p.content,
    timestamp: new Date(p.createdAt),
    partType: p.partType,
    // `tool` already carries nested questions/todos as persisted by write-through.
    tool: p.tool as AgentMessage['tool'],
    taskProgress: payload.taskProgress as AgentMessage['taskProgress']
  }
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
  isLoading: boolean
  error: string | null
  sessions: Map<string, TaskSession>

  fetchAgents: () => Promise<void>
  createAgent: (data: CreateAgentDTO) => Promise<Agent | null>
  updateAgent: (id: string, data: UpdateAgentDTO) => Promise<Agent | null>
  deleteAgent: (id: string) => Promise<boolean>

  initSession: (taskId: string, sessionId: string, agentId: string) => void
  /** Mark a task as "starting" after the user sends, until a turn is confirmed. */
  beginSend: (taskId: string) => void
  /** Clear the "starting" indicator (e.g. the send request failed). */
  endSend: (taskId: string) => void
  /** Bind a task view to the durable transcript projection: load the full
   *  snapshot into the cache and render it. Idempotent; subsequent updates
   *  arrive as `transcript:changed` deltas. */
  hydrateTranscript: (taskId: string) => Promise<void>
  endSession: (taskId: string) => void
  removeSession: (taskId: string) => void
  clearMessageDedup: (taskId: string) => void
  getSession: (taskId: string) => TaskSession | undefined
  stopAndRemoveSessionForTask: (taskId: string) => Promise<void>
}

export const useAgentStore = create<AgentState>((set, get) => {
  // Recompute a task's derived messages from its projection cache and write it
  // into the session (creating a placeholder session if the view isn't bound yet,
  // e.g. a background-wake delta arriving before the user opens the task).
  const commitMessages = (taskId: string): void => {
    const cache = getProjection(taskId)
    const messages = deriveMessages(cache)
    set((state) => {
      const existing = state.sessions.get(taskId)
      const session: TaskSession = existing
        ? { ...existing, messages }
        : { sessionId: null, agentId: '', taskId, status: SessionStatus.IDLE, messages, pendingApproval: null }
      return { sessions: new Map(state.sessions).set(taskId, session) }
    })
  }

  // Apply a delta (or snapshot) of parts into the cache, idempotently by id.
  const applyParts = (taskId: string, parts: TranscriptPartRecord[], maxRev?: number): void => {
    if (parts.length === 0 && maxRev == null) return
    const cache = getProjection(taskId)
    for (const p of parts) cache.parts.set(p.partId, p)
    if (typeof maxRev === 'number') cache.rev = Math.max(cache.rev, maxRev)
    commitMessages(taskId)
  }

  const hydrateTranscript = async (taskId: string): Promise<void> => {
    if (!taskId || bindingTasks.has(taskId)) return
    if (typeof window.electronAPI?.agentSession?.getTranscriptSnapshot !== 'function') return
    bindingTasks.add(taskId)
    try {
      const snapshot = await agentSessionApi.getTranscriptSnapshot(taskId)
      if (snapshot.length === 0) return
      const maxRev = snapshot.reduce((m, p) => Math.max(m, p.rev || 0), 0)
      // Snapshot is the authoritative full state — replace the cache.
      projections.set(taskId, { parts: new Map(snapshot.map((p) => [p.partId, p])), rev: maxRev })
      commitMessages(taskId)
    } catch (err) {
      console.error(`[agent-store] hydrateTranscript failed for task ${taskId}:`, err)
    } finally {
      bindingTasks.delete(taskId)
    }
  }

  // Reconcile a task against the durable projection by fetching everything
  // changed since our cursor. Used as a safety net at idle to catch any delta
  // the renderer may have missed (dropped IPC event).
  const reconcileDelta = async (taskId: string): Promise<void> => {
    if (typeof window.electronAPI?.agentSession?.getTranscriptDelta !== 'function') return
    try {
      const sinceRev = getProjection(taskId).rev
      const { parts, maxRev } = await agentSessionApi.getTranscriptDelta(taskId, sinceRev)
      if (parts.length > 0) applyParts(taskId, parts, maxRev)
      else if (maxRev > sinceRev) getProjection(taskId).rev = maxRev
    } catch (err) {
      console.error(`[agent-store] reconcileDelta failed for task ${taskId}:`, err)
    }
  }

  // ── IPC event subscriptions ──

  // Transcript content: the ONLY writer of messages. Idempotent delta apply.
  onTranscriptChanged((event: TranscriptChangedEvent) => {
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

  // Session state only (status / pendingApproval / sessionId) — never messages.
  onAgentStatus((event: AgentStatusEvent) => {
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
            messages: deriveMessages(getProjection(event.taskId)),
            pendingApproval: null
          })
        })
        captureAnalyticsEvent('agent_session_status_changed', {
          task_id: event.taskId,
          agent_id: event.agentId,
          session_id: event.sessionId,
          previous_status: undefined,
          next_status: event.status,
          source: 'backend'
        })
      } else if (event.taskId && event.status === SessionStatus.IDLE) {
        // A session this window never observed just went idle — bind so its
        // output is rendered from the projection.
        void hydrateTranscript(event.taskId)
      }
      return
    }

    const previousStatus = session.status
    const updated = { ...session, status: event.status }
    if (event.sessionId && session.sessionId !== event.sessionId) updated.sessionId = event.sessionId
    if (event.status === SessionStatus.IDLE) updated.pendingApproval = null
    // Turn confirmed running (or errored/awaiting input) — stop showing
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

    // Safety-net reconcile at end of each turn — catches any missed delta.
    if (event.status === SessionStatus.IDLE) void reconcileDelta(session.taskId)
  })

  const clearPendingSend = (taskId: string): void => {
    set((state) => {
      const s = state.sessions.get(taskId)
      if (!s?.pendingSend) return state
      return { sessions: new Map(state.sessions).set(taskId, { ...s, pendingSend: false }) }
    })
  }

  onAgentApproval((event: AgentApprovalRequest) => {
    const state = get()
    const session = findBySessionId(state.sessions, event.sessionId)
    if (!session) return
    set({
      sessions: new Map(state.sessions).set(session.taskId, {
        ...session,
        pendingApproval: event,
        status: SessionStatus.WAITING_APPROVAL
      })
    })
    captureAnalyticsEvent('agent_approval_requested', {
      task_id: session.taskId,
      agent_id: session.agentId,
      session_id: event.sessionId,
      action: event.action,
      has_description: Boolean(event.description)
    })
  })

  // ── Return store ──

  return {
    agents: [],
    isLoading: false,
    error: null,
    sessions: new Map(),

    fetchAgents: async () => {
      set({ isLoading: true, error: null })
      try {
        const agents = await agentApi.getAll()
        set({ agents, isLoading: false })
      } catch (err) {
        set({ error: String(err), isLoading: false })
      }
    },

    createAgent: async (data) => {
      try {
        const agent = await agentApi.create(data)
        set((state) => ({ agents: [...state.agents, agent] }))
        captureAnalyticsEvent('agent_created', {
          agent_id: agent.id,
          coding_agent: agent.config?.coding_agent,
          model: agent.config?.model,
          is_default: agent.is_default
        })
        return agent
      } catch (err) {
        set({ error: String(err) })
        return null
      }
    },

    updateAgent: async (id, data) => {
      try {
        const updated = await agentApi.update(id, data)
        if (updated) {
          set((state) => ({ agents: state.agents.map((a) => (a.id === id ? updated : a)) }))
          captureAnalyticsEvent('agent_updated', {
            agent_id: updated.id,
            coding_agent: updated.config?.coding_agent,
            model: updated.config?.model,
            is_default: updated.is_default,
            changed_fields: Object.keys(data).sort()
          })
        }
        return updated || null
      } catch (err) {
        set({ error: String(err) })
        return null
      }
    },

    deleteAgent: async (id) => {
      try {
        const success = await agentApi.delete(id)
        if (success) {
          set((state) => ({ agents: state.agents.filter((a) => a.id !== id) }))
          captureAnalyticsEvent('agent_deleted', { agent_id: id })
        }
        return success
      } catch (err) {
        set({ error: String(err) })
        return false
      }
    },

    hydrateTranscript,

    initSession: (taskId, sessionId, agentId) => {
      set((state) => {
        const existing = state.sessions.get(taskId)
        return {
          sessions: new Map(state.sessions).set(taskId, {
            sessionId,
            agentId,
            taskId,
            status: existing?.status || SessionStatus.WORKING,
            // Messages are always the projection of the durable transcript.
            messages: existing?.messages || deriveMessages(getProjection(taskId)),
            pendingApproval: null
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
          sessions: new Map(state.sessions).set(taskId, {
            ...session,
            sessionId: null,
            status: SessionStatus.IDLE,
            pendingApproval: null
          })
        }
      })
    },

    removeSession: (taskId) => {
      resetProjection(taskId)
      set((state) => {
        const next = new Map(state.sessions)
        next.delete(taskId)
        return { sessions: next }
      })
    },

    // Retained for API compatibility. In the projection model there is no client
    // dedup state to clear and the message list is never rebuilt from replays,
    // so this is a no-op (the durable projection remains the source of truth).
    clearMessageDedup: () => {},

    stopAndRemoveSessionForTask: async (taskId) => {
      const session = get().sessions.get(taskId)
      if (session?.sessionId) {
        try {
          await agentSessionApi.stop(session.sessionId)
          captureAnalyticsEvent('agent_session_stopped', {
            task_id: taskId,
            agent_id: session.agentId,
            session_id: session.sessionId,
            source: 'task_cleanup'
          })
        } catch (err) {
          console.error('Failed to stop session:', err)
        }
      }
      get().removeSession(taskId)
    },

    getSession: (taskId) => get().sessions.get(taskId)
  }
})
