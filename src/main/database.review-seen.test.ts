import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import { TaskStatus } from '../shared/constants'
import { isReviewUnseen } from '../shared/review-seen'
import type { DatabaseManager } from './database'

let db: DatabaseManager

function at(iso: string): void {
  vi.setSystemTime(new Date(iso))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-10-18T10:00:00.000Z')
  ;({ db } = createTestDb())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('review seen state', () => {
  it('stamps review_entered_at when a task moves into review', () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    expect(task.review_entered_at).toBeNull()

    at('2026-10-18T10:05:00.000Z')
    const updated = db.updateTask(task.id, { status: TaskStatus.ReadyForReview })!
    expect(updated.review_entered_at).toBe('2026-10-18T10:05:00.000Z')
    expect(updated.review_seen_at).toBeNull()
    expect(isReviewUnseen(updated)).toBe(true)
    expect(db.getUnseenReviewTaskIds()).toEqual([task.id])
  })

  it('does not restamp review_entered_at when the status is re-written as ready_for_review', () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    at('2026-10-18T10:05:00.000Z')
    db.updateTask(task.id, { status: TaskStatus.ReadyForReview })
    at('2026-10-18T10:06:00.000Z')
    db.markReviewSeen(task.id)

    at('2026-10-18T10:07:00.000Z')
    const again = db.updateTask(task.id, { status: TaskStatus.ReadyForReview })!
    expect(again.review_entered_at).toBe('2026-10-18T10:05:00.000Z')
    expect(isReviewUnseen(again)).toBe(false)
  })

  it('stamps review_entered_at for a task created directly in review', () => {
    const task = db.createTask(makeTask({ status: TaskStatus.ReadyForReview }))!
    expect(task.review_entered_at).toBe('2026-10-18T10:00:00.000Z')
    expect(db.getUnseenReviewTaskIds()).toEqual([task.id])
  })

  it('marks seen without touching updated_at, and a new review round makes it unseen again', () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    at('2026-10-18T10:05:00.000Z')
    const inReview = db.updateTask(task.id, { status: TaskStatus.ReadyForReview })!

    at('2026-10-18T10:06:00.000Z')
    const seen = db.markReviewSeen(task.id)!
    expect(seen.review_seen_at).toBe('2026-10-18T10:06:00.000Z')
    expect(seen.updated_at).toBe(inReview.updated_at)
    expect(isReviewUnseen(seen)).toBe(false)
    expect(db.getUnseenReviewTaskIds()).toEqual([])

    // Feedback → agent works again → back in review.
    at('2026-10-18T10:10:00.000Z')
    db.updateTask(task.id, { status: TaskStatus.AgentWorking })
    at('2026-10-18T10:20:00.000Z')
    const back = db.updateTask(task.id, { status: TaskStatus.ReadyForReview })!
    expect(back.review_entered_at).toBe('2026-10-18T10:20:00.000Z')
    expect(isReviewUnseen(back)).toBe(true)
    expect(db.getUnseenReviewTaskIds()).toEqual([task.id])
  })

  it('marks a review task unseen again', () => {
    const task = db.createTask(makeTask({ status: TaskStatus.ReadyForReview }))!
    at('2026-10-18T10:01:00.000Z')
    db.markReviewSeen(task.id)
    const unseen = db.markReviewUnseen(task.id)!
    expect(unseen.review_seen_at).toBeNull()
    expect(isReviewUnseen(unseen)).toBe(true)
  })

  it('ignores seen/unseen marks for tasks outside review', () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    expect(db.markReviewSeen(task.id)!.review_seen_at).toBeNull()
    expect(db.markReviewUnseen(task.id)!.review_seen_at).toBeNull()
  })

  it('marks every unseen review task as seen and returns only the changed tasks', () => {
    const a = db.createTask(makeTask({ title: 'A', status: TaskStatus.ReadyForReview }))!
    const b = db.createTask(makeTask({ title: 'B', status: TaskStatus.ReadyForReview }))!
    const c = db.createTask(makeTask({ title: 'C', status: TaskStatus.ReadyForReview }))!
    db.createTask(makeTask({ title: 'D', status: TaskStatus.NotStarted }))
    at('2026-10-18T10:01:00.000Z')
    db.markReviewSeen(c.id)

    at('2026-10-18T10:02:00.000Z')
    const changed = db.markAllReviewSeen()
    expect(changed.map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
    expect(changed.every((t) => t.review_seen_at === '2026-10-18T10:02:00.000Z')).toBe(true)
    expect(db.getUnseenReviewTaskIds()).toEqual([])
    expect(db.markAllReviewSeen()).toEqual([])
  })
})
