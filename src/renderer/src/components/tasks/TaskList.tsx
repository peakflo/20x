import { useState, useMemo, useRef, useCallback } from 'react'
import { Inbox, ChevronRight, Loader2 } from 'lucide-react'
import { TaskListItem } from './TaskListItem'
import { EmptyState } from '@/components/ui/EmptyState'
import { isSnoozed } from '@/lib/utils'
import { useSnoozeTick } from '@/hooks/use-snooze-tick'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'
import { COMPLETED_PAGE_SIZE } from '@/stores/task-store'

interface TaskListProps {
  tasks: WorkfloTask[]
  selectedTaskId: string | null
  onSelectTask: (id: string) => void
  /**
   * Completed history is paged in from the database. When set, this is the
   * total shown in the Completed header (the list itself only holds the
   * completed tasks loaded so far).
   */
  completedTotal?: number
  /** More completed tasks exist in the database than are loaded. */
  hasMoreCompleted?: boolean
  completedLoading?: boolean
  /** Load the next page of completed tasks. */
  onLoadMoreCompleted?: () => void
}

export function TaskList({
  tasks,
  selectedTaskId,
  onSelectTask,
  completedTotal,
  hasMoreCompleted = false,
  completedLoading = false,
  onLoadMoreCompleted
}: TaskListProps) {
  const [completedOpen, setCompletedOpen] = useState(false)
  const [hiddenOpen, setHiddenOpen] = useState(false)
  const [recurringOpen, setRecurringOpen] = useState(false)
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())

  // Periodically re-evaluate snooze state so tasks move from Hidden → Active
  // when their snooze time expires (not only when the tasks array changes)
  const snoozeTick = useSnoozeTick(tasks)

  const toggleParentExpanded = useCallback((parentId: string) => {
    setExpandedParents(prev => {
      const next = new Set(prev)
      if (next.has(parentId)) next.delete(parentId)
      else next.add(parentId)
      return next
    })
  }, [])

  // Stable per-task callbacks so the memoized TaskListItem rows only re-render
  // when their own task (or selection) changes. Inline arrows defeated memo and
  // re-rendered every row on every task-store update.
  const onSelectRef = useRef(onSelectTask)
  onSelectRef.current = onSelectTask
  const selectHandlers = useRef(new Map<string, () => void>())
  const toggleHandlers = useRef(new Map<string, () => void>())
  const getSelectHandler = (id: string): (() => void) => {
    let handler = selectHandlers.current.get(id)
    if (!handler) {
      handler = () => onSelectRef.current(id)
      selectHandlers.current.set(id, handler)
    }
    return handler
  }
  const getToggleHandler = (id: string): (() => void) => {
    let handler = toggleHandlers.current.get(id)
    if (!handler) {
      handler = () => toggleParentExpanded(id)
      toggleHandlers.current.set(id, handler)
    }
    return handler
  }

  // Build subtask lookup map — sorted by sort_order to preserve explicit sequence
  const subtasksByParent = useMemo(() => {
    const map = new Map<string, WorkfloTask[]>()
    for (const task of tasks) {
      if (task.parent_task_id) {
        const existing = map.get(task.parent_task_id) || []
        existing.push(task)
        map.set(task.parent_task_id, existing)
      }
    }
    // Sort subtasks by sort_order ascending (with created_at as tiebreaker)
    for (const [, subtasks] of map) {
      subtasks.sort((a, b) => {
        const orderDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0)
        if (orderDiff !== 0) return orderDiff
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      })
    }
    return map
  }, [tasks])

  const { activeTasks, snoozedTasks, recurringTasks, completedTasks } = useMemo(() => {
    const active: WorkfloTask[] = []
    const snoozed: WorkfloTask[] = []
    const recurring: WorkfloTask[] = []
    const completed: WorkfloTask[] = []
    for (const task of tasks) {
      // Skip subtasks from top-level grouping — they render under their parent
      if (task.parent_task_id) continue

      // Template tasks only (not instances)
      if (task.is_recurring && !task.recurrence_parent_id) {
        recurring.push(task)
      } else if (task.status === TaskStatus.Completed) {
        completed.push(task)
      } else if (isSnoozed(task.snoozed_until)) {
        snoozed.push(task)
      } else {
        active.push(task)
      }
    }
    return { activeTasks: active, snoozedTasks: snoozed, recurringTasks: recurring, completedTasks: completed }
  }, [tasks, snoozeTick])

  const completedCount = completedTotal ?? completedTasks.length
  const toggleCompleted = () => {
    const opening = !completedOpen
    setCompletedOpen(opening)
    // Opening with less than one page loaded (e.g. only completed parents of
    // open subtasks are present) fetches the next page of completed history.
    if (opening && hasMoreCompleted && completedTasks.length < COMPLETED_PAGE_SIZE) onLoadMoreCompleted?.()
  }

  if (tasks.length === 0 && completedCount === 0) {
    return <EmptyState icon={Inbox} title="No tasks" description="Create a task to get started" className="py-10" />
  }

  const renderTaskWithSubtasks = (task: WorkfloTask) => {
    const subtasks = subtasksByParent.get(task.id)
    const hasSubtasks = subtasks && subtasks.length > 0

    if (!hasSubtasks) {
      return (
        <TaskListItem
          key={task.id}
          task={task}
          isSelected={task.id === selectedTaskId}
          onSelect={getSelectHandler(task.id)}
        />
      )
    }

    const isExpanded = expandedParents.has(task.id)

    return (
      <div key={task.id}>
        <TaskListItem
          task={task}
          isSelected={task.id === selectedTaskId}
          onSelect={getSelectHandler(task.id)}
          subtaskCount={subtasks.length}
          isExpanded={isExpanded}
          onToggleExpand={getToggleHandler(task.id)}
        />
        {isExpanded && (
          <div className="ml-5 pl-2 border-l border-border/30">
            {subtasks.map((subtask) => (
              <TaskListItem
                key={subtask.id}
                task={subtask}
                isSelected={subtask.id === selectedTaskId}
                onSelect={getSelectHandler(subtask.id)}
                isSubtask
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5 px-2 pb-2">
      {activeTasks.map(renderTaskWithSubtasks)}

      {snoozedTasks.length > 0 && (
        <>
          <button
            onClick={() => setHiddenOpen(!hiddenOpen)}
            className="flex items-center gap-1.5 px-3 py-2 mt-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${hiddenOpen ? 'rotate-90' : ''}`} />
            Hidden
            <span className="ml-auto tabular-nums">{snoozedTasks.length}</span>
          </button>
          {hiddenOpen && snoozedTasks.map(renderTaskWithSubtasks)}
        </>
      )}

      {recurringTasks.length > 0 && (
        <>
          <button
            onClick={() => setRecurringOpen(!recurringOpen)}
            className="flex items-center gap-1.5 px-3 py-2 mt-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${recurringOpen ? 'rotate-90' : ''}`} />
            Recurring
            <span className="ml-auto tabular-nums">{recurringTasks.length}</span>
          </button>
          {recurringOpen && recurringTasks.map(renderTaskWithSubtasks)}
        </>
      )}

      {completedCount > 0 && (
        <>
          <button
            onClick={toggleCompleted}
            className="flex items-center gap-1.5 px-3 py-2 mt-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${completedOpen ? 'rotate-90' : ''}`} />
            Completed
            <span className="ml-auto tabular-nums">{completedCount}</span>
          </button>
          {completedOpen && completedTasks.map(renderTaskWithSubtasks)}
          {completedOpen && (hasMoreCompleted || completedLoading) && (
            <button
              onClick={() => onLoadMoreCompleted?.()}
              disabled={completedLoading}
              className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer disabled:cursor-default"
            >
              {completedLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {completedLoading ? 'Loading…' : 'Show more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
