import { create } from 'zustand'
import type { Agent, CreateAgentDTO, UpdateAgentDTO } from '@/types'
import { agentApi, agentSessionApi, onAgentOutput, onAgentOutputBatch, onAgentStatus, onAgentApproval } from '@/lib/ipc-client'
import type { AgentOutputEvent, AgentOutputBatchEvent, AgentStatusEvent, AgentApprovalRequest } from '@/types/electron'

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
  messages: AgentMessage[]
  pendingApproval: AgentApprovalRequest | null
  /** Transient system status indicator (e.g. 'compacting') — cleared on next non-status message */
  systemStatus?: string | null
}

// Module-level dedup tracking (avoids unnecessary Zustand re-renders)
const seenIds = new Map<string, Set<string>>()
// Track last step-start timestamp per task for duration calculation
const stepStartTimes = new Map<string, number>()

function getSeen(taskId: string): Set<string> {
  if (!seenIds.has(taskId)) seenIds.set(taskId, new Set())
  return seenIds.get(taskId)!
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
  endSession: (taskId: string) => void
  removeSession: (taskId: string) => void
  clearMessageDedup: (taskId: string) => void
  getSession: (taskId: string) => TaskSession | undefined
  stopAndRemoveSessionForTask: (taskId: string) => Promise<void>
}

export const useAgentStore = create<AgentState>((set, get) => {
  const ensureSessionForEvent = (
    sessions: Map<string, TaskSession>,
    event: { taskId?: string; sessionId?: string; agentId?: string }
  ): { sessions: Map<string, TaskSession>; session?: TaskSession } => {
    const existing = (event.sessionId ? findBySessionId(sessions, event.sessionId) : undefined)
      || (event.taskId ? sessions.get(event.taskId) : undefined)
    if (existing) return { sessions, session: existing }
    if (!event.taskId || !event.sessionId) return { sessions, session: undefined }

    const nextSessions = new Map(sessions)
    const created: TaskSession = {
      sessionId: event.sessionId,
      agentId: event.agentId || '',
      taskId: event.taskId,
      status: SessionStatus.WORKING,
      messages: [],
      pendingApproval: null
    }
    nextSessions.set(event.taskId, created)
    return { sessions: nextSessions, session: created }
  }

  // ── IPC event subscriptions ──

  onAgentStatus((event: AgentStatusEvent) => {
    const state = get()
    const session = findBySessionId(state.sessions, event.sessionId)
      || state.sessions.get(event.taskId)

    // Auto-create session entry when a session is started remotely (e.g., from mobile)
    // so the desktop app can track and display it
    if (!session) {
      if (event.taskId && event.sessionId && event.status !== SessionStatus.IDLE) {
        set({
          sessions: new Map(state.sessions).set(event.taskId, {
            sessionId: event.sessionId,
            agentId: event.agentId || '',
            taskId: event.taskId,
            status: event.status,
            messages: [],
            pendingApproval: null
          })
        })
      }
      return
    }

    const updated = { ...session, status: event.status }
    // Patch in real sessionId when session was pre-registered with empty string
    // or when the main process re-keyed the session (temp ID → real ID)
    if (event.sessionId && session.sessionId !== event.sessionId) updated.sessionId = event.sessionId
    // Clear pending approval when session goes idle
    if (event.status === SessionStatus.IDLE) updated.pendingApproval = null
    set({ sessions: new Map(state.sessions).set(session.taskId, updated) })
  })

  onAgentOutput((event: AgentOutputEvent) => {
    const state = get()
    const ensured = ensureSessionForEvent(state.sessions, event)
    const session = ensured.session

    if (!session) return

    // Patch in real sessionId if needed
    const resolvedSession = (!session.sessionId && event.sessionId)
      ? { ...session, sessionId: event.sessionId }
      : session

    const data = event.data as Record<string, unknown>
    let role: 'user' | 'assistant' | 'system' = 'system'
    let content = ''
    let msgId = ''

    if (typeof data === 'object' && data !== null) {
      role = data.role === 'user' ? 'user' : data.role === 'assistant' ? 'assistant' : 'system'
      content = (data.content ?? data.text ?? data.message ?? '') as string
      msgId = (data.id || '') as string
    } else {
      content = String(data)
    }

    // Allow empty content for tool/question/taskProgress messages (they have structured data instead)
    if (!content && !data.tool && !data.questions && !data.todos && !data.taskProgress) return
    if (!msgId) msgId = (data.id as string) || `${role}-${content.slice(0, 50)}-${Date.now()}`

    const taskId = resolvedSession.taskId
    const seen = getSeen(taskId)

    // Absorb step-start: record timestamp, don't add as message
    if (data.partType === 'step-start') {
      seen.add(msgId)
      stepStartTimes.set(taskId, Date.now())
      return
    }

    // Absorb step-finish: annotate last message with duration + tokens
    if (data.partType === 'step-finish') {
      seen.add(msgId)
      const msgs = resolvedSession.messages
      if (msgs.length === 0) return

      const now = Date.now()
      const startTime = stepStartTimes.get(taskId)
      const durationMs = startTime ? now - startTime : undefined
      const tokens = data.stepTokens as { input: number; output: number; cache: number } | undefined
      stepStartTimes.delete(taskId)

      // Find last assistant message to annotate
      let targetIdx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') { targetIdx = i; break }
      }
      if (targetIdx === -1) return

      const updated = [...msgs]
      updated[targetIdx] = { ...updated[targetIdx], stepMeta: { durationMs, tokens } }
      set({
        sessions: new Map(state.sessions).set(taskId, {
          ...resolvedSession,
          messages: updated
        })
      })
      return
    }

    // Absorb system-status: store as transient indicator, don't add as message
    if (data.partType === 'system-status') {
      seen.add(msgId)
      set({
        sessions: new Map(state.sessions).set(taskId, {
          ...resolvedSession,
          systemStatus: content || null
        })
      })
      return
    }

    // Streaming update — replace content of existing message
    if (data.update && seen.has(msgId)) {
      set({
        sessions: new Map(state.sessions).set(taskId, {
          ...resolvedSession,
          systemStatus: null, // Clear transient status on real updates
          messages: resolvedSession.messages.map((m): AgentMessage => {
            if (m.id !== msgId) return m
            // Preserve todowrite/question/task_progress partType — don't let a generic 'tool' update overwrite them
            const keepPartType = m.partType === 'todowrite' || m.partType === 'question' || m.partType === 'planreview' || m.partType === 'task_progress'
            const newPartType = keepPartType ? m.partType : ((data.partType as string) || m.partType)
            // Merge tool objects so todos/questions are preserved across updates
            const newTool = data.tool ? { ...m.tool, ...(data.tool as AgentMessage['tool']) } as AgentMessage['tool'] : m.tool
            // Merge taskProgress data for task_progress updates
            const newTaskProgress = data.taskProgress
              ? { ...m.taskProgress, ...(data.taskProgress as AgentMessage['taskProgress']) } as AgentMessage['taskProgress']
              : m.taskProgress
            // Guard against stale task_progress overwriting a final status
            const isFinalStatus = m.taskProgress?.status === 'completed' || m.taskProgress?.status === 'failed' || m.taskProgress?.status === 'stopped'
            const incomingStatus = (data.taskProgress as AgentMessage['taskProgress'])?.status
            const guardedTaskProgress = (isFinalStatus && incomingStatus === 'running') ? m.taskProgress : newTaskProgress
            return { ...m, content, partType: newPartType, tool: newTool, taskProgress: guardedTaskProgress }
          })
        })
      })
      return
    }

    if (seen.has(msgId)) return
    seen.add(msgId)

    set({
      sessions: new Map(ensured.sessions).set(taskId, {
        ...resolvedSession,
        messages: [
          ...resolvedSession.messages,
          { id: msgId, role, content, timestamp: new Date(), partType: data.partType as string, tool: data.tool as AgentMessage['tool'], taskProgress: data.taskProgress as AgentMessage['taskProgress'] }
        ]
      })
    })
  })

  // ── Batched output handler with microtask debouncing ──
  // Collects batch events from ALL sessions and flushes them in a single
  // Zustand set() call on the next microtask. This prevents N separate state
  // updates (and N React re-renders) when multiple agents send parts in the
  // same polling tick, without depending on requestAnimationFrame firing.
  let pendingBatches: AgentOutputBatchEvent[] = []
  let batchFlushScheduled = false

  function flushPendingBatches(): void {
    batchFlushScheduled = false
    const batches = pendingBatches
    pendingBatches = []
    if (batches.length === 0) return

    const state = get()
    let nextSessions = new Map(state.sessions)
    let changed = false

    for (const event of batches) {
      const ensured = ensureSessionForEvent(nextSessions, event)
      nextSessions = ensured.sessions
      const session = ensured.session
      if (!session) continue

      const taskId = session.taskId
      const seen = getSeen(taskId)

      // Resolve sessionId: update when empty OR when main process re-keyed (temp → real)
      const currentSession = nextSessions.get(taskId) || session
      const resolvedSession = (event.sessionId && currentSession.sessionId !== event.sessionId)
        ? { ...currentSession, sessionId: event.sessionId }
        : currentSession

      let messages = [...resolvedSession.messages]
      let messagesChanged = false

      for (const msg of event.messages) {
        const role: AgentMessage['role'] = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system'
        const msgId = msg.id || `${role}-${(msg.content || '').slice(0, 50)}-${Date.now()}`
        const content = msg.content || ''

        // Absorb step-start: record timestamp, don't add as message
        if (msg.partType === 'step-start') {
          seen.add(msgId)
          stepStartTimes.set(taskId, Date.now())
          continue
        }

        // Absorb step-finish: annotate last assistant message with duration + tokens
        if (msg.partType === 'step-finish') {
          seen.add(msgId)
          const now = Date.now()
          const startTime = stepStartTimes.get(taskId)
          const durationMs = startTime ? now - startTime : undefined
          const tokens = (msg as Record<string, unknown>).stepTokens as { input: number; output: number; cache: number } | undefined
          stepStartTimes.delete(taskId)

          let targetIdx = -1
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') { targetIdx = i; break }
          }
          if (targetIdx !== -1) {
            messages[targetIdx] = { ...messages[targetIdx], stepMeta: { durationMs, tokens } }
            messagesChanged = true
          }
          continue
        }

        // Absorb system-status: store as transient indicator, don't add as message
        if (msg.partType === 'system-status') {
          seen.add(msgId)
          nextSessions.set(taskId, { ...resolvedSession, systemStatus: content || null })
          changed = true
          continue
        }

        // Streaming update — replace content of existing message
        if (msg.update && seen.has(msgId)) {
          messages = messages.map((m): AgentMessage => {
            if (m.id !== msgId) return m
            const keepPartType = m.partType === 'todowrite' || m.partType === 'question' || m.partType === 'planreview' || m.partType === 'task_progress'
            const newPartType = keepPartType ? m.partType : (msg.partType || m.partType)
            const newTool = msg.tool ? { ...m.tool, ...(msg.tool as AgentMessage['tool']) } as AgentMessage['tool'] : m.tool
            const msgData = msg as Record<string, unknown>
            const newTaskProgress = msgData.taskProgress
              ? { ...m.taskProgress, ...(msgData.taskProgress as AgentMessage['taskProgress']) } as AgentMessage['taskProgress']
              : m.taskProgress
            // Guard against stale task_progress overwriting a final status
            const isFinal = m.taskProgress?.status === 'completed' || m.taskProgress?.status === 'failed' || m.taskProgress?.status === 'stopped'
            const incoming = (msgData.taskProgress as AgentMessage['taskProgress'])?.status
            const guardedTP = (isFinal && incoming === 'running') ? m.taskProgress : newTaskProgress
            return { ...m, content, partType: newPartType, tool: newTool, taskProgress: guardedTP }
          })
          messagesChanged = true
          continue
        }

        // Skip already-seen messages
        if (seen.has(msgId)) continue
        seen.add(msgId)

        // Allow empty content for tool/question/task_progress messages
        if (!content && !msg.tool && !(msg as Record<string, unknown>).taskProgress) continue

        messages.push({
          id: msgId,
          role,
          content,
          timestamp: new Date(),
          partType: msg.partType,
          tool: msg.tool as AgentMessage['tool'],
          taskProgress: (msg as Record<string, unknown>).taskProgress as AgentMessage['taskProgress']
        })
        messagesChanged = true
      }

      if (messagesChanged) {
        nextSessions.set(taskId, { ...resolvedSession, messages, systemStatus: null })
        changed = true
      }
    }

    if (changed) {
      set({ sessions: nextSessions })
    }
  }

  onAgentOutputBatch((event: AgentOutputBatchEvent) => {
    pendingBatches.push(event)
    if (!batchFlushScheduled) {
      batchFlushScheduled = true
      queueMicrotask(flushPendingBatches)
    }
  })

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
        }
        return success
      } catch (err) {
        set({ error: String(err) })
        return false
      }
    },

    initSession: (taskId, sessionId, agentId) => {
      const existing = get().sessions.get(taskId)
      // Only clear dedup state for a truly new session (not a sessionId update)
      if (!existing) seenIds.delete(taskId)

      set((state) => ({
        sessions: new Map(state.sessions).set(taskId, {
          sessionId,
          agentId,
          taskId,
          status: existing?.status || SessionStatus.WORKING,
          messages: existing?.messages || [],
          pendingApproval: null  // Always reset on init
        })
      }))
    },

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
      seenIds.delete(taskId)
      stepStartTimes.delete(taskId)
      set((state) => {
        const next = new Map(state.sessions)
        next.delete(taskId)
        return { sessions: next }
      })
    },

    clearMessageDedup: (taskId) => {
      seenIds.delete(taskId)
      stepStartTimes.delete(taskId)
      // Clear messages array so replayed messages will be added fresh
      set((state) => {
        const session = state.sessions.get(taskId)
        if (!session) return state
        return {
          sessions: new Map(state.sessions).set(taskId, {
            ...session,
            messages: []
          })
        }
      })
    },

    stopAndRemoveSessionForTask: async (taskId) => {
      const session = get().sessions.get(taskId)
      if (session?.sessionId) {
        try {
          await agentSessionApi.stop(session.sessionId)
        } catch (err) {
          console.error('Failed to stop session:', err)
        }
      }
      get().removeSession(taskId)
    },

    getSession: (taskId) => get().sessions.get(taskId)
  }
})
