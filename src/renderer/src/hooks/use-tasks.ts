import { useEffect, useMemo } from 'react'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask, TaskPriority } from '@/types'
import type { SortField, SortDirection } from '@/stores/ui-store'
import { isSnoozed } from '@/lib/utils'
import { isReviewUnseen } from '@shared/review-seen'

/**
 * A task that counts toward "Review · Unseen": in review, not yet looked at,
 * and not hidden by a snooze.
 */
export function isUnseenReviewTask(task: WorkfloTask): boolean {
  return isReviewUnseen(task) && !isSnoozed(task.snoozed_until)
}

export function countUnseenReviewTasks(tasks: WorkfloTask[]): number {
  let count = 0
  for (const task of tasks) if (isUnseenReviewTask(task)) count++
  return count
}

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0
}

const STATUS_ORDER: Record<TaskStatus, number> = {
  [TaskStatus.ModelError]: 6,
  [TaskStatus.AgentWorking]: 5,
  [TaskStatus.AgentLearning]: 4,
  [TaskStatus.Triaging]: 3,
  [TaskStatus.ReadyForReview]: 2,
  [TaskStatus.NotStarted]: 1,
  [TaskStatus.Completed]: 0,
  [TaskStatus.Cancelled]: 0,
  [TaskStatus.Expired]: 0
}

/**
 * Sort `tasks` in place. Date fields are parsed once per task per sort
 * (decorate-sort-undecorate) instead of twice per comparison: with 2000 tasks
 * that is ~2k parses instead of ~40k.
 */
export function sortTasks(tasks: WorkfloTask[], sortField: SortField, sortDirection: SortDirection): WorkfloTask[] {
  const sign = sortDirection === 'desc' ? -1 : 1
  const dateField = sortField === 'due_date' || sortField === 'updated_at'
    ? sortField
    : sortField === 'priority' || sortField === 'status' || sortField === 'title'
      ? null
      : 'created_at'
  if (dateField) {
    // Same keys as before (a missing due date is Infinity); Array#sort treats
    // a NaN result as 0, so `sign * NaN` keeps the old tie behaviour.
    const keyed = tasks.map((task) => {
      const value = task[dateField]
      const key = dateField === 'due_date' && !value ? Infinity : new Date(value as string).getTime()
      return { task, key }
    })
    keyed.sort((a, b) => sign * (a.key - b.key))
    for (let i = 0; i < keyed.length; i++) tasks[i] = keyed[i].task
    return tasks
  }
  return tasks.sort((a, b) => {
    let cmp = 0
    if (sortField === 'priority') cmp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    else if (sortField === 'status') cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    else cmp = a.title.localeCompare(b.title)
    return sign * cmp
  })
}

export function useTasks() {
  // Use individual selectors to avoid re-renders from unrelated store changes
  const tasks = useTaskStore((s) => s.tasks)
  const selectedTaskId = useTaskStore((s) => s.selectedTaskId)
  const isLoading = useTaskStore((s) => s.isLoading)
  const error = useTaskStore((s) => s.error)
  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const createTask = useTaskStore((s) => s.createTask)
  const updateTask = useTaskStore((s) => s.updateTask)
  const deleteTask = useTaskStore((s) => s.deleteTask)
  const selectTask = useTaskStore((s) => s.selectTask)

  const statusFilter = useUIStore((s) => s.statusFilter)
  const priorityFilter = useUIStore((s) => s.priorityFilter)
  const sourceFilter = useUIStore((s) => s.sourceFilter)
  const sortField = useUIStore((s) => s.sortField)
  const sortDirection = useUIStore((s) => s.sortDirection)
  const searchQuery = useUIStore((s) => s.searchQuery)
  const reviewUnseenOnly = useUIStore((s) => s.reviewUnseenOnly)
  // Only matters for the unseen filter; keeps selection changes from
  // re-sorting the list otherwise.
  const stickyReviewTaskId = reviewUnseenOnly ? selectedTaskId : null

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const filteredTasks = useMemo(() => {
    let result = [...tasks]

    // Source filter
    if (sourceFilter !== 'all') {
      if (sourceFilter === 'local') {
        result = result.filter((t) => !t.source_id)
      } else {
        result = result.filter((t) => t.source_id === sourceFilter)
      }
    }

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter((t) => t.status === statusFilter)
    }

    // Review · Unseen. The open task stays listed after it turns seen, so the
    // row does not vanish while it is being read; it drops out on the next
    // selection.
    if (reviewUnseenOnly) {
      result = result.filter((t) => isUnseenReviewTask(t) || (t.id === stickyReviewTaskId && t.status === TaskStatus.ReadyForReview))
    }

    // Priority filter
    if (priorityFilter !== 'all') {
      result = result.filter((t) => t.priority === priorityFilter)
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          (Array.isArray(t.labels) && t.labels.some((l) => l.toLowerCase().includes(q)))
      )
    }

    return sortTasks(result, sortField, sortDirection)
  }, [tasks, sourceFilter, statusFilter, priorityFilter, searchQuery, sortField, sortDirection, reviewUnseenOnly, stickyReviewTaskId])

  const selectedTask: WorkfloTask | undefined = useMemo(
    () => (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : undefined),
    [tasks, selectedTaskId]
  )

  return {
    tasks: filteredTasks,
    allTasks: tasks,
    selectedTask,
    isLoading,
    error,
    createTask,
    updateTask,
    deleteTask,
    selectTask
  }
}
