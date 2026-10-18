import { describe, it, expect } from 'vitest'
import { TaskStatus } from './constants'
import { createManualUnseenTracker, isReviewSeen, isReviewUnseen } from './review-seen'

describe('isReviewUnseen', () => {
  const entered = '2026-10-18T10:00:00.000Z'

  it('is false for tasks outside review', () => {
    expect(isReviewUnseen({ status: TaskStatus.AgentWorking, review_entered_at: entered, review_seen_at: null })).toBe(false)
    expect(isReviewSeen({ status: TaskStatus.AgentWorking, review_entered_at: entered, review_seen_at: null })).toBe(false)
  })

  it('is true for a review task that was never seen', () => {
    expect(isReviewUnseen({ status: TaskStatus.ReadyForReview, review_entered_at: entered, review_seen_at: null })).toBe(true)
    expect(isReviewUnseen({ status: TaskStatus.ReadyForReview })).toBe(true)
  })

  it('is true when the task re-entered review after it was seen', () => {
    expect(isReviewUnseen({ status: TaskStatus.ReadyForReview, review_entered_at: entered, review_seen_at: '2026-10-18T09:00:00.000Z' })).toBe(true)
  })

  it('is false once seen at or after entering review', () => {
    expect(isReviewUnseen({ status: TaskStatus.ReadyForReview, review_entered_at: entered, review_seen_at: entered })).toBe(false)
    expect(isReviewUnseen({ status: TaskStatus.ReadyForReview, review_entered_at: entered, review_seen_at: '2026-10-18T11:00:00.000Z' })).toBe(false)
    expect(isReviewSeen({ status: TaskStatus.ReadyForReview, review_entered_at: entered, review_seen_at: entered })).toBe(true)
  })

  it('treats a seen task with no entered time as seen', () => {
    expect(isReviewUnseen({ status: TaskStatus.ReadyForReview, review_entered_at: null, review_seen_at: entered })).toBe(false)
  })
})

describe('createManualUnseenTracker', () => {
  it('skips re-marking a task the user marked unseen while it is open', () => {
    const tracker = createManualUnseenTracker()
    expect(tracker.shouldSkip('a', 't1', true)).toBe(false) // opened unseen → arm
    expect(tracker.shouldSkip('a', 't1', false)).toBe(false) // marked seen
    expect(tracker.shouldSkip('a', 't1', true)).toBe(true) // user marked unseen
    expect(tracker.shouldSkip('a', 't1', true)).toBe(true) // re-run (strict mode)
    expect(tracker.shouldSkip('b', 't2', true)).toBe(false) // another task
    expect(tracker.shouldSkip('a', 't1', true)).toBe(false) // back to it → normal
  })

  it('does not skip when the task enters a new review round', () => {
    const tracker = createManualUnseenTracker()
    tracker.shouldSkip('a', 't1', false)
    expect(tracker.shouldSkip('a', 't2', true)).toBe(false)
  })
})
