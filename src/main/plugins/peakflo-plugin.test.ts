import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PeakfloPlugin } from './peakflo-plugin'
import { TaskStatus } from '../../shared/constants'
import type { PluginContext } from './types'
import type { DatabaseManager, McpServerRecord, TaskRecord } from '../database'

function makeContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    db: {
      getTaskSource: vi.fn().mockReturnValue({ name: 'Peakflo' }),
      getTaskByExternalId: vi.fn().mockReturnValue(undefined),
      createTask: vi.fn(),
      updateTask: vi.fn(),
      updateTaskSourceLastSynced: vi.fn()
    } as unknown as DatabaseManager,
    toolCaller: {
      callTool: vi.fn().mockResolvedValue({ success: true, result: { tasks: [] } })
    } as any,
    mcpServer: {
      id: 'srv-1',
      name: 'Test',
      type: 'remote',
      url: 'https://api.test.com',
      command: '',
      args: [],
      headers: {},
      environment: {},
      tools: [],
      created_at: '',
      updated_at: ''
    } as McpServerRecord,
    ...overrides
  }
}

describe('PeakfloPlugin', () => {
  let plugin: PeakfloPlugin

  beforeEach(() => {
    plugin = new PeakfloPlugin()
  })

  it('has correct metadata', () => {
    expect(plugin.id).toBe('peakflo')
    expect(plugin.displayName).toBe('Peakflo Workflo')
    expect(plugin.requiresMcpServer).toBe(true)
  })

  it('returns config schema with status_filter and auto_sync_interval', () => {
    const schema = plugin.getConfigSchema()
    expect(schema).toHaveLength(2)
    expect(schema[0].key).toBe('status_filter')
    expect(schema[1].key).toBe('auto_sync_interval')
  })

  it('returns field mapping', () => {
    const mapping = plugin.getFieldMapping()
    expect(mapping.external_id).toBe('taskId|id')
    expect(mapping.title).toBe('title|name')
  })

  it('returns approve and reject actions', () => {
    const actions = plugin.getActions()
    expect(actions).toHaveLength(2)
    expect(actions[0].id).toBe('approve')
    expect(actions[1].id).toBe('reject')
    expect(actions[1].requiresInput).toBe(true)
  })

  describe('importTasks', () => {
    it('returns error when no MCP server', async () => {
      const ctx = makeContext({ mcpServer: undefined })
      const result = await plugin.importTasks('src-1', {}, ctx)
      expect(result.errors).toContain('MCP server not found')
    })

    it('imports new tasks', async () => {
      const ctx = makeContext()
      ;(ctx.toolCaller.callTool as any).mockResolvedValue({
        success: true,
        result: {
          tasks: [
            { taskId: 'ext-1', title: 'Task 1', priority: 'high', status: 'pending' },
            { taskId: 'ext-2', title: 'Task 2', priority: 'low', status: 'completed' }
          ]
        }
      })

      const result = await plugin.importTasks('src-1', {}, ctx)
      expect(result.imported).toBe(2)
      expect(result.updated).toBe(0)
      expect(ctx.db.createTask).toHaveBeenCalledTimes(2)
    })

    it('updates existing tasks', async () => {
      const ctx = makeContext()
      ;(ctx.db.getTaskByExternalId as any).mockReturnValue({ id: 'local-1' })
      ;(ctx.toolCaller.callTool as any).mockResolvedValue({
        success: true,
        result: { tasks: [{ taskId: 'ext-1', title: 'Updated' }] }
      })

      const result = await plugin.importTasks('src-1', {}, ctx)
      expect(result.imported).toBe(0)
      expect(result.updated).toBe(1)
      expect(ctx.db.updateTask).toHaveBeenCalledWith('local-1', expect.objectContaining({ title: 'Updated' }))
    })

    it('maps priority correctly', async () => {
      const ctx = makeContext()
      ;(ctx.toolCaller.callTool as any).mockResolvedValue({
        success: true,
        result: { tasks: [{ taskId: 'ext-1', title: 'T', priority: 'urgent' }] }
      })

      await plugin.importTasks('src-1', {}, ctx)
      expect(ctx.db.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'critical' })
      )
    })

    it('maps status correctly', async () => {
      const ctx = makeContext()
      ;(ctx.toolCaller.callTool as any).mockResolvedValue({
        success: true,
        result: { tasks: [{ taskId: 'ext-1', title: 'T', status: 'in_progress' }] }
      })

      await plugin.importTasks('src-1', {}, ctx)
      expect(ctx.db.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ status: TaskStatus.NotStarted })
      )
    })

    it('handles tool call failure', async () => {
      const ctx = makeContext()
      ;(ctx.toolCaller.callTool as any).mockResolvedValue({
        success: false,
        error: 'Connection timeout'
      })

      const result = await plugin.importTasks('src-1', {}, ctx)
      expect(result.errors).toContain('Connection timeout')
    })
  })

  describe('executeAction', () => {
    it('calls task_complete for approve', async () => {
      const ctx = makeContext()
      ;(ctx.toolCaller.callTool as any).mockResolvedValue({ success: true })

      const task = { id: 'local-1', external_id: 'ext-1' } as TaskRecord
      const result = await plugin.executeAction('approve', task, undefined, {}, ctx)

      expect(result.success).toBe(true)
      expect(result.taskUpdate).toEqual({ status: TaskStatus.Completed })
      expect(ctx.toolCaller.callTool).toHaveBeenCalledWith(
        ctx.mcpServer,
        'task_complete',
        expect.objectContaining({
          taskId: 'ext-1',
          outputs: expect.stringContaining('approved')
        })
      )
    })

    it('calls task_complete for reject with reason', async () => {
      const ctx = makeContext()
      ;(ctx.toolCaller.callTool as any).mockResolvedValue({ success: true })

      const task = { id: 'local-1', external_id: 'ext-1' } as TaskRecord
      const result = await plugin.executeAction('reject', task, 'Bad quality', {}, ctx)

      expect(result.success).toBe(true)
      expect(result.taskUpdate).toEqual({ status: TaskStatus.NotStarted })
    })

    it('returns error when no external_id', async () => {
      const ctx = makeContext()
      const task = { id: 'local-1', external_id: null } as TaskRecord
      const result = await plugin.executeAction('approve', task, undefined, {}, ctx)
      expect(result.success).toBe(false)
    })
  })
})
