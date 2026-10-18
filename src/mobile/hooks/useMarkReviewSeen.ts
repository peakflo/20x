import { useEffect, useRef } from 'react'
import { createManualUnseenTracker, isReviewUnseen, REVIEW_SEEN_DWELL_MS } from '@shared/review-seen'
import { useTaskStore, type Task } from '../stores/task-store'

/**
 * Marks a task in review as seen once its detail page has been open for
 * REVIEW_SEEN_DWELL_MS while the page is visible. Mirrors the desktop
 * `useMarkReviewSeen` hook; the state lives in the desktop database.
 */
export function useMarkReviewSeen(task: Task | undefined): void {
  const taskId = task?.id
  const enteredAt = task?.review_entered_at ?? null
  const unseen = task ? isReviewUnseen(task) : false
  const markReviewSeen = useTaskStore((s) => s.markReviewSeen)
  const suppressed = useRef(createManualUnseenTracker())

  useEffect(() => {
    // Marked unseen (e.g. from desktop) while open here: leave it unseen.
    if (suppressed.current.shouldSkip(taskId, enteredAt, unseen)) return
    if (!taskId || !unseen) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const arm = () => {
      clear()
      if (document.visibilityState === 'hidden') return
      timer = setTimeout(() => {
        timer = null
        if (document.visibilityState !== 'hidden') void markReviewSeen(taskId)
      }, REVIEW_SEEN_DWELL_MS)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') clear()
      else arm()
    }
    arm()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clear()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [taskId, enteredAt, unseen, markReviewSeen])
}
