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

// Module-level dedup tracking (capped to prevent unbounded growth)
const MAX_TRACKED_TASKS = 50
const seenIds = new Map<string, Set<string>>()
const stepStartTimes = new Map<string, number>()

function getSeen(taskId: string): Set<string> {
  if (!seenIds.has(taskId)) {
    // Evict oldest entries when limit is reached (Maps preserve insertion order)
    while (seenIds.size >= MAX_TRACKED_TASKS) {
      const oldest = seenIds.keys().next().value
      if (oldest === undefined) break
      seenIds.delete(oldest)
      stepStartTimes.delete(oldest)
    }
    seenIds.set(taskId, new Set())
  }
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
    set((state) => {
      const session = findBySessionId(state.sessions, event.sessionId)
        || state.sessions.get(event.taskId)
      if (!session) return state

      const updated = { ...session, status: event.status }
      if (!session.sessionId && event.sessionId) updated.sessionId = event.sessionId
      return { sessions: new Map(state.sessions).set(session.taskId, updated) }
    })
  })

  onEvent('agent:output', (payload) => {
    const event = payload as { sessionId: string; taskId?: string; type: string; data: Record<string, unknown> }
    const data = event.data

    // Parse content from event payload (no store state needed)
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

    set((state) => {
      const session = findBySessionId(state.sessions, event.sessionId)
        || (event.taskId ? state.sessions.get(event.taskId) : undefined)
      if (!session) return state

      const resolvedSession = (!session.sessionId && event.sessionId)
        ? { ...session, sessionId: event.sessionId }
        : session

      const taskId = resolvedSession.taskId
      const seen = getSeen(taskId)

      // Absorb step-start
      if (data.partType === 'step-start') {
        seen.add(msgId)
        stepStartTimes.set(taskId, Date.now())
        return state
      }

      // Absorb step-finish — annotate last assistant message
      if (data.partType === 'step-finish') {
        seen.add(msgId)
        const msgs = resolvedSession.messages
        if (msgs.length === 0) return state

        const now = Date.now()
        const startTime = stepStartTimes.get(taskId)
        const durationMs = startTime ? now - startTime : undefined
        const tokens = data.stepTokens as StepMeta['tokens'] | undefined
        stepStartTimes.delete(taskId)

        let targetIdx = -1
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') { targetIdx = i; break }
        }
        if (targetIdx === -1) return state

        const updated = [...msgs]
        updated[targetIdx] = { ...updated[targetIdx], stepMeta: { durationMs, tokens } }
        return {
          sessions: new Map(state.sessions).set(taskId, { ...resolvedSession, messages: updated })
        }
      }

      // Streaming update — replace existing message content
      if (data.update && seen.has(msgId)) {
        return {
          sessions: new Map(state.sessions).set(taskId, {
            ...resolvedSession,
            messages: resolvedSession.messages.map((m): AgentMessage => {
              if (m.id !== msgId) return m
              const keepPartType = m.partType === 'todowrite' || m.partType === 'question' || m.partType === 'planreview'
              const newPartType = keepPartType ? m.partType : ((data.partType as string) || m.partType)
              const newTool = data.tool ? { ...m.tool, ...(data.tool as AgentMessage['tool']) } as AgentMessage['tool'] : m.tool
              return { ...m, content, partType: newPartType, tool: newTool }
            })
          })
        }
      }

      if (seen.has(msgId)) return state
      seen.add(msgId)

      return {
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
      }
    })
  })

  // Handle batch message events (sent during session resume and live polling)
  onEvent('agent:output-batch', (payload) => {
    const event = payload as { sessionId: string; taskId: string; messages: Array<{ id: string; role: string; content: string; partType?: string; tool?: unknown; update?: boolean }> }

    set((state) => {
      const session = findBySessionId(state.sessions, event.sessionId)
        || state.sessions.get(event.taskId)
      if (!session) return state

      const taskId = session.taskId
      const seen = getSeen(taskId)

      const resolvedSession = (!session.sessionId && event.sessionId)
        ? { ...session, sessionId: event.sessionId }
        : session

      let messages = [...resolvedSession.messages]
      let changed = false

      for (const msg of event.messages) {
        const role: AgentMessage['role'] = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system'
        const msgId = msg.id || `${role}-${(msg.content || '').slice(0, 50)}-${Date.now()}`
        const content = msg.content || ''

        // Absorb step-start: record timestamp
        if (msg.partType === 'step-start') {
          seen.add(msgId)
          stepStartTimes.set(taskId, Date.now())
          continue
        }

        // Absorb step-finish: annotate last assistant message
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
            changed = true
          }
          continue
        }

        // Streaming update — replace content of existing message
        if (msg.update && seen.has(msgId)) {
          messages = messages.map((m): AgentMessage => {
            if (m.id !== msgId) return m
            const keepPartType = m.partType === 'todowrite' || m.partType === 'question' || m.partType === 'planreview'
            const newPartType = keepPartType ? m.partType : (msg.partType || m.partType)
            const newTool = msg.tool ? { ...m.tool, ...(msg.tool as AgentMessage['tool']) } as AgentMessage['tool'] : m.tool
            return { ...m, content, partType: newPartType, tool: newTool }
          })
          changed = true
          continue
        }

        if (seen.has(msgId)) continue
        seen.add(msgId)
        if (!content && !msg.tool) continue

        messages.push({
          id: msgId,
          role,
          content,
          timestamp: new Date(),
          partType: msg.partType,
          tool: msg.tool as AgentMessage['tool']
        })
        changed = true
      }

      if (!changed) return state

      return {
        sessions: new Map(state.sessions).set(taskId, {
          ...resolvedSession,
          messages
        })
      }
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
     *
     * On reconnect (same session still active), we preserve existing messages
     * and only add new ones missed during disconnect. This prevents the flash
     * of empty state and avoids losing messages if the sync request fails.
     *
     * On first connect or session change, we do a full reset + replay.
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
            const isSameSession = existing && existing.sessionId === active.sessionId

            if (isSameSession) {
              // Same session — preserve messages so missed ones are appended
              // by the replay batch (dedup via seenIds filters out duplicates)
              nextSessions.set(active.taskId, {
                sessionId: active.sessionId,
                agentId: active.agentId,
                taskId: active.taskId,
                status: active.status as SessionStatus,
                messages: existing.messages
              })
            } else {
              // New or different session — full reset so replay populates fresh
              seenIds.delete(active.taskId)
              stepStartTimes.delete(active.taskId)
              nextSessions.set(active.taskId, {
                sessionId: active.sessionId,
                agentId: active.agentId,
                taskId: active.taskId,
                status: active.status as SessionStatus,
                messages: []
              })
            }
          }

          return { sessions: nextSessions }
        })

        // Replay messages from each active session (will arrive via WebSocket).
        // For same-session reconnects: only messages not in seenIds are added.
        // For new sessions: all messages are added (seenIds was cleared above).
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
