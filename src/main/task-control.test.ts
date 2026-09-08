import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { TaskControl } from './task-control'
import type { ResponsibilityManager } from './responsibility-manager'
import { TaskStatus } from '../shared/constants'
import { AgentManager } from './agent-manager'
import { SyncManager } from './sync-manager'
import { PeakfloPlugin } from './plugins/peakflo-plugin'
import type { WorkfloTask } from './workflo-api-client'

let db: ReturnType<typeof createTestDb>['db']
let confirm: ReturnType<typeof vi.fn<ConstructorParameters<typeof TaskControl>[4]>>
let stop: ReturnType<typeof vi.fn<ConstructorParameters<typeof TaskControl>[1]['withStoppedTasks']>>
let complete: ReturnType<typeof vi.fn<ConstructorParameters<typeof TaskControl>[2]['completeTask']>>
let control: TaskControl
let notify: ReturnType<typeof vi.fn<(channel: string, data: unknown) => void>>
const task = (title = 'Fix regression') => db.createTask({ title })!
beforeEach(() => {
  ;({ db } = createTestDb())
  // Keep attachment deletion inside the isolated test environment.
  vi.spyOn(db, 'deleteTaskAttachments').mockImplementation(() => {})
  confirm = vi.fn(async () => true)
  stop = vi.fn(async (_ids, action, beforeStop) => { await beforeStop?.(); return action() })
  complete = vi.fn(async id => { db.updateTask(id, { status: TaskStatus.Completed }, 'workflo-server'); return { success: true } })
  notify = vi.fn()
  const responsibilities = { projectForTask: () => undefined, stepForTask: () => undefined, snapshot: () => ({ responsibilities: [] }) } as unknown as ResponsibilityManager
  control = new TaskControl(db, { withStoppedTasks: (ids, action, beforeStop) => stop(ids, action, beforeStop) as ReturnType<typeof action> }, { completeTask: complete }, responsibilities, confirm, notify)
})
afterEach(async () => { await control.stop(); db.db.close() })

describe('Mastermind task administration', () => {
  it('stops a working local task, retains its history, and waits for Workflo to confirm completion', async () => {
    db.db.exec('ALTER TABLE tasks ADD COLUMN heartbeat_enabled INTEGER NOT NULL DEFAULT 0')
    const agent = db.createAgent({ name: 'Agent', config: { enterprise_agent_id: 'remote-agent' } as never })!
    const t = db.createTask({ title: 'Working task', status: TaskStatus.AgentWorking })!
    db.updateTask(t.id, { agent_id: agent.id, session_id: 'saved-session' })
    db.upsertTranscriptParts(t.id, [{ id: 'answer', role: 'assistant', content: 'Work so far' }])
    const history = db.getTranscriptParts(t.id)
    db.setSetting('enterprise_tenant_id', 'tenant-1')
    const agents = new AgentManager(db)
    const destroySession = vi.fn(async () => undefined)
    type Session = NonNullable<ReturnType<AgentManager['findSessionByTaskId']>>['session']
    const session: Session = { id: 'saved-session', taskId: t.id, agentId: agent.id, status: 'working', createdAt: new Date(),
      seenMessageIds: new Set(), seenPartIds: new Set(), partContentLengths: new Map(), adapter: { destroySession } as unknown as Session['adapter'] }
    Object.assign(agents, { sessions: new Map([[session.id, session]]) })
    vi.spyOn(agents as unknown as { buildSessionConfig(): Promise<object> }, 'buildSessionConfig').mockResolvedValue({})
    const remote = { id: 'remote-task', title: t.title, status: 'not_started', version: 1, agentId: 'remote-agent', skillIds: [],
      executionMode: 'human', assignees: [], isRecurring: false, taskData: null } as unknown as WorkfloTask
    const api = { getDomain: () => 'api.test', createTask: vi.fn(async () => {
      expect(destroySession).toHaveBeenCalledWith('saved-session', {})
      expect(agents.isTaskStoppedForControl(t.id)).toBe(true)
      expect(agents.findSessionByTaskId(t.id)).toBeUndefined()
      expect(db.getTask(t.id)).toMatchObject({ session_id: 'saved-session', status: TaskStatus.AgentWorking })
      return remote
    }), executeAction: vi.fn(async () => undefined), getTask: vi.fn(async () => remote) }
    const sync = new SyncManager(db, {} as never, { get: () => new PeakfloPlugin() } as never, undefined, id => agents.isTaskStoppedForControl(id))
    Object.assign(sync, { workfloApiClient: api, enterpriseUserId: 'user-1' })
    const responsibilities = { projectForTask: () => undefined, stepForTask: () => undefined, snapshot: () => ({ responsibilities: [] }) } as unknown as ResponsibilityManager
    control = new TaskControl(db, agents, sync, responsibilities, confirm, notify)
    try {
      for (const status of ['working', 'idle', 'waiting_approval', 'error'] as const) {
        session.status = status
        await expect(sync.uploadTask(t.id)).rejects.toThrow('Stop the local session')
      }
      session.status = 'working'
      destroySession.mockRejectedValueOnce(new Error('Runtime release failed'))
      await expect(control.run({ task_id: t.id, action: 'complete' })).rejects.toThrow('Runtime release failed')
      expect(agents.isTaskStoppedForControl(t.id)).toBe(false)
      expect(api.createTask).not.toHaveBeenCalled()
      expect(await control.run({ task_id: t.id, action: 'complete' })).toMatchObject({ success: false })
      expect(agents.isTaskStoppedForControl(t.id)).toBe(false)
      expect(db.getTask(t.id)?.status).not.toBe(TaskStatus.Completed)
      expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'remote-agent' }))
      expect(api.executeAction).toHaveBeenCalledWith('remote-task', { action: 'complete' }, 1)
      api.getTask.mockResolvedValue({ ...remote, status: 'completed', version: 2 })
      await sync.flushTaskCompletions()
      expect(db.getTask(t.id)).toMatchObject({ status: TaskStatus.Completed, session_id: 'saved-session' })
      expect(db.getTranscriptParts(t.id)).toEqual(history)
    } finally { await agents.stopAllSessions() }
  })

  it('treats close as completion and reports only the source result', async () => {
    const t = task()
    complete.mockResolvedValueOnce({ success: false, error: 'Completion pending' })
    expect(await control.run({ task_id: t.id, action: 'close' })).toMatchObject({ success: false, status: TaskStatus.NotStarted })
    expect(confirm.mock.calls[0][0].title).toContain('Complete')
    expect(stop).toHaveBeenCalledWith([t.id], expect.any(Function), expect.any(Function))
    expect(await control.run({ task_id: t.id, action: 'complete' })).toMatchObject({ success: true, status: TaskStatus.Completed })
  })

  it('does not delete a task or submit another completion while a Workflo command is pending', async () => {
    const t = task()
    db.setSetting(`workflo-completion:${t.id}`, JSON.stringify({ outputs: { action: 'approve' } }))
    await expect(control.run({ task_id: t.id, action: 'delete' })).rejects.toThrow('pending Workflo command')
    await expect(control.run({ task_id: t.id, action: 'complete' })).rejects.toThrow('pending Workflo command')
    expect(confirm).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it('does not allow a model approval flag to bypass a declined human confirmation', async () => {
    const t = task()
    confirm.mockResolvedValue(false)
    expect(await control.run({ task_id: t.id, action: 'delete', approved: true })).toMatchObject({ success: false, cancelled: true })
    expect(db.getTask(t.id)).toBeDefined()
    expect(stop).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('cleans every cascading task after stopping their agents, preserving unrelated tasks', async () => {
    const parent = task()
    const child = db.createTask({ title: 'Child', parent_task_id: parent.id })!
    const instance = db.createTask({ title: 'Occurrence', recurrence_parent_id: parent.id })!
    const grandchild = db.createTask({ title: 'Grandchild', parent_task_id: instance.id })!
    const other = task('Unrelated')
    stop.mockImplementationOnce(async (ids, action) => { expect(ids).toEqual(expect.arrayContaining([parent.id, child.id, instance.id, grandchild.id])); expect(db.getTask(parent.id)).toBeDefined(); return action() })
    const result = await control.run({ task_id: parent.id, action: 'delete' })
    expect(result).toMatchObject({ success: true, deletedTaskIds: expect.arrayContaining([parent.id, child.id, instance.id, grandchild.id]) })
    expect(db.getTasks().map(t => t.id)).toEqual([other.id])
    expect(db.deleteTaskAttachments).toHaveBeenCalledTimes(4)
    expect(notify).toHaveBeenCalledWith('task:deleted', { taskId: grandchild.id })
  })

  it('rejects stale consent both while the dialog is open and during asynchronous cleanup', async () => {
    const t = task()
    confirm.mockImplementationOnce(async () => { db.updateTask(t.id, { title: 'Different work' }); return true })
    await expect(control.run({ task_id: t.id, action: 'delete' })).rejects.toThrow('task or source changed')
    expect(stop).not.toHaveBeenCalled()
    stop.mockImplementationOnce(async (_ids, action) => { db.createTask({ title: 'Late child', parent_task_id: t.id }); return action() })
    await expect(control.run({ task_id: t.id, action: 'delete' })).rejects.toThrow('task or source changed')
    expect(db.getTasks()).toHaveLength(2)
  })

  it('refuses mutation after failed cleanup and releases its pending action', async () => {
    const t = task()
    stop.mockRejectedValueOnce(new Error('Runtime release failed'))
    await expect(control.run({ task_id: t.id, action: 'delete' })).rejects.toThrow('Runtime release failed')
    expect(db.getTask(t.id)).toBeDefined()
    expect(await control.run({ task_id: t.id, action: 'delete' })).toMatchObject({ success: true })
  })

  it('cancels outstanding confirmation on quit and rejects overlapping actions', async () => {
    const t = task()
    confirm.mockImplementationOnce(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })))
    const first = control.run({ task_id: t.id, action: 'delete' })
    await expect(control.run({ task_id: t.id, action: 'close' })).rejects.toThrow('already waiting')
    await control.stop()
    expect(await first).toMatchObject({ cancelled: true })
    expect(stop).not.toHaveBeenCalled()
    expect(db.getTask(t.id)).toBeDefined()
  })
})
