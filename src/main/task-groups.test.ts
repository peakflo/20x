import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { TaskGroups } from './task-groups'
import { TaskControl } from './task-control'
import type { ResponsibilityManager } from './responsibility-manager'

let db: ReturnType<typeof createTestDb>['db']
let control: TaskControl
let confirm: ReturnType<typeof vi.fn<ConstructorParameters<typeof TaskControl>[4]>>
let stop: ReturnType<typeof vi.fn<ConstructorParameters<typeof TaskControl>[1]['withStoppedTasks']>>
const responsibilities = { projectForTask: () => undefined, stepForTask: () => undefined, snapshot: () => ({ projects: [], responsibilities: [] }) } as unknown as ResponsibilityManager

beforeEach(() => {
  ;({ db } = createTestDb())
  vi.spyOn(db, 'deleteTaskAttachments').mockImplementation(() => {})
  confirm = vi.fn(async () => true)
  stop = vi.fn(async (_ids, action, beforeStop) => { await beforeStop?.(); return action() })
  control = new TaskControl(db, { withStoppedTasks: (ids, action, beforeStop) => stop(ids, action, beforeStop) as ReturnType<typeof action> }, { completeTask: vi.fn() }, responsibilities, confirm, vi.fn())
})
afterEach(async () => { await control.stop(); db.db.close() })

it('persists one membership, inherits subtasks and recurring checks, and respects explicit removal', () => {
  const a = db.groups.create('Release')
  const b = db.groups.create('Incident')
  const parent = db.createTask({ title: 'Schedule', group_id: a.id })!
  const child = db.createTask({ title: 'Subtask', parent_task_id: parent.id })!
  const check = db.createTask({ title: 'Check', recurrence_parent_id: parent.id })!
  expect(db.groups.snapshot().membership).toEqual({ [parent.id]: a.id, [child.id]: a.id, [check.id]: a.id })
  db.groups.assign([child.id], null)
  db.groups.assign([parent.id], b.id)
  const reopened = new TaskGroups(db)
  expect(reopened.snapshot().membership).toEqual({ [parent.id]: b.id, [check.id]: b.id })
  db.groups.assign([child.id], a.id)
  expect(reopened.snapshot().membership[child.id]).toBe(a.id)
})

it('deletes a Group alone without stopping tasks and never recreates its execution Group', async () => {
  const id = db.groups.ensureExecution('execution', 'Release', 'project')!
  const task = db.createTask({ title: 'Work', group_id: id })!
  expect(await control.manageGroup({ action: 'delete', group_id: id })).toMatchObject({ success: true })
  expect(db.getTask(task.id)).toBeDefined()
  expect(stop).not.toHaveBeenCalled()
  expect(db.groups.ensureExecution('execution', 'Release', 'project')).toBeNull()
  expect(new TaskGroups(db).snapshot()).toEqual({ groups: [], membership: {}, executions: { execution: null } })
})

it('uses one confirmation for the Group, dependent tasks, and recurring instances', async () => {
  const id = db.groups.create('Delivery').id
  const other = db.groups.create('Other').id
  const parent = db.createTask({ title: 'Schedule', group_id: id })!
  const child = db.createTask({ title: 'Child', parent_task_id: parent.id, group_id: other })!
  const check = db.createTask({ title: 'Check', recurrence_parent_id: parent.id })!
  const unaffected = db.createTask({ title: 'Keep', group_id: other })!
  const result = await control.manageGroup({ action: 'delete_with_tasks', group_id: id })
  expect(result).toMatchObject({ success: true })
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(confirm.mock.calls[0][0].detail).toContain(child.id)
  expect(confirm.mock.calls[0][0].detail).toContain(check.id)
  expect(stop.mock.calls[0][0]).toEqual(expect.arrayContaining([parent.id, child.id, check.id]))
  expect(db.getTasks().map(t => t.id)).toEqual([unaffected.id])
  expect(db.groups.snapshot().groups.map(g => g.id)).toEqual([other])
})

it('keeps the Group after cancellation, changed membership, or partial task deletion', async () => {
  const id = db.groups.create('Review').id
  const first = db.createTask({ title: 'First', group_id: id })!
  const second = db.createTask({ title: 'Second', group_id: id })!
  confirm.mockResolvedValueOnce(false)
  expect(await control.manageGroup({ action: 'delete_with_tasks', group_id: id })).toMatchObject({ cancelled: true })
  confirm.mockImplementationOnce(async () => { db.groups.assign([second.id], null); return true })
  await expect(control.manageGroup({ action: 'delete_with_tasks', group_id: id })).rejects.toThrow('membership changed')
  expect(stop).not.toHaveBeenCalled()
  db.groups.assign([second.id], id)
  const original = db.deleteTask.bind(db)
  let deleted = ''
  vi.spyOn(db, 'deleteTask').mockImplementation(taskId => { if (deleted) throw new Error('Disk unavailable'); deleted = taskId; return original(taskId) })
  const result = await control.manageGroup({ action: 'delete_with_tasks', group_id: id })
  expect(result).toMatchObject({ success: false, error: 'Disk unavailable', deletedTaskIds: [deleted] })
  expect(result.remainingTaskIds).toHaveLength(1)
  expect(db.groups.get(id).name).toBe('Review')
  expect(db.getTask(first.id) || db.getTask(second.id)).toBeDefined()
})

it('allows an empty Group deletion and validates task creation before effects', async () => {
  const id = db.groups.create('Empty').id
  expect(await control.manageGroup({ action: 'delete_with_tasks', group_id: id })).toMatchObject({ success: true })
  expect(() => db.createTask({ title: 'Bad group', group_id: 'missing' })).toThrow('Group not found')
  expect(db.getTasks()).toEqual([])
  const valid = db.groups.create('Valid').id
  vi.spyOn(db.groups, 'assign').mockImplementationOnce(() => { throw new Error('Failed saving membership') })
  expect(() => db.createTask({ title: 'Atomic', group_id: valid })).toThrow('Failed saving membership')
  expect(db.getTasks()).toEqual([])
})
