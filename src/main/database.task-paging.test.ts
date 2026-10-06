import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import { TaskStatus } from '../shared/constants'

let db: DatabaseManager

function create(overrides: Record<string, unknown> = {}, status?: TaskStatus) {
  const task = db.createTask(makeTask(overrides))!
  if (status) db.updateTask(task.id, { status })
  return db.getTask(task.id)!
}

beforeEach(() => {
  ;({ db } = createTestDb())
})

describe('open task set and completed paging', () => {
  it('excludes completed history from the open set but keeps related tasks', () => {
    const open = create({ title: 'open' })
    const done = create({ title: 'done' }, TaskStatus.Completed)
    const doneSubOfOpen = create({ title: 'done sub', parent_task_id: open.id }, TaskStatus.Completed)
    const doneParent = create({ title: 'done parent' }, TaskStatus.Completed)
    const openSubOfDone = create({ title: 'open sub', parent_task_id: doneParent.id })

    const ids = new Set(db.getOpenTasks().map((t) => t.id))
    expect(ids.has(open.id)).toBe(true)
    expect(ids.has(doneSubOfOpen.id)).toBe(true)
    expect(ids.has(doneParent.id)).toBe(true)
    expect(ids.has(openSubOfDone.id)).toBe(true)
    expect(ids.has(done.id)).toBe(false)
  })

  it('pages completed top-level tasks with their subtasks and a total', () => {
    const parents = Array.from({ length: 5 }, (_, i) => create({ title: `done ${i}` }, TaskStatus.Completed))
    create({ title: 'sub of done 0', parent_task_id: parents[0].id }, TaskStatus.Completed)
    create({ title: 'still open' })

    const first = db.getCompletedTasksPage(0, 2)
    expect(first.total).toBe(5)
    expect(first.tasks.filter((t) => !t.parent_task_id)).toHaveLength(2)

    const all = db.getCompletedTasksPage(0, 10)
    expect(all.tasks.filter((t) => !t.parent_task_id)).toHaveLength(5)
    expect(all.tasks.some((t) => t.title === 'sub of done 0')).toBe(true)

    const second = db.getCompletedTasksPage(2, 2)
    const firstIds = new Set(first.tasks.map((t) => t.id))
    expect(second.tasks.filter((t) => !t.parent_task_id).every((t) => !firstIds.has(t.id))).toBe(true)

    expect(db.getCompletedTasksPage(0, 0)).toEqual({ tasks: [], total: 5 })
  })

  it('filters completed tasks by query, treating % and _ literally', () => {
    create({ title: 'Invoice review' }, TaskStatus.Completed)
    create({ title: 'Other thing' }, TaskStatus.Completed)
    create({ title: '100% done' }, TaskStatus.Completed)

    expect(db.getCompletedTasksPage(0, 50, 'invoice').tasks.map((t) => t.title)).toEqual(['Invoice review'])
    expect(db.getCompletedTasksPage(0, 50, '%').tasks.map((t) => t.title)).toEqual(['100% done'])
    expect(db.getCompletedTasksPage(0, 50, 'invoice').total).toBe(1)
  })

  it('aggregates completed stats', () => {
    create({ title: 'a' }, TaskStatus.Completed)
    create({ title: 'b', agent_id: null }, TaskStatus.Completed)
    create({ title: 'open' })

    const all = db.getCompletedTaskStats(null)
    expect(all.total).toBe(2)
    expect(all.completedInWindow).toBe(2)
    expect(all.createdInWindow).toBe(2)

    const future = db.getCompletedTaskStats(new Date(Date.now() + 60_000).toISOString())
    expect(future.total).toBe(2)
    expect(future.completedInWindow).toBe(0)
  })
})
