import { TaskStatus } from './constants'

/**
 * Review "seen" state, shared by main, desktop and mobile.
 *
 * Only tasks in `ready_for_review` have a seen state. `review_entered_at` is
 * set by the main process whenever a task moves INTO review; `review_seen_at`
 * is set when the user looks at the task (≥ REVIEW_SEEN_DWELL_MS) and cleared
 * by "Mark as unseen". A task is unseen until it has been seen at or after the
 * moment it last entered review.
 */
export interface ReviewSeenFields {
  status: string
  review_entered_at?: string | null
  review_seen_at?: string | null
}

/** How long a task must stay open (window focused) before it counts as seen. */
export const REVIEW_SEEN_DWELL_MS = 1000

export function isReviewUnseen(task: ReviewSeenFields): boolean {
  if (task.status !== TaskStatus.ReadyForReview) return false
  if (!task.review_seen_at) return true
  if (!task.review_entered_at) return false
  return task.review_seen_at < task.review_entered_at
}

/** A task in review that the user has already looked at. */
export function isReviewSeen(task: ReviewSeenFields): boolean {
  return task.status === TaskStatus.ReadyForReview && !isReviewUnseen(task)
}

/**
 * Tells the "open ≥ 1s marks seen" hooks when a task flipped from seen to
 * unseen while it stayed open in the same review round — i.e. the user chose
 * "Mark as unseen". Those hooks must not immediately mark it seen again; the
 * suppression lasts until a different task (or a new review round) is shown.
 */
export function createManualUnseenTracker(): {
  shouldSkip: (taskId: string | undefined, enteredAt: string | null, unseen: boolean) => boolean
} {
  let prev: { taskId: string | undefined; enteredAt: string | null; unseen: boolean } | null = null
  let suppressedKey: string | null = null
  return {
    shouldSkip(taskId, enteredAt, unseen) {
      const key = taskId ? `${taskId}|${enteredAt ?? ''}` : null
      if (prev && prev.taskId === taskId && prev.enteredAt === enteredAt && !prev.unseen && unseen) {
        suppressedKey = key
      } else if (suppressedKey !== key) {
        suppressedKey = null
      }
      prev = { taskId, enteredAt, unseen }
      return key !== null && suppressedKey === key
    }
  }
}
