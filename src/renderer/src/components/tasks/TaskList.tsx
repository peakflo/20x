import { useState, useMemo, useRef, useCallback, useLayoutEffect, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Inbox, ChevronRight } from 'lucide-react'
import { TaskListItem } from './TaskListItem'
import { EmptyState } from '@/components/ui/EmptyState'
import { isSnoozed } from '@/lib/utils'
import { useSnoozeTick } from '@/hooks/use-snooze-tick'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

// Below this many visible rows the plain list is cheap and keeps the original
// markup; above it, only the rows in (or near) the viewport are mounted.
export const TASK_LIST_VIRTUALIZE_THRESHOLD = 80

type Section = 'hidden' | 'recurring' | 'completed'

type Row =
  | { kind: 'task'; key: string; task: WorkfloTask; subtaskCount?: number; isExpanded?: boolean }
  | { kind: 'subtask'; key: string; task: WorkfloTask }
  | { kind: 'header'; key: string; section: Section; label: string; count: number; open: boolean }

interface TaskListProps {
  tasks: WorkfloTask[]
  selectedTaskId: string | null
  onSelectTask: (id: string) => void
}

export function TaskList({ tasks, selectedTaskId, onSelectTask }: TaskListProps) {
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

  const rows = useMemo(() => {
    const out: Row[] = []
    const pushTasks = (list: WorkfloTask[]) => {
      for (const task of list) {
        const subtasks = subtasksByParent.get(task.id)
        if (!subtasks || subtasks.length === 0) {
          out.push({ kind: 'task', key: task.id, task })
          continue
        }
        const isExpanded = expandedParents.has(task.id)
        out.push({ kind: 'task', key: task.id, task, subtaskCount: subtasks.length, isExpanded })
        if (isExpanded) for (const subtask of subtasks) out.push({ kind: 'subtask', key: subtask.id, task: subtask })
      }
    }
    const pushSection = (section: Section, label: string, list: WorkfloTask[], open: boolean) => {
      if (list.length === 0) return
      out.push({ kind: 'header', key: `section:${section}`, section, label, count: list.length, open })
      if (open) pushTasks(list)
    }
    pushTasks(activeTasks)
    pushSection('hidden', 'Hidden', snoozedTasks, hiddenOpen)
    pushSection('recurring', 'Recurring', recurringTasks, recurringOpen)
    pushSection('completed', 'Completed', completedTasks, completedOpen)
    return out
  }, [activeTasks, snoozedTasks, recurringTasks, completedTasks, subtasksByParent, expandedParents, hiddenOpen, recurringOpen, completedOpen])

  const virtualize = rows.length > TASK_LIST_VIRTUALIZE_THRESHOLD
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)

  useLayoutEffect(() => {
    if (!virtualize) return
    const list = listRef.current
    let parent = list?.parentElement ?? null
    while (parent) {
      const overflowY = getComputedStyle(parent).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll') break
      parent = parent.parentElement
    }
    setScrollElement(parent)
    if (list && parent) {
      setScrollMargin(list.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop)
    }
  }, [virtualize])

  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollElement,
    estimateSize: (index) => (rows[index]?.kind === 'header' ? 34 : 38),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 10,
    scrollMargin
  })

  if (tasks.length === 0) {
    return <EmptyState icon={Inbox} title="No tasks" description="Create a task to get started" className="py-10" />
  }

  const toggleSection = (section: Section) => {
    if (section === 'hidden') setHiddenOpen((v) => !v)
    else if (section === 'recurring') setRecurringOpen((v) => !v)
    else setCompletedOpen((v) => !v)
  }

  const renderSectionHeader = (section: Section, label: string, count: number, open: boolean): ReactNode => (
    <button
      onClick={() => toggleSection(section)}
      className="flex w-full items-center gap-1.5 px-3 py-2 mt-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
    >
      <ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
      {label}
      <span className="ml-auto tabular-nums">{count}</span>
    </button>
  )

  if (virtualize) {
    return (
      <div ref={listRef} className="relative px-2 pb-2" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (!row) return null
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-2 right-2 top-0"
              style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
            >
              {row.kind === 'header' ? (
                renderSectionHeader(row.section, row.label, row.count, row.open)
              ) : row.kind === 'subtask' ? (
                <div className="ml-5 pl-2 border-l border-border/30">
                  <TaskListItem
                    task={row.task}
                    isSelected={row.task.id === selectedTaskId}
                    onSelect={getSelectHandler(row.task.id)}
                    isSubtask
                  />
                </div>
              ) : (
                <div className="pb-0.5">
                  <TaskListItem
                    task={row.task}
                    isSelected={row.task.id === selectedTaskId}
                    onSelect={getSelectHandler(row.task.id)}
                    subtaskCount={row.subtaskCount}
                    isExpanded={row.isExpanded}
                    onToggleExpand={row.subtaskCount ? getToggleHandler(row.task.id) : undefined}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
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
    <div ref={listRef} className="flex flex-col gap-0.5 px-2 pb-2">
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

      {completedTasks.length > 0 && (
        <>
          <button
            onClick={() => setCompletedOpen(!completedOpen)}
            className="flex items-center gap-1.5 px-3 py-2 mt-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${completedOpen ? 'rotate-90' : ''}`} />
            Completed
            <span className="ml-auto tabular-nums">{completedTasks.length}</span>
          </button>
          {completedOpen && completedTasks.map(renderTaskWithSubtasks)}
        </>
      )}
    </div>
  )
}
