import { useEffect, useRef } from 'react'
import { isOverdue, isDueSoon } from '@/lib/utils'
import { notificationApi, onOverdueCheck } from '@/lib/ipc-client'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

export function useOverdueNotifications(tasks: WorkfloTask[]): void {
  const notifiedRef = useRef<Set<string>>(new Set())
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  useEffect(() => {
    const cleanup = onOverdueCheck(() => {
      const current = tasksRef.current
      const notified = notifiedRef.current

      // Remove completed tasks from notified set
      for (const id of notified) {
        const task = current.find((t) => t.id === id)
        if (!task || task.status === TaskStatus.Completed) {
          notified.delete(id)
        }
      }

      for (const task of current) {
        if (task.status === TaskStatus.Completed) continue
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
