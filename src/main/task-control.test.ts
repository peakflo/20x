import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { TaskControl } from './task-control'
import type { ResponsibilityManager } from './responsibility-manager'
import { TaskStatus } from '../shared/constants'
import { AgentManager } from './agent-manager'
import { SyncManager } from './sync-manager'
import { PeakfloPlugin } from './plugins/peakflo-plugin'
import type { WorkfloTask } from './workflo-api-client'
import { RecurrenceScheduler } from './recurrence-scheduler'

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
  it.each(['none', 'reuse', 'separate'] as const)('stops local work with local-only resources and waits for Workflo completion (schedule: %s)', async schedule => {
    db.db.exec('ALTER TABLE tasks ADD COLUMN heartbeat_enabled INTEGER NOT NULL DEFAULT 0')
    const agent = db.createAgent({ name: 'Local agent', config: { coding_agent: 'codex' } })!
    const skill = db.createSkill({ name: 'Local skill', description: '', content: 'Local instructions' })!
    const t = db.createTask({ title: 'Working task', status: TaskStatus.AgentWorking, is_recurring: schedule !== 'none',
      recurrence_mode: schedule === 'reuse' ? 'reuse' : 'separate', recurrence_pattern: schedule === 'none' ? null : '*/5 * * * *' })!
    const outputs = [{ id: 'result', name: 'Result', type: 'text' as const, value: 'Verified fix' }]
    db.updateTask(t.id, { agent_id: agent.id, skill_ids: [skill.id], session_id: 'saved-session', output_fields: outputs })
    // Legacy local schedules need no conversion when their only requested action is completion.
    if (schedule === 'separate') db.updateTask(t.id, { recurrence_pattern: { frequency: 'daily', interval: 1 } as never })
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
    const remote = { id: 'remote-task', title: t.title, status: 'not_started', version: 1, agentId: null, skillIds: [],
      executionMode: 'human', assignees: [], isRecurring: false, taskData: null } as unknown as WorkfloTask
    const api = { getDomain: () => 'api.test', createTask: vi.fn(async () => {
      expect(destroySession).toHaveBeenCalledWith('saved-session', { agentId: agent.id, taskId: t.id, workspaceDir: process.cwd() })
      expect(agents.isTaskStoppedForControl(t.id)).toBe(true)
      expect(agents.findSessionByTaskId(t.id)).toBeUndefined()
      expect(db.getTask(t.id)).toMatchObject({ session_id: 'saved-session', status: TaskStatus.AgentWorking })
      return remote
    }), executeAction: vi.fn(async () => undefined), getTask: vi.fn(async () => remote) }
    const sync = new SyncManager(db, {} as never, { get: () => new PeakfloPlugin() } as never, undefined, id => agents.isTaskStoppedForControl(id))
    Object.assign(sync, { workfloApiClient: api, enterpriseUserId: 'user-1' })
    const responsibilities = { projectForTask: () => undefined, stepForTask: () => undefined, snapshot: () => ({ responsibilities: [] }) } as unknown as ResponsibilityManager
    control = new TaskControl(db, agents, sync, responsibilities, confirm, notify, new RecurrenceScheduler(db))
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
      expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({
        assignees: [{ assigneeType: 'user', assigneeValue: 'user-1' }], skillIds: [], autoCompleteWithoutReview: false
      }))
      expect(api.createTask).not.toHaveBeenCalledWith(expect.objectContaining({ agentId: expect.anything() }))
      expect(api.createTask).not.toHaveBeenCalledWith(expect.objectContaining({ cron: expect.anything() }))
      if (schedule !== 'none') expect(db.getTask(t.id)?.recurrence_paused).toBe(true)
      expect(api.executeAction).toHaveBeenCalledWith('remote-task', { action: 'complete', result: 'Verified fix' }, 1)
      api.getTask.mockResolvedValue({ ...remote, status: 'completed', version: 2 })
      await sync.flushTaskCompletions()
      expect(db.getTask(t.id)).toMatchObject({ status: TaskStatus.Completed, session_id: 'saved-session', output_fields: outputs })
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

  it('approves the full batch once, deduplicating selected descendants and cleaning every task', async () => {
    const parent = task('First task')
    const child = db.createTask({ title: 'Selected child', parent_task_id: parent.id })!
    const second = task('Second task')
    const occurrence = db.createTask({ title: 'Saved check', recurrence_parent_id: second.id })!
    const unrelated = task('Keep this task')
    for (const t of [parent, child, second, occurrence]) db.upsertTranscriptParts(t.id, [{ id: 'part', role: 'assistant', content: 'Saved result' }])
    const result = await control.run({ action: 'delete', task_ids: [child.id, second.id, parent.id, child.id] })
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Delete 4 tasks?', confirmLabel: 'Delete 4 tasks' })
    for (const t of [parent, child, second, occurrence]) {
      expect(confirm.mock.calls[0][0].detail.split(`[${t.id}]`)).toHaveLength(2)
      expect(confirm.mock.calls[0][0].detail).toContain(t.title)
      expect(db.getTranscriptParts(t.id)).toEqual([])
    }
    expect(stop).toHaveBeenCalledOnce()
    expect(new Set(stop.mock.calls[0][0])).toEqual(new Set([parent.id, child.id, second.id, occurrence.id]))
    expect(result).toMatchObject({ success: true, deletedTaskIds: expect.arrayContaining([parent.id, child.id, second.id, occurrence.id]) })
    expect(db.getTasks().map(t => t.id)).toEqual([unrelated.id])
    expect(db.deleteTaskAttachments).toHaveBeenCalledTimes(4)
  })

  it('leaves the entire batch intact when declined or stopped during confirmation', async () => {
    const tasks = [task('First'), task('Second')]
    const args = { action: 'delete', task_ids: tasks.map(t => t.id) }
    confirm.mockResolvedValueOnce(false)
    expect(await control.run(args)).toMatchObject({ success: false, cancelled: true, taskIds: args.task_ids })
    confirm.mockImplementationOnce(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })))
    const pending = control.run(args)
    await expect(control.run(args)).rejects.toThrow('already waiting')
    await control.stop()
    expect(await pending).toMatchObject({ cancelled: true })
    expect(db.getTasks()).toHaveLength(2)
    expect(stop).not.toHaveBeenCalled()
  })

  it('rejects invalid or mixed batch targets before requesting approval', async () => {
    const t = task()
    for (const args of [
      { action: 'delete', task_ids: [] }, { action: 'delete', task_ids: 'all' },
      { action: 'delete', task_ids: [t.id], task_id: t.id }, { action: 'complete', task_ids: [t.id] },
      { action: 'delete', task_ids: Array(101).fill(t.id) }, { action: 'delete', task_ids: [t.id, null] },
      { action: 'delete', task_ids: [t.id, 'missing'] }, { action: 'delete', task_ids: [t.id, 'mastermind-session'] }
    ]) await expect(control.run(args)).rejects.toThrow()
    expect(confirm).not.toHaveBeenCalled()
    expect(db.getTask(t.id)).toBeDefined()
  })

  it('checks every target for project ownership and pending source commands', async () => {
    const first = task('This project')
    const second = task('Other project')
    const responsibilities = { projectForTask: (id: string) => ({ id: id === second.id ? 'other' : 'project' }), stepForTask: () => undefined, snapshot: () => ({ responsibilities: [] }) } as unknown as ResponsibilityManager
    control = new TaskControl(db, { withStoppedTasks: (ids, action, beforeStop) => stop(ids, action, beforeStop) as ReturnType<typeof action> }, { completeTask: complete }, responsibilities, confirm, notify)
    await expect(control.run({ action: 'delete', task_ids: [first.id, second.id] }, 'project')).rejects.toThrow('another project')
    db.setSetting(`workflo-upload:${second.id}`, 'pending')
    await expect(control.run({ action: 'delete', task_ids: [first.id, second.id] })).rejects.toThrow('pending Workflo command')
    expect(confirm).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(db.getTasks()).toHaveLength(2)
  })

  it.each(['confirmation', 'cleanup'])('rechecks the entire batch after %s', async when => {
    const first = task('First')
    const second = task('Second')
    const change = () => db.createTask({ title: 'Unapproved child', parent_task_id: second.id })
    if (when === 'confirmation') confirm.mockImplementationOnce(async () => { change(); return true })
    else stop.mockImplementationOnce(async (_ids, action) => { change(); return action() })
    await expect(control.run({ action: 'delete', task_ids: [first.id, second.id] })).rejects.toThrow('task or source changed')
    expect(db.getTasks()).toHaveLength(3)
    expect(db.deleteTaskAttachments).not.toHaveBeenCalled()
  })

  it('returns an accurate partial result if deletion fails instead of claiming the whole batch succeeded', async () => {
    const first = task('First')
    const second = task('Second')
    const deleteTask = db.deleteTask.bind(db)
    vi.spyOn(db, 'deleteTask').mockImplementation(id => {
      if (id === first.id) throw new Error('Deletion failed')
      return deleteTask(id)
    })
    expect(await control.run({ action: 'delete', task_ids: [first.id, second.id] })).toMatchObject({
      success: false, deletedTaskIds: [second.id], remainingTaskIds: [first.id], error: 'Deletion failed'
    })
    expect(confirm).toHaveBeenCalledOnce()
    expect(db.getTask(first.id)).toBeDefined()
    expect(db.getTask(second.id)).toBeUndefined()
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
