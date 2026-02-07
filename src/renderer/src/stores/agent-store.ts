import { create } from 'zustand'
import type { Agent, CreateAgentDTO, UpdateAgentDTO } from '@/types'
import { agentApi, onAgentStatus } from '@/lib/ipc-client'
import type { AgentStatusEvent } from '@/types/electron'

export interface ActiveSession {
  sessionId: string
  agentId: string
  taskId: string
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
}

interface AgentState {
  agents: Agent[]
  isLoading: boolean
  error: string | null
  activeSessions: Map<string, ActiveSession>

  fetchAgents: () => Promise<void>
  createAgent: (data: CreateAgentDTO) => Promise<Agent | null>
  updateAgent: (id: string, data: UpdateAgentDTO) => Promise<Agent | null>
  deleteAgent: (id: string) => Promise<boolean>
  addActiveSession: (session: ActiveSession) => void
  removeActiveSession: (sessionId: string) => void
  updateSessionStatus: (sessionId: string, status: ActiveSession['status']) => void
  getSessionForTask: (taskId: string) => ActiveSession | undefined
}

export const useAgentStore = create<AgentState>((set, get) => {
  // Subscribe to agent status updates from main process
  onAgentStatus((event: AgentStatusEvent) => {
    const state = get()
    if (state.activeSessions.has(event.sessionId)) {
      set((state) => ({
        activeSessions: new Map(state.activeSessions).set(event.sessionId, {
          sessionId: event.sessionId,
          agentId: event.agentId,
          taskId: event.taskId,
          status: event.status
        })
      }))
    }
  })

  return {
    agents: [],
    isLoading: false,
    error: null,
    activeSessions: new Map(),

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
          set((state) => ({
            agents: state.agents.map((a) => (a.id === id ? updated : a))
          }))
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
          set((state) => ({
            agents: state.agents.filter((a) => a.id !== id)
          }))
        }
        return success
      } catch (err) {
        set({ error: String(err) })
        return false
      }
    },

    addActiveSession: (session) => {
      set((state) => ({
        activeSessions: new Map(state.activeSessions).set(session.sessionId, session)
      }))
    },

    removeActiveSession: (sessionId) => {
      set((state) => {
        const newSessions = new Map(state.activeSessions)
        newSessions.delete(sessionId)
        return { activeSessions: newSessions }
      })
    },

    updateSessionStatus: (sessionId, status) => {
      set((state) => {
        const session = state.activeSessions.get(sessionId)
        if (!session) return state

        return {
          activeSessions: new Map(state.activeSessions).set(sessionId, {
            ...session,
            status
          })
        }
      })
    },

    getSessionForTask: (taskId) => {
      const state = get()
      for (const session of state.activeSessions.values()) {
        if (session.taskId === taskId) {
          return session
        }
      }
      return undefined
    }
  }
})
