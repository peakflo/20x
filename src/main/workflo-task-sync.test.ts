import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import type { WorkfloApiClient, WorkfloTask } from './workflo-api-client'
import type { PluginContext } from './plugins/types'
import { PeakfloPlugin } from './plugins/peakflo-plugin'
import { TaskAutomationScheduler } from './task-automation-scheduler'
import type { AgentManager } from './agent-manager'
import { SyncManager } from './sync-manager'
import { serverTaskFields } from './workflo-task-sync'

let db: DatabaseManager
let sourceId: string
const remote = (status = 'not_started'): WorkfloTask => ({
  id: 'remote-1', tenantId: 'tenant-1', title: 'Server task', description: '', status,
  version: 3, agentId: null, skillIds: [], cron: '* * * * *', isRecurring: true,
  executionMode: 'human', assignees: [], taskData: null
} as unknown as WorkfloTask)

beforeEach(() => {
  db = createTestDb().db
  sourceId = db.createTaskSource({ name: 'Workflo', plugin_id: 'peakflo', mcp_server_id: null,
    config: { enterprise_mode: true }, list_tool: '', list_tool_args: {}, update_tool: '', update_tool_args: {} })!.id
})

function context(api: Partial<WorkfloApiClient>): PluginContext {
  return { db, workfloApiClient: api as WorkfloApiClient } as PluginContext
}

it('refuses local completion and unlink, but accepts a server completion', () => {
  const task = db.createTask(makeTask({ external_id: 'remote-1', source_id: sourceId, complete_at_source: false }))!
  expect(() => db.updateTask(task.id, { status: 'completed' })).toThrow('Workflo controls')
  expect(db.getTask(task.id)?.status).toBe('not_started')
  expect(() => db.updateTask(task.id, { source_id: null })).toThrow('Only the sync service')
  db.updateTask(task.id, { status: 'completed' }, 'workflo-server')
  expect(db.getTask(task.id)?.status).toBe('completed')
})

it('does not close after action success when the server still reports open', async () => {
  const task = db.createTask(makeTask({ external_id: 'remote-1', source_id: sourceId }))!
  const api = { executeAction: vi.fn().mockResolvedValue(undefined), getTask: vi.fn().mockResolvedValue(remote('ready_for_review')) }
  const result = await new PeakfloPlugin().executeAction('complete', task, undefined, {}, context(api))
  expect(result.success).toBe(false)
  expect(db.getTask(task.id)?.status).toBe('ready_for_review')
  api.getTask.mockResolvedValue(remote('completed'))
  expect((await new PeakfloPlugin().executeAction('complete', task, undefined, {}, context(api))).success).toBe(true)
  expect(db.getTask(task.id)?.status).toBe('completed')
})

it('pulls canonical status and never installs a second schedule', async () => {
  const local = db.createTask(makeTask({ external_id: 'remote-1', source_id: sourceId, status: 'completed' }))!
  const listTaskCache = vi.fn().mockResolvedValue({ tasks: [remote('ready_for_review')], pagination: { totalPages: 1 } })
  await new PeakfloPlugin().importTasks(sourceId, { status_filter: 'pending' }, context({ listTaskCache }))
  expect(db.getTask(local.id)).toMatchObject({ status: 'ready_for_review', server_managed: true, is_recurring: false, auto_start_agent: false })
  expect(listTaskCache).toHaveBeenCalledWith(undefined)
  expect(JSON.parse(db.getSetting(`workflo-task:${local.id}`)!)).toMatchObject({ cron: '* * * * *', version: 3 })
})

it('does not start or complete a server task from stale local automation flags', async () => {
  db.createTask(makeTask({ external_id: 'remote-1', source_id: sourceId, auto_start_agent: true }))!
  db.createTask(makeTask({ external_id: 'remote-2', source_id: sourceId, status: 'ready_for_review', auto_complete_without_review: true }))!
  const manager = { startTask: vi.fn(), completeTaskWithoutReview: vi.fn(), hasActiveSessionForTask: vi.fn().mockReturnValue(false) }
  await new TaskAutomationScheduler(db, manager as unknown as AgentManager).runNow()
  expect(manager.startTask).not.toHaveBeenCalled()
  expect(manager.completeTaskWithoutReview).not.toHaveBeenCalled()
})

it('maps enterprise agent and skill IDs without changing published agent data', () => {
  const agent = db.createAgent({ name: 'Agent', config: { enterprise_agent_id: 'agent-remote' } as never })!
  const skill = db.createSkill({ name: 'Skill', description: '', content: '', enterprise_skill_id: 'skill-remote' })!
  expect(serverTaskFields(db, { ...remote(), agentId: 'agent-remote', skillIds: ['skill-remote'] })).toMatchObject({ agent_id: agent.id, skill_ids: [skill.id] })
})

describe('durable upload', () => {
  function setup() {
    db.setSetting('enterprise_tenant_id', 'tenant-1')
    const api = { getDomain: () => 'api.test', createTask: vi.fn().mockRejectedValue(new Error('offline')) }
    const sync = new SyncManager(db, {} as never, { get: () => undefined } as never)
    // Set connection state directly so this test controls when retries run.
    Object.assign(sync, { workfloApiClient: api, enterpriseUserId: 'user-1' })
    return { api, sync }
  }

  it('keeps one request ID across offline retry and binds the same local task', async () => {
    const { api, sync } = setup()
    const task = db.createTask(makeTask())!
    expect(await sync.uploadTask(task.id)).toEqual({ queued: true })
    const first = api.createTask.mock.calls[0][0]
    expect(first.assignees).toEqual([{ assigneeType: 'user', assigneeValue: 'user-1' }])
    api.createTask.mockResolvedValue(remote() as never)
    await sync.flushTaskUploads()
    expect(api.createTask.mock.calls[1][0].clientRequestId).toBe(first.clientRequestId)
    expect(db.getTask(task.id)?.external_id).toBe('remote-1')
    expect(db.getSetting(`workflo-upload:${task.id}`)).toBeUndefined()
    expect(db.getTasks()).toHaveLength(1)
  })

  it('does not replay an upload into a different tenant', async () => {
    const { api, sync } = setup()
    const task = db.createTask(makeTask())!
    await sync.uploadTask(task.id)
    db.setSetting('enterprise_tenant_id', 'tenant-2')
    api.createTask.mockClear()
    await sync.flushTaskUploads()
    expect(api.createTask).not.toHaveBeenCalled()
    expect(db.getSetting(`workflo-upload:${task.id}`)).toBeDefined()
  })
})

it('does not fire local recurrence for an old Workflo task with a stale schedule', async () => {
  const { RecurrenceScheduler } = await import('./recurrence-scheduler')
  const task = db.createTask(makeTask({ external_id: 'remote-1', source_id: sourceId,
    is_recurring: true, recurrence_pattern: '* * * * *' }))!
  db.updateTask(task.id, { next_occurrence_at: new Date(Date.now() - 120000).toISOString() })
  const scheduler = new RecurrenceScheduler(db, 'UTC')
  await (scheduler as unknown as { checkAndCreateDueInstances(): Promise<void> }).checkAndCreateDueInstances()
  expect(db.getTasks()).toHaveLength(1)
})

it('refuses a successful legacy action without a completed task read', async () => {
  const task = db.createTask(makeTask({ external_id: 'remote-1', source_id: sourceId }))!
  const ctx = { db, mcpServer: { id: 'mcp' }, toolCaller: { callTool: vi.fn().mockResolvedValue({ success: true,
    result: { content: [{ type: 'text', text: JSON.stringify({ status: 'pending' }) }] } }) } } as unknown as PluginContext
  expect((await new PeakfloPlugin().executeAction('complete', task, undefined, {}, ctx)).success).toBe(false)
  expect(db.getTask(task.id)?.status).toBe('not_started')
})

it('keeps offline metadata and original version across conflict and pull', async () => {
  db.setSetting('enterprise_tenant_id', 'tenant-1')
  const local = db.createTask(makeTask({ title: 'Old title', external_id: 'remote-1', source_id: sourceId }))!
  db.setSetting(`workflo-task:${local.id}`, JSON.stringify(remote()))
  const api = {
    getDomain: () => 'api.test',
    updateTask: vi.fn().mockRejectedValue(new Error('409: Task changed on the server')),
    getTask: vi.fn().mockResolvedValue({ ...remote(), version: 4 }),
    listTaskCache: vi.fn().mockResolvedValue({ tasks: [{ ...remote(), title: 'Someone else changed this', version: 4 }], pagination: { totalPages: 1 } })
  }
  const plugin = new PeakfloPlugin()
  const sync = new SyncManager(db, {} as never, { get: () => plugin } as never)
  Object.assign(sync, { workfloApiClient: api, enterpriseUserId: 'user-1' })
  db.updateTask(local.id, { title: 'My pending title' })
  await sync.exportTaskUpdate(local.id, { title: 'My pending title', status: 'completed' })
  expect(api.updateTask).toHaveBeenCalledWith('remote-1', { title: 'My pending title', expectedVersion: 3 })
  await plugin.importTasks(sourceId, {}, context(api))
  expect(db.getTask(local.id)).toMatchObject({ title: 'Someone else changed this', server_sync_pending: true, server_sync_error: '409: Task changed on the server' })
  await sync.flushTaskUpdates()
  expect(api.updateTask.mock.calls[1][1]).toMatchObject({ expectedVersion: 3 })
  expect(JSON.parse(db.getSetting(`workflo-task:${local.id}`)!)).toMatchObject({ version: 4 })
})

it('a desktop helper cannot send status with the human credential', () => {
  const local = db.createTask(makeTask({ external_id: 'remote-1', source_id: sourceId }))!
  expect(() => db.updateTask(local.id, {status:'ready_for_review'})).toThrow('Workflo controls')
  expect(db.getTask(local.id)?.status).toBe('not_started')
  expect(db.getSetting(`workflo-progress:${local.id}`)).toBeUndefined()
})

it('refuses local progress for autonomous and completed server tasks', () => {
  const local = db.createTask(makeTask({ external_id: 'remote-1', source_id: sourceId }))!
  db.setSetting(`workflo-task:${local.id}`, JSON.stringify({ ...remote(), executionMode: 'autonomous' }))
  expect(() => db.updateTask(local.id, { status: 'ready_for_review' })).toThrow('Workflo controls')
  db.setSetting(`workflo-task:${local.id}`, JSON.stringify(remote('completed')))
  expect(() => db.updateTask(local.id, { status: 'agent_working' })).toThrow('Workflo controls')
})

it('stores an offline human completion with its original version until the server confirms it',async()=>{
  db.setSetting('enterprise_tenant_id','tenant-1')
  const local=db.createTask(makeTask({external_id:'remote-1',source_id:sourceId}))!
  db.setSetting(`workflo-task:${local.id}`,JSON.stringify(remote()))
  const api={getDomain:()=> 'api.test',executeAction:vi.fn().mockRejectedValue(new Error('offline')),getTask:vi.fn().mockResolvedValue(remote('completed'))}
  const sync=new SyncManager(db,{} as never,{get:()=>new PeakfloPlugin()} as never)
  Object.assign(sync,{workfloApiClient:api,enterpriseUserId:'user-1'})
  expect((await sync.executeAction('complete',local,undefined,sourceId)).success).toBe(false)
  expect(db.getTask(local.id)?.status).toBe('not_started')
  expect(JSON.parse(db.getSetting(`workflo-completion:${local.id}`)!)).toMatchObject({expectedVersion:3})
  api.executeAction.mockResolvedValue(undefined)
  await sync.flushTaskCompletions()
  expect(api.executeAction).toHaveBeenLastCalledWith('remote-1',{action:'complete'},3)
  expect(db.getTask(local.id)?.status).toBe('completed')
  expect(db.getSetting(`workflo-completion:${local.id}`)).toBeUndefined()
})

it('a local draft cannot become completed without server acceptance',()=>{
  const draft=db.createTask(makeTask())!
  expect(()=>db.updateTask(draft.id,{status:'completed'})).toThrow('Workflo must confirm')
  expect(db.getTask(draft.id)?.status).toBe('not_started')
})
