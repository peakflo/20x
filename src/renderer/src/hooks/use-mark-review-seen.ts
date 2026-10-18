import { useEffect, useRef, type RefObject } from 'react'
import { useTaskStore } from '@/stores/task-store'
import { createManualUnseenTracker, isReviewUnseen, REVIEW_SEEN_DWELL_MS } from '@shared/review-seen'
import type { WorkfloTask } from '@/types'

function isElementShown(el: HTMLElement | null | undefined): boolean {
  if (document.visibilityState === 'hidden') return false
  if (!el) return true
  // The canvas stays mounted under `visibility: hidden` while another view is
  // open; a task panel there must not count as looked at.
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true })
  return true
}

/**
 * Marks a task in review as seen once it has been open for
 * REVIEW_SEEN_DWELL_MS while the window has focus. Skimming past a task with
 * the keyboard (selection moves on sooner) does not mark it, and neither does
 * a task left open in a background or blurred window. A task the user just
 * marked unseen while it is open stays unseen until another task is opened.
 */
export function useMarkReviewSeen(task: WorkfloTask | undefined, visibilityRef?: RefObject<HTMLElement | null>): void {
  const taskId = task?.id
  const enteredAt = task?.review_entered_at ?? null
  const unseen = task ? isReviewUnseen(task) : false
  const markReviewSeen = useTaskStore((s) => s.markReviewSeen)
  const suppressed = useRef(createManualUnseenTracker())

  useEffect(() => {
    if (suppressed.current.shouldSkip(taskId, enteredAt, unseen)) return
    if (!taskId || !unseen) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const arm = () => {
      clear()
      if (!document.hasFocus()) return
      timer = setTimeout(() => {
        timer = null
        if (!document.hasFocus()) return
        // Mounted but not on screen yet (hidden canvas): check again later.
        if (!isElementShown(visibilityRef?.current)) {
          arm()
          return
        }
        void markReviewSeen(taskId)
      }, REVIEW_SEEN_DWELL_MS)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') clear()
      else arm()
    }

    arm()
    window.addEventListener('focus', arm)
    window.addEventListener('blur', clear)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clear()
      window.removeEventListener('focus', arm)
      window.removeEventListener('blur', clear)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [taskId, enteredAt, unseen, markReviewSeen, visibilityRef])
}
