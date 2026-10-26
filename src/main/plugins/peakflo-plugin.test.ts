import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PeakfloPlugin } from './peakflo-plugin'
import { TaskStatus } from '../../shared/constants'
import type { PluginContext } from './types'
import type { DatabaseManager, McpServerRecord, TaskRecord } from '../database'
import { createTestDb } from '../../../test/helpers/db-test-helper'

function makeContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    db: {
      setSetting: vi.fn(),
      getSetting: vi.fn(),
      getTaskSource: vi.fn().mockReturnValue({ name: 'Peakflo' }),
      getTaskByExternalId: vi.fn().mockReturnValue(undefined),
      createTask: vi.fn(),
      updateTask: vi.fn(),
      updateTaskSourceLastSynced: vi.fn()
    } as unknown as DatabaseManager,
    toolCaller: {
      callTool: vi.fn().mockResolvedValue({ success: true, result: { tasks: [] } })
    } as unknown as PluginContext['toolCaller'],
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
      oauth_metadata: {},
      source: 'user',
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
    expect(plugin.requiresMcpServer).toBe(false)
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
      expect(result.errors).toContain('MCP server not found and enterprise not connected')
    })

    it('imports new tasks', async () => {
      const ctx = makeContext()
      ;(ctx.toolCaller.callTool as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
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
      ;(ctx.db.getTaskByExternalId as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'local-1' })
      ;(ctx.toolCaller.callTool as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
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
      ;(ctx.toolCaller.callTool as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
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
      ;(ctx.toolCaller.callTool as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
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
      ;(ctx.toolCaller.callTool as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Connection timeout'
      })

      const result = await plugin.importTasks('src-1', {}, ctx)
      expect(result.errors).toContain('Connection timeout')
    })
  })

  describe('executeAction', () => {
    it.each(['approve', 'reject'])('refuses legacy MCP %s writes', async (action) => {
      const ctx = makeContext()
      const task = { id: 'local-1', external_id: 'ext-1', output_fields: [] } as unknown as TaskRecord
      const result = await plugin.executeAction(action, task, undefined, {}, ctx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('0.0.146')
      expect(ctx.toolCaller.callTool).not.toHaveBeenCalled()
      expect(ctx.db.updateTask).not.toHaveBeenCalled()
    })

    it('returns error when no external_id', async () => {
      const ctx = makeContext()
      const task = { id: 'local-1', external_id: null } as TaskRecord
      const result = await plugin.executeAction('approve', task, undefined, {}, ctx)
      expect(result.success).toBe(false)
    })

    it('enterprise mode: calls workfloApiClient.executeAction with action and output field values', async () => {
      const mockExecuteAction = vi.fn().mockResolvedValue(undefined)
      const ctx = makeContext({
        workfloApiClient: {
          getTask: vi.fn().mockResolvedValue({ status: 'completed' }),
          executeAction: mockExecuteAction
        } as unknown as PluginContext['workfloApiClient']
      })

      const task = {
        id: 'local-1',
        external_id: 'wf-task-123',
        output_fields: [
          { id: 'action', name: 'Action', type: 'list', value: 'approve' },
          { id: 'reason', name: 'Reason', type: 'text', value: 'Looks good' }
        ]
      } as unknown as TaskRecord

      const result = await plugin.executeAction('approve', task, undefined, { enterprise_mode: true }, ctx)

      expect(result.success).toBe(true)
      expect(result.taskUpdate).toEqual({ status: TaskStatus.Completed })
      expect(mockExecuteAction).toHaveBeenCalledWith('wf-task-123', {
        action: 'approve',
        reason: 'Looks good'
      }, undefined)
    })

    it('enterprise mode: sends default "complete" action for tasks without action field', async () => {
      const mockExecuteAction = vi.fn().mockResolvedValue(undefined)
      const ctx = makeContext({
        workfloApiClient: {
          getTask: vi.fn().mockResolvedValue({ status: 'completed' }),
          executeAction: mockExecuteAction
        } as unknown as PluginContext['workfloApiClient']
      })

      const task = {
        id: 'local-1',
        external_id: 'wf-task-456',
        output_fields: []
      } as unknown as TaskRecord

      const result = await plugin.executeAction('complete', task, undefined, { enterprise_mode: true }, ctx)

      expect(result.success).toBe(true)
      expect(result.taskUpdate).toEqual({ status: TaskStatus.Completed })
      expect(mockExecuteAction).toHaveBeenCalledWith('wf-task-456', {
        action: 'complete'
      }, undefined)
    })

    it('enterprise mode: returns error when workfloApiClient is missing', async () => {
      // enterprise_mode in config but no workfloApiClient → should fail, not silently succeed
      const ctx = makeContext({ workfloApiClient: undefined })

      const task = {
        id: 'local-1',
        external_id: 'wf-task-789',
        output_fields: []
      } as unknown as TaskRecord

      const result = await plugin.executeAction('complete', task, undefined, { enterprise_mode: true }, ctx)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Enterprise API client not available')
    })
  })

  describe('importTasksEnterprise - race condition guard', () => {
    function makeEnterpriseCtx(existingTask?: Partial<TaskRecord>) {
      const mockListTasks = vi.fn().mockResolvedValue({
        tasks: [{
          id: 'wf-1',
          title: 'Server Task',
          status: 'pending',
          priority: 'medium',
          description: '',
          taskData: { fields: [], outputs: [] },
          assignees: []
        }],
        pagination: { total: 1, page: 1, pageSize: 100, totalPages: 1 }
      })

      const db = {
        setSetting: vi.fn(),
      getSetting: vi.fn(),
      getTaskSource: vi.fn().mockReturnValue({ name: 'Workflo Test' }),
        getTaskByExternalId: vi.fn().mockReturnValue(existingTask || undefined),
        createTask: vi.fn(),
        updateTask: vi.fn(),
        updateTaskSourceLastSynced: vi.fn()
      } as unknown as DatabaseManager

      const ctx = makeContext({
        db,
        workfloApiClient: {
          listTaskCache: mockListTasks,
          downloadFile: vi.fn()
        } as unknown as PluginContext['workfloApiClient']
      })

      return { ctx, db }
    }

    it('uses server status even when local completion is recent', async () => {
      // Task was completed very recently (30 seconds ago)
      const recentUpdate = new Date(Date.now() - 30_000).toISOString()
      const { ctx, db } = makeEnterpriseCtx({
        id: 'local-1',
        status: TaskStatus.Completed,
        updated_at: recentUpdate
      })

      await plugin.importTasks('src-1', { enterprise_mode: true }, ctx)

      // Should keep Completed (within race window)
      expect(db.updateTask).toHaveBeenCalledWith(
        'local-1',
        expect.objectContaining({ status: TaskStatus.NotStarted }),
        'workflo-server'
      )
    })

    it('trusts server status after the 2-minute race window expires', async () => {
      // Task was completed 5 minutes ago — well past the race window
      const oldUpdate = new Date(Date.now() - 5 * 60_000).toISOString()
      const { ctx, db } = makeEnterpriseCtx({
        id: 'local-1',
        status: TaskStatus.Completed,
        updated_at: oldUpdate
      })

      await plugin.importTasks('src-1', { enterprise_mode: true }, ctx)

      // Should update to server status (NotStarted, mapped from "pending")
      expect(db.updateTask).toHaveBeenCalledWith(
        'local-1',
        expect.objectContaining({ status: TaskStatus.NotStarted }),
        'workflo-server'
      )
    })
  })

  describe('importTasksEnterprise - re-linking tasks of another source', () => {
    function remote(id: string, tenantId: string, extra: Record<string, unknown> = {}) {
      return {
        id, tenantId, title: `Remote ${id}`, status: 'pending', priority: 'medium',
        description: '', taskData: { fields: [], outputs: [] }, assignees: [], ...extra
      }
    }

    function setup(remoteTasks: unknown[]) {
      const { db } = createTestDb()
      const oldSource = db.createTaskSource({ mcp_server_id: null, name: 'Old', plugin_id: 'peakflo' })!
      const newSource = db.createTaskSource({ mcp_server_id: null, name: 'New', plugin_id: 'peakflo' })!
      const local = (externalId: string, tenantId: string) => {
        const task = db.createTask({ title: `Local ${externalId}`, source_id: oldSource.id, external_id: externalId })!
        db.setSetting(`workflo-task:${task.id}`, JSON.stringify({ id: externalId, tenantId }))
        return task
      }
      const ctx = makeContext({
        db,
        workfloApiClient: {
          listTaskCache: vi.fn().mockResolvedValue({ tasks: remoteTasks, nextCursor: null }),
          downloadFile: vi.fn()
        } as unknown as PluginContext['workfloApiClient']
      })
      return { db, ctx, newSource, local }
    }

    it('updates the local task of the same tenant instead of creating a copy', async () => {
      const { db, ctx, newSource, local } = setup([remote('wf-1', 'tenant-a'), remote('wf-2', 'tenant-a')])
      const sameTenant = local('wf-1', 'tenant-a')
      const otherTenant = local('wf-2', 'tenant-b')

      const result = await plugin.importTasks(newSource.id, { enterprise_mode: true }, ctx)

      expect(result).toMatchObject({ updated: 1, imported: 1, errors: [] })
      expect(db.getTask(sameTenant.id)!.title).toBe('Remote wf-1')
      // A task of another tenant with the same external id is left alone.
      expect(db.getTask(otherTenant.id)!.title).toBe('Local wf-2')
      expect(db.getTaskByExternalId(newSource.id, 'wf-2')).toBeDefined()
    })

    it('deletes the re-linked local task when the remote one was deleted', async () => {
      const { db, ctx, newSource, local } = setup([
        remote('wf-1', 'tenant-a', { deletedAt: new Date().toISOString() }),
        // The same remote id again after the delete must not find the deleted task.
        remote('wf-1', 'tenant-a')
      ])
      const linked = local('wf-1', 'tenant-a')

      const result = await plugin.importTasks(newSource.id, { enterprise_mode: true }, ctx)

      expect(db.getTask(linked.id)).toBeUndefined()
      expect(result).toMatchObject({ updated: 0, imported: 1, errors: [] })
    })
  })
})
