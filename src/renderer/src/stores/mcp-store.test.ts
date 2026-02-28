import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { useMcpStore } from './mcp-store'
import type { McpServer, CreateMcpServerDTO, UpdateMcpServerDTO } from '@/types'

const mockElectronAPI = window.electronAPI

beforeEach(() => {
  useMcpStore.setState({
    servers: [],
    isLoading: false,
    error: null
  })
  vi.clearAllMocks()
})

describe('useMcpStore', () => {
  describe('fetchServers', () => {
    it('fetches and sets servers', async () => {
      const servers = [{ id: 'm1', name: 'Server 1' }]
      ;(mockElectronAPI.mcpServers.getAll as unknown as Mock).mockResolvedValue(servers)

      await useMcpStore.getState().fetchServers()

      expect(useMcpStore.getState().servers).toEqual(servers)
      expect(useMcpStore.getState().isLoading).toBe(false)
    })

    it('sets error on failure', async () => {
      ;(mockElectronAPI.mcpServers.getAll as unknown as Mock).mockRejectedValue(new Error('fail'))

      await useMcpStore.getState().fetchServers()

      expect(useMcpStore.getState().error).toBeTruthy()
    })
  })

  describe('createServer', () => {
    it('appends server to list', async () => {
      const newServer = { id: 'm1', name: 'New MCP' }
      ;(mockElectronAPI.mcpServers.create as unknown as Mock).mockResolvedValue(newServer)

      const result = await useMcpStore.getState().createServer({ name: 'New MCP' } as unknown as CreateMcpServerDTO)

      expect(result).toEqual(newServer)
      expect(useMcpStore.getState().servers).toHaveLength(1)
    })
  })

  describe('updateServer', () => {
    it('updates server in list', async () => {
      useMcpStore.setState({ servers: [{ id: 'm1', name: 'Old' }] as unknown as McpServer[] })
      const updated = { id: 'm1', name: 'Updated' }
      ;(mockElectronAPI.mcpServers.update as unknown as Mock).mockResolvedValue(updated)

      await useMcpStore.getState().updateServer('m1', { name: 'Updated' } as unknown as UpdateMcpServerDTO)

      expect(useMcpStore.getState().servers[0].name).toBe('Updated')
    })
  })

  describe('deleteServer', () => {
    it('removes server from list', async () => {
      useMcpStore.setState({ servers: [{ id: 'm1' }, { id: 'm2' }] as unknown as McpServer[] })
      ;(mockElectronAPI.mcpServers.delete as unknown as Mock).mockResolvedValue(true)

      const result = await useMcpStore.getState().deleteServer('m1')

      expect(result).toBe(true)
      expect(useMcpStore.getState().servers).toHaveLength(1)
    })
  })

  describe('testConnection', () => {
    it('returns test result', async () => {
      const testResult = { status: 'connected' as const, tools: [{ name: 'tool1', description: 'A tool' }] }
      ;(mockElectronAPI.mcpServers.testConnection as unknown as Mock).mockResolvedValue(testResult)

      const result = await useMcpStore.getState().testConnection({ name: 'Test' })

      expect(result.status).toBe('connected')
    })

    it('updates tools in store when server ID provided', async () => {
      useMcpStore.setState({
        servers: [{ id: 'm1', name: 'Server', tools: [] }] as unknown as McpServer[]
      })
      const tools = [{ name: 'tool1', description: 'A tool' }]
      ;(mockElectronAPI.mcpServers.testConnection as unknown as Mock).mockResolvedValue({
        status: 'connected',
        tools
      })

      await useMcpStore.getState().testConnection({ id: 'm1', name: 'Server' })

      expect(useMcpStore.getState().servers[0].tools).toEqual(tools)
    })
  })
})
