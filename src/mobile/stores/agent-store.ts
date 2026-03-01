import { create } from 'zustand'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'

// ── Message types (mirrors desktop agent-store) ──────────────

export interface StepMeta {
  durationMs?: number
  tokens?: { input: number; output: number; cache: number }
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
}

export type SessionStatus = 'idle' | 'working' | 'error' | 'waiting_approval'

export interface TaskSession {
  sessionId: string | null
  agentId: string
  taskId: string
  status: SessionStatus
  messages: AgentMessage[]
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

// Module-level dedup tracking
const seenIds = new Map<string, Set<string>>()
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

export interface Skill {
  id: string
  name: string
  description: string
  agent_id: string | null
}

interface AgentState {
  agents: Agent[]
  skills: Skill[]
  sessions: Map<string, TaskSession>
  fetchAgents: () => Promise<void>
  fetchSkills: () => Promise<void>
  syncActiveSessions: () => Promise<void>
  initSession: (taskId: string, sessionId: string, agentId: string) => void
  endSession: (taskId: string) => void
  removeSession: (taskId: string) => void
  clearMessageDedup: (taskId: string) => void
  getSession: (taskId: string) => TaskSession | undefined
}

export const useAgentStore = create<AgentState>((set, get) => {
  // ── WebSocket event subscriptions ──

  onEvent('agent:status', (payload) => {
    const event = payload as { sessionId: string; agentId: string; taskId: string; status: SessionStatus }
    const state = get()
    const session = findBySessionId(state.sessions, event.sessionId)
      || state.sessions.get(event.taskId)
    if (!session) return

    const updated = { ...session, status: event.status }
    if (!session.sessionId && event.sessionId) updated.sessionId = event.sessionId
    set({ sessions: new Map(state.sessions).set(session.taskId, updated) })
  })

  onEvent('agent:output', (payload) => {
    const event = payload as { sessionId: string; taskId?: string; type: string; data: Record<string, unknown> }
    const state = get()
    const session = findBySessionId(state.sessions, event.sessionId)
      || (event.taskId ? state.sessions.get(event.taskId) : undefined)
    if (!session) return

    const resolvedSession = (!session.sessionId && event.sessionId)
      ? { ...session, sessionId: event.sessionId }
      : session

    const data = event.data
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

    if (!content && !data.tool && !data.questions && !data.todos) return
    if (!msgId) msgId = `${role}-${content.slice(0, 50)}-${Date.now()}`

    const taskId = resolvedSession.taskId
    const seen = getSeen(taskId)

    // Absorb step-start
    if (data.partType === 'step-start') {
      seen.add(msgId)
      stepStartTimes.set(taskId, Date.now())
      return
    }

    // Absorb step-finish — annotate last assistant message
    if (data.partType === 'step-finish') {
      seen.add(msgId)
      const msgs = resolvedSession.messages
      if (msgs.length === 0) return

      const now = Date.now()
      const startTime = stepStartTimes.get(taskId)
      const durationMs = startTime ? now - startTime : undefined
      const tokens = data.stepTokens as StepMeta['tokens'] | undefined
      stepStartTimes.delete(taskId)

      let targetIdx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') { targetIdx = i; break }
      }
      if (targetIdx === -1) return

      const updated = [...msgs]
      updated[targetIdx] = { ...updated[targetIdx], stepMeta: { durationMs, tokens } }
      set({
        sessions: new Map(state.sessions).set(taskId, { ...resolvedSession, messages: updated })
      })
      return
    }

    // Streaming update — replace existing message content
    if (data.update && seen.has(msgId)) {
      set({
        sessions: new Map(state.sessions).set(taskId, {
          ...resolvedSession,
          messages: resolvedSession.messages.map((m): AgentMessage => {
            if (m.id !== msgId) return m
            const keepPartType = m.partType === 'todowrite' || m.partType === 'question'
            const newPartType = keepPartType ? m.partType : ((data.partType as string) || m.partType)
            const newTool = data.tool ? { ...m.tool, ...(data.tool as AgentMessage['tool']) } as AgentMessage['tool'] : m.tool
            return { ...m, content, partType: newPartType, tool: newTool }
          })
        })
      })
      return
    }

    if (seen.has(msgId)) return
    seen.add(msgId)

    set({
      sessions: new Map(state.sessions).set(taskId, {
        ...resolvedSession,
        messages: [
          ...resolvedSession.messages,
          {
            id: msgId,
            role,
            content,
            timestamp: new Date(),
            partType: data.partType as string,
            tool: data.tool as AgentMessage['tool']
          }
        ]
      })
    })
  })

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

    /**
     * Fetch active sessions from the server and sync with any running ones.
     * This allows the mobile UI to connect to sessions already running in Electron.
     */
    syncActiveSessions: async () => {
      try {
        const activeSessions = (await api.sessions.list()) as Array<{
          sessionId: string; agentId: string; taskId: string; status: string
        }>

        if (activeSessions.length === 0) return

        const state = get()
        const nextSessions = new Map(state.sessions)

        for (const active of activeSessions) {
          const existing = state.sessions.get(active.taskId)
          // Skip if we already have this session connected with messages
          if (existing?.sessionId === active.sessionId && existing.messages.length > 0) continue

          // Initialize session in the store so WebSocket events are captured
          seenIds.delete(active.taskId)
          nextSessions.set(active.taskId, {
            sessionId: active.sessionId,
            agentId: active.agentId,
            taskId: active.taskId,
            status: active.status as SessionStatus,
            messages: []
          })
        }

        set({ sessions: nextSessions })

        // Replay messages from each active session (will arrive via WebSocket)
        for (const active of activeSessions) {
          try {
            await api.sessions.sync(active.sessionId)
          } catch (e) {
            console.error(`Failed to sync session ${active.sessionId}:`, e)
          }
        }
      } catch (e) {
        console.error('Failed to sync active sessions:', e)
      }
    },

    initSession: (taskId, sessionId, agentId) => {
      const existing = get().sessions.get(taskId)
      if (!existing) seenIds.delete(taskId)
      set((state) => ({
        sessions: new Map(state.sessions).set(taskId, {
          sessionId,
          agentId,
          taskId,
          status: existing?.status || 'working',
          messages: existing?.messages || []
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
            status: 'idle'
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
      set((state) => {
        const session = state.sessions.get(taskId)
        if (!session) return state
        return {
          sessions: new Map(state.sessions).set(taskId, { ...session, messages: [] })
        }
      })
    },

    getSession: (taskId) => get().sessions.get(taskId)
  }
})
