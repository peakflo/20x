import { create } from 'zustand'
import type { Agent, CreateAgentDTO, UpdateAgentDTO } from '@/types'
import { agentApi, agentSessionApi, onAgentOutput, onAgentStatus, onAgentApproval } from '@/lib/ipc-client'
import type { AgentOutputEvent, AgentStatusEvent, AgentApprovalRequest } from '@/types/electron'

// ── Message type ──────────────────────────────────────────────

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  partType?: string
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
}

// ── Per-task session ──────────────────────────────────────────

export type SessionStatus = 'idle' | 'working' | 'error' | 'waiting_approval'

export interface TaskSession {
  sessionId: string | null
  agentId: string
  taskId: string
  status: SessionStatus
  messages: AgentMessage[]
  pendingApproval: AgentApprovalRequest | null
}

// Module-level dedup tracking (avoids unnecessary Zustand re-renders)
const seenIds = new Map<string, Set<string>>()

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
  getSession: (taskId: string) => TaskSession | undefined
  stopAndRemoveSessionForTask: (taskId: string) => Promise<void>
}

export const useAgentStore = create<AgentState>((set, get) => {
  // ── IPC event subscriptions ──

  onAgentStatus((event: AgentStatusEvent) => {
    const state = get()
    const session = findBySessionId(state.sessions, event.sessionId)
      || state.sessions.get(event.taskId)
    if (!session) return

    const updated = { ...session, status: event.status }
    // Patch in real sessionId if session was pre-registered with empty string
    if (!session.sessionId && event.sessionId) updated.sessionId = event.sessionId
    set({ sessions: new Map(state.sessions).set(session.taskId, updated) })
  })

  onAgentOutput((event: AgentOutputEvent) => {
    const state = get()
    const session = findBySessionId(state.sessions, event.sessionId)
      || (event.taskId ? state.sessions.get(event.taskId) : undefined)
    if (!session) return

    // Patch in real sessionId if needed
    const resolvedSession = (!session.sessionId && event.sessionId)
      ? { ...session, sessionId: event.sessionId }
      : session

    const data = event.data as any
    let role: 'user' | 'assistant' | 'system' = 'system'
    let content = ''
    let msgId = ''

    if (typeof data === 'object' && data !== null) {
      role = data.role === 'user' ? 'user' : data.role === 'assistant' ? 'assistant' : 'system'
      content = data.content ?? data.text ?? data.message ?? JSON.stringify(data)
      msgId = data.id || ''
    } else {
      content = String(data)
    }

    if (!content) return
    if (!msgId) msgId = `${role}-${content.slice(0, 50)}-${content.length}`

    const seen = getSeen(resolvedSession.taskId)

    // Streaming update — replace content of existing message
    if (data.update && seen.has(msgId)) {
      set({
        sessions: new Map(state.sessions).set(resolvedSession.taskId, {
          ...resolvedSession,
          messages: resolvedSession.messages.map((m) =>
            m.id === msgId
              ? { ...m, content, ...(data.partType && { partType: data.partType }), ...(data.tool && { tool: data.tool }) }
              : m
          )
        })
      })
      return
    }

    if (seen.has(msgId)) return
    seen.add(msgId)

    set({
      sessions: new Map(state.sessions).set(resolvedSession.taskId, {
        ...resolvedSession,
        messages: [
          ...resolvedSession.messages,
          { id: msgId, role, content, timestamp: new Date(), partType: data.partType, tool: data.tool }
        ]
      })
    })
  })

  onAgentApproval((event: AgentApprovalRequest) => {
    const state = get()
    const session = findBySessionId(state.sessions, event.sessionId)
    if (!session) return

    set({
      sessions: new Map(state.sessions).set(session.taskId, {
        ...session,
        pendingApproval: event,
        status: 'waiting_approval'
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
          status: existing?.status || 'working',
          messages: existing?.messages || [],
          pendingApproval: existing?.pendingApproval || null
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
            status: 'idle',
            pendingApproval: null
          })
        }
      })
    },

    removeSession: (taskId) => {
      seenIds.delete(taskId)
      set((state) => {
        const next = new Map(state.sessions)
        next.delete(taskId)
        return { sessions: next }
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
