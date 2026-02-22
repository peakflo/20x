import { useEffect, useMemo } from 'react'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask, TaskPriority } from '@/types'

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
}

const STATUS_ORDER: Record<TaskStatus, number> = {
  [TaskStatus.AgentWorking]: 0,
  [TaskStatus.AgentLearning]: 1,
  [TaskStatus.Triaging]: 2,
  [TaskStatus.ReadyForReview]: 3,
  [TaskStatus.NotStarted]: 4,
  [TaskStatus.Completed]: 5
}

export function useTasks() {
  const { tasks, selectedTaskId, isLoading, error, fetchTasks, createTask, updateTask, deleteTask, selectTask } =
    useTaskStore()
  const { statusFilter, priorityFilter, sourceFilter, sortField, sortDirection, searchQuery } = useUIStore()

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
          t.labels.some((l) => l.toLowerCase().includes(q))
      )
    }

    // Sort
    result.sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'priority':
          cmp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
          break
        case 'due_date': {
          const aDate = a.due_date ? new Date(a.due_date).getTime() : Infinity
          const bDate = b.due_date ? new Date(b.due_date).getTime() : Infinity
          cmp = aDate - bDate
          break
        }
        case 'status':
          cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
          break
        case 'title':
          cmp = a.title.localeCompare(b.title)
          break
        case 'updated_at':
          cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
          break
        case 'created_at':
        default:
          cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          break
      }
      return sortDirection === 'desc' ? -cmp : cmp
    })

    return result
  }, [tasks, sourceFilter, statusFilter, priorityFilter, searchQuery, sortField, sortDirection])

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
