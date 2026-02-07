import { create } from 'zustand'
import type { Agent, CreateAgentDTO, UpdateAgentDTO } from '@/types'
import { agentApi } from '@/lib/ipc-client'

interface AgentState {
  agents: Agent[]
  isLoading: boolean
  error: string | null

  fetchAgents: () => Promise<void>
  createAgent: (data: CreateAgentDTO) => Promise<Agent | null>
  updateAgent: (id: string, data: UpdateAgentDTO) => Promise<Agent | null>
  deleteAgent: (id: string) => Promise<boolean>
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  isLoading: false,
  error: null,

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
  }
}))
