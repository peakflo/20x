import { useEffect, useRef } from 'react'
import { isOverdue, isDueSoon, isSnoozed } from '@/lib/utils'
import { notificationApi, onOverdueCheck } from '@/lib/ipc-client'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

export function useOverdueNotifications(tasks: WorkfloTask[]): void {
  const notifiedRef = useRef<Set<string>>(new Set())
  const snoozeNotifiedRef = useRef<Set<string>>(new Set())
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  useEffect(() => {
    const cleanup = onOverdueCheck(() => {
      const current = tasksRef.current
      const notified = notifiedRef.current
      const snoozeNotified = snoozeNotifiedRef.current

      // Remove completed tasks from notified sets
      for (const id of notified) {
        const task = current.find((t) => t.id === id)
        if (!task || task.status === TaskStatus.Completed) {
          notified.delete(id)
        }
      }
      for (const id of snoozeNotified) {
        const task = current.find((t) => t.id === id)
        if (!task || task.status === TaskStatus.Completed) {
          snoozeNotified.delete(id)
        }
      }

      for (const task of current) {
        if (task.status === TaskStatus.Completed) continue

        // Snooze wake-up: snoozed_until is in the past → task just reappeared
        if (task.snoozed_until && !isSnoozed(task.snoozed_until) && !snoozeNotified.has(task.id)) {
          snoozeNotified.add(task.id)
          notificationApi.show('Task Reminder', `"${task.title}" is back from snooze`)
        }

        // Skip overdue/due-soon for currently snoozed tasks
        if (isSnoozed(task.snoozed_until)) continue
        if (notified.has(task.id)) continue

        if (isOverdue(task.due_date)) {
          notified.add(task.id)
          notificationApi.show('Task Overdue', `"${task.title}" is past due`)
        } else if (isDueSoon(task.due_date)) {
          notified.add(task.id)
          notificationApi.show('Task Due Soon', `"${task.title}" is due within 24 hours`)
        }
      }
    })

    return cleanup
  }, [])
}
