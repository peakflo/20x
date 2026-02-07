import { create } from 'zustand'
import type { McpServer, CreateMcpServerDTO, UpdateMcpServerDTO } from '@/types'
import type { McpTestResult } from '@/types/electron'
import { mcpServerApi } from '@/lib/ipc-client'

interface McpState {
  servers: McpServer[]
  isLoading: boolean
  error: string | null

  fetchServers: () => Promise<void>
  createServer: (data: CreateMcpServerDTO) => Promise<McpServer | null>
  updateServer: (id: string, data: UpdateMcpServerDTO) => Promise<McpServer | null>
  deleteServer: (id: string) => Promise<boolean>
  testConnection: (data: { id?: string; name: string; type?: 'local' | 'remote'; command?: string; args?: string[]; url?: string; headers?: Record<string, string>; environment?: Record<string, string> }) => Promise<McpTestResult>
}

export const useMcpStore = create<McpState>((set) => ({
  servers: [],
  isLoading: false,
  error: null,

  fetchServers: async () => {
    set({ isLoading: true, error: null })
    try {
      const servers = await mcpServerApi.getAll()
      set({ servers, isLoading: false })
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  createServer: async (data) => {
    try {
      const server = await mcpServerApi.create(data)
      set((state) => ({ servers: [...state.servers, server] }))
      return server
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  updateServer: async (id, data) => {
    try {
      const updated = await mcpServerApi.update(id, data)
      if (updated) {
        set((state) => ({
          servers: state.servers.map((s) => (s.id === id ? updated : s))
        }))
      }
      return updated || null
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  deleteServer: async (id) => {
    try {
      const success = await mcpServerApi.delete(id)
      if (success) {
        set((state) => ({
          servers: state.servers.filter((s) => s.id !== id)
        }))
      }
      return success
    } catch (err) {
      set({ error: String(err) })
      return false
    }
  },

  testConnection: async (data) => {
    const result = await mcpServerApi.testConnection(data)
    // If test returned tools and we have a server ID, update tools in the store
    if (data.id && result.tools && result.status === 'connected') {
      set((state) => ({
        servers: state.servers.map((s) =>
          s.id === data.id ? { ...s, tools: result.tools! } : s
        )
      }))
    }
    return result
  }
}))
