import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SyncManager } from './sync-manager'
import { TaskStatus } from '../shared/constants'
import type { DatabaseManager, TaskRecord } from './database'
import type { McpToolCaller } from './mcp-tool-caller'
import type { PluginRegistry } from './plugins/registry'
import type { TaskSourcePlugin } from './plugins/types'

function makeMockDb(): DatabaseManager {
  return {
    getTaskSource: vi.fn(),
    getMcpServer: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn()
  } as unknown as DatabaseManager
}

function makeMockToolCaller(): McpToolCaller {
  return { callTool: vi.fn() } as unknown as McpToolCaller
}

function makeMockPlugin(overrides: Partial<TaskSourcePlugin> = {}): TaskSourcePlugin {
  return {
    id: 'test',
    displayName: 'Test',
    description: 'Test plugin',
    icon: 'Zap',
    requiresMcpServer: true,
    getConfigSchema: () => [],
    resolveOptions: async () => [],
    validateConfig: () => null,
    getFieldMapping: () => ({ external_id: 'id', title: 'name' }),
    getActions: () => [],
    importTasks: vi.fn().mockResolvedValue({ imported: 5, updated: 2, errors: [] }),
    exportUpdate: vi.fn().mockResolvedValue(undefined),
    executeAction: vi.fn().mockResolvedValue({ success: true, taskUpdate: { status: TaskStatus.Completed } }),
    ...overrides
  }
}

describe('SyncManager', () => {
  let db: ReturnType<typeof makeMockDb>
  let toolCaller: ReturnType<typeof makeMockToolCaller>
  let registry: PluginRegistry
  let syncManager: SyncManager

  beforeEach(() => {
    db = makeMockDb()
    toolCaller = makeMockToolCaller()
    registry = { get: vi.fn() } as unknown as PluginRegistry
    syncManager = new SyncManager(db, toolCaller, registry)
  })

  describe('importTasks', () => {
    it('returns error when source not found', async () => {
      ;(db.getTaskSource as any).mockReturnValue(undefined)
      const result = await syncManager.importTasks('src-1')
      expect(result.errors).toContain('Task source not found')
    })

    it('returns error when plugin not found', async () => {
      ;(db.getTaskSource as any).mockReturnValue({
        id: 'src-1',
        plugin_id: 'missing',
        mcp_server_id: 'srv-1',
        config: {}
      })
      ;(registry.get as any).mockReturnValue(undefined)

      const result = await syncManager.importTasks('src-1')
      expect(result.errors).toContain('Plugin "missing" not found')
    })

    it('delegates to plugin.importTasks', async () => {
      const plugin = makeMockPlugin()
      ;(db.getTaskSource as any).mockReturnValue({
        id: 'src-1',
        plugin_id: 'test',
        mcp_server_id: 'srv-1',
        config: { status_filter: 'pending' }
      })
      ;(registry.get as any).mockReturnValue(plugin)
      ;(db.getMcpServer as any).mockReturnValue({ id: 'srv-1' })

      const result = await syncManager.importTasks('src-1')
      expect(result.imported).toBe(5)
      expect(result.updated).toBe(2)
      expect(plugin.importTasks).toHaveBeenCalledWith(
        'src-1',
        { status_filter: 'pending' },
        expect.objectContaining({ db, toolCaller })
      )
    })

    it('catches plugin errors', async () => {
      const plugin = makeMockPlugin({
        importTasks: vi.fn().mockRejectedValue(new Error('Network error'))
      })
      ;(db.getTaskSource as any).mockReturnValue({
        id: 'src-1', plugin_id: 'test', mcp_server_id: 'srv-1', config: {}
      })
      ;(registry.get as any).mockReturnValue(plugin)

      const result = await syncManager.importTasks('src-1')
      expect(result.errors).toContain('Network error')
    })
  })

  describe('exportTaskUpdate', () => {
    it('does nothing when task has no source_id', async () => {
      ;(db.getTask as any).mockReturnValue({ id: 't1', source_id: null })
      await syncManager.exportTaskUpdate('t1', { title: 'New' })
      expect(registry.get).not.toHaveBeenCalled()
    })

    it('does nothing when task has no external_id', async () => {
      ;(db.getTask as any).mockReturnValue({ id: 't1', source_id: 'src-1', external_id: null })
      await syncManager.exportTaskUpdate('t1', { title: 'New' })
      expect(registry.get).not.toHaveBeenCalled()
    })

    it('calls plugin.exportUpdate when task has source', async () => {
      const plugin = makeMockPlugin()
      ;(db.getTask as any).mockReturnValue({ id: 't1', source_id: 'src-1', external_id: 'ext-1' })
      ;(db.getTaskSource as any).mockReturnValue({
        id: 'src-1', plugin_id: 'test', mcp_server_id: 'srv-1', config: {}
      })
      ;(registry.get as any).mockReturnValue(plugin)
      ;(db.getMcpServer as any).mockReturnValue({ id: 'srv-1' })

      await syncManager.exportTaskUpdate('t1', { title: 'New' })
      expect(plugin.exportUpdate).toHaveBeenCalled()
    })
  })

  describe('executeAction', () => {
    it('returns error when source not found', async () => {
      ;(db.getTaskSource as any).mockReturnValue(undefined)
      const task = { id: 't1' } as TaskRecord
      const result = await syncManager.executeAction('approve', task, undefined, 'src-1')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Task source not found')
    })

    it('applies taskUpdate to local task on success', async () => {
      const plugin = makeMockPlugin()
      ;(db.getTaskSource as any).mockReturnValue({
        id: 'src-1', plugin_id: 'test', mcp_server_id: 'srv-1', config: {}
      })
      ;(registry.get as any).mockReturnValue(plugin)
      ;(db.getMcpServer as any).mockReturnValue({ id: 'srv-1' })

      const task = { id: 't1' } as TaskRecord
      const result = await syncManager.executeAction('approve', task, undefined, 'src-1')

      expect(result.success).toBe(true)
      expect(db.updateTask).toHaveBeenCalledWith('t1', { status: TaskStatus.Completed })
    })
  })
})
