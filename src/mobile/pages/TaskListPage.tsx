import { Fragment, useState, useMemo, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isTaskClosed, TaskStatus } from '@shared/constants'
import { isReviewUnseen } from '@shared/review-seen'
import { useTaskStore, type Task } from '../stores/task-store'
import { useAgentStore, SessionStatus } from '../stores/agent-store'
import { TaskListItem } from '../components/TaskListItem'
import { isSnoozed } from '../lib/utils'
import type { Route } from '../App'

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: TaskStatus.AgentWorking, label: 'Working' },
  { value: TaskStatus.ModelError, label: 'Model Error' },
  { value: TaskStatus.ReadyForReview, label: 'Review' },
  { value: TaskStatus.NotStarted, label: 'Not Started' },
  { value: TaskStatus.Completed, label: 'Done' }
]

/** Filter value for the "Unseen · N" chip: tasks in review not opened yet. */
export const REVIEW_UNSEEN_FILTER = 'review_unseen'

function isUnseenReviewTask(task: Task): boolean {
  return isReviewUnseen(task) && !isSnoozed(task.snoozed_until)
}

export function TaskListPage({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const tasks = useTaskStore((s) => s.tasks)
  const isLoading = useTaskStore((s) => s.isLoading)
  const isSyncing = useTaskStore((s) => s.isSyncing)
  const syncAndFetch = useTaskStore((s) => s.syncAndFetch)
  const completedTotal = useTaskStore((s) => s.completedTotal)
  const completedLoaded = useTaskStore((s) => s.completedLoaded)
  const completedLoading = useTaskStore((s) => s.completedLoading)
  const loadMoreCompleted = useTaskStore((s) => s.loadMoreCompleted)
  const searchCompleted = useTaskStore((s) => s.searchCompleted)
  const markReviewSeen = useTaskStore((s) => s.markReviewSeen)
  const markReviewUnseen = useTaskStore((s) => s.markReviewUnseen)
  const markAllReviewSeen = useTaskStore((s) => s.markAllReviewSeen)
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null)
  // Only extract session statuses — avoids re-rendering on every streaming message
  const sessionStatuses = useAgentStore(useShallow((s) => {
    const result: Record<string, SessionStatus> = {}
    for (const [taskId, session] of s.sessions) {
      result[taskId] = session.status
    }
    return result
  }))
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [showCompleted, setShowCompleted] = useState(false)
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())

  // Re-evaluate snooze state every 60s so snoozed tasks appear when their time expires
  const [snoozeTick, setSnoozeTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setSnoozeTick((t) => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!search.trim() || (filter !== 'all' && filter !== TaskStatus.Completed)) return
    const id = setTimeout(() => { void searchCompleted(search) }, 250)
    return () => clearTimeout(id)
  }, [search, filter, searchCompleted])

  const toggleParentExpanded = (parentId: string) => {
    setExpandedParents(prev => {
      const next = new Set(prev)
      if (next.has(parentId)) next.delete(parentId)
      else next.add(parentId)
      return next
    })
  }

  // Build subtask lookup map — sorted by sort_order to preserve explicit sequence
  const subtasksByParent = useMemo(() => {
    const map = new Map<string, Task[]>()
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

  const unseenReviewCount = useMemo(() => tasks.filter(isUnseenReviewTask).length, [tasks, snoozeTick])
  const unseenOnly = filter === REVIEW_UNSEEN_FILTER

  // Flat list (subtasks included) for the unseen filter.
  const unseenTasks = useMemo(() => {
    if (!unseenOnly) return []
    const q = search.toLowerCase()
    return tasks.filter((t) => isUnseenReviewTask(t) && (!q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)))
  }, [tasks, unseenOnly, search, snoozeTick])

  const menuTask = menuTaskId ? tasks.find((t) => t.id === menuTaskId) : undefined
  const openReviewMenu = (task: Task) => (task.status === TaskStatus.ReadyForReview ? () => setMenuTaskId(task.id) : undefined)

  const { active, completed } = useMemo(() => {
    let filtered = tasks

    // Search
    if (search) {
      const q = search.toLowerCase()
      filtered = filtered.filter(
        (t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
      )
    }

    // Filter by status
    if (filter !== 'all' && filter !== REVIEW_UNSEEN_FILTER) {
      filtered = filtered.filter((t) => filter === TaskStatus.Completed ? isTaskClosed(t.status) : t.status === filter)
    }

    // Split into active vs completed (excluding snoozed, recurring templates, and subtasks)
    const active: Task[] = []
    const completed: Task[] = []

    for (const t of filtered) {
      // Skip subtasks from top-level grouping — they render under their parent
      if (t.parent_task_id) continue

      if (isTaskClosed(t.status)) {
        completed.push(t)
      } else if (!isSnoozed(t.snoozed_until) && !(t.is_recurring && !t.recurrence_parent_id)) {
        active.push(t)
      }
    }

    return { active, completed }
  }, [tasks, filter, search, snoozeTick])

  const completedCount = search ? completed.length : Math.max(completedTotal, completed.length)
  const hasMoreCompleted = completedLoaded < completedTotal
  const toggleCompleted = () => {
    const opening = !showCompleted
    setShowCompleted(opening)
    if (opening && !search && hasMoreCompleted && completedLoaded === 0) void loadMoreCompleted()
  }

  const renderTaskWithSubtasks = (task: Task) => {
    const subtasks = subtasksByParent.get(task.id)
    const hasSubtasks = subtasks && subtasks.length > 0

    // Tasks without subtasks render flat — no extra wrapper divs
    if (!hasSubtasks) {
      return (
        <TaskListItem
          key={task.id}
          task={task}
          onSelect={() => onNavigate({ page: 'detail', taskId: task.id })}
          sessionStatus={sessionStatuses[task.id]}
          onLongPress={openReviewMenu(task)}
        />
      )
    }

    const isExpanded = expandedParents.has(task.id)

    return (
      <div key={task.id}>
        <TaskListItem
          task={task}
          onSelect={() => onNavigate({ page: 'detail', taskId: task.id })}
          sessionStatus={sessionStatuses[task.id]}
          onLongPress={openReviewMenu(task)}
          subtaskCount={subtasks.length}
          isExpanded={isExpanded}
          onToggleExpand={() => toggleParentExpanded(task.id)}
        />
        {isExpanded && (
          <div className="ml-5 pl-2 border-l border-border/30">
            {subtasks.map((subtask) => (
              <TaskListItem
                key={subtask.id}
                task={subtask}
                onSelect={() => onNavigate({ page: 'detail', taskId: subtask.id })}
                sessionStatus={sessionStatuses[subtask.id]}
                onLongPress={openReviewMenu(subtask)}
                isSubtask
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="relative flex flex-col h-full">
      {/* Header */}
      <div className="glass-bar pointer-events-none relative z-10 shrink-0 -mb-[92px] px-4 pt-3 pb-2">
        <div className="pointer-events-auto flex items-center justify-between mb-2">
          <h1 className="text-lg font-semibold">Tasks</h1>
          <div className="flex items-center gap-1">
            <button
              onClick={() => syncAndFetch()}
              disabled={isLoading || isSyncing}
              className="glass-action !h-[44px] !w-[44px] disabled:opacity-40"
              aria-label="Sync and refresh tasks"
              title="Sync all sources"
            >
              <svg className={`w-4 h-4 text-foreground ${isSyncing ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
              </svg>
            </button>
            <button
              onClick={() => onNavigate({ page: 'settings' })}
              className="glass-action !h-[44px] !w-[44px]"
              aria-label="Settings"
              title="Settings"
            >
              <svg className="w-4 h-4 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button
              onClick={() => onNavigate({ page: 'create' })}
              className="glass-action !h-[44px] !w-[44px]"
              aria-label="Create task"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks..."
            className="glass-control pointer-events-auto block w-full px-5 h-[44px] text-sm text-foreground placeholder:text-[var(--glass-placeholder)] focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring/30"
          />
          {/* Cover the gap between the two glass controls as rows pass under them. */}
          <div aria-hidden="true" className="pointer-events-none absolute top-full -left-4 -right-4 h-[9px] bg-background" />
        </div>

        {/* Filter pills */}
        <div className="glass-filter-rail pointer-events-auto flex gap-1.5 overflow-x-auto rounded-2xl p-1">
          {FILTER_OPTIONS.map((opt) => (
            <Fragment key={opt.value}>
              <button
                onClick={() => setFilter(opt.value)}
                className={`glass-filter-block shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors min-h-[28px] ${
                  filter === opt.value
                    ? 'glass-filter-active'
                    : 'text-muted-foreground active:bg-accent'
                }`}
              >
                {opt.label}
              </button>
              {opt.value === TaskStatus.ReadyForReview && (
                <button
                  onClick={() => setFilter(REVIEW_UNSEEN_FILTER)}
                  aria-pressed={unseenOnly}
                  className={`glass-filter-block shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors min-h-[28px] ${
                    unseenOnly ? 'glass-filter-active' : 'text-muted-foreground active:bg-accent'
                  }`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-pink-400" />
                  Unseen · <span className="tabular-nums">{unseenReviewCount}</span>
                </button>
              )}
            </Fragment>
          ))}
        </div>
      </div>

      {/* Task list (relative for FAB positioning) */}
      <div className="flex-1 overflow-y-auto relative pt-[98px]">
        {unseenOnly ? (
          unseenTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <svg className="w-12 h-12 mb-3 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" />
              </svg>
              <p className="text-sm">All caught up ✓</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 px-4 pt-1 pb-2 text-xs text-muted-foreground">
                <span className="tabular-nums">{unseenTasks.length} unseen in review</span>
                <button
                  onClick={() => void markAllReviewSeen()}
                  className="ml-auto text-xs text-primary active:opacity-60"
                >
                  Mark all seen
                </button>
              </div>
              {unseenTasks.map((task) => (
                <TaskListItem
                  key={task.id}
                  task={task}
                  onSelect={() => onNavigate({ page: 'detail', taskId: task.id })}
                  sessionStatus={sessionStatuses[task.id]}
                  onLongPress={openReviewMenu(task)}
                />
              ))}
            </>
          )
        ) : active.length === 0 && completedCount === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <svg className="w-12 h-12 mb-3 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" />
            </svg>
            <p className="text-sm">No tasks found</p>
          </div>
        ) : (
          <>
            {active.map(renderTaskWithSubtasks)}

            {completedCount > 0 && (
              <>
                <button
                  onClick={toggleCompleted}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground active:bg-accent/30 border-b border-border/30"
                >
                  <span className="text-[10px]">{showCompleted ? '\u25BC' : '\u25B6'}</span>
                  <span>Closed ({completedCount})</span>
                </button>
                {showCompleted && completed.map(renderTaskWithSubtasks)}
                {showCompleted && !search && (hasMoreCompleted || completedLoading) && (
                  <button
                    onClick={() => void loadMoreCompleted()}
                    disabled={completedLoading}
                    className="w-full px-4 py-3 text-xs text-muted-foreground active:bg-accent/30 disabled:opacity-60"
                  >
                    {completedLoading ? 'Loading…' : 'Show more'}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Long-press menu on a review task: flip its seen state */}
      {menuTask && menuTask.status === TaskStatus.ReadyForReview && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={() => setMenuTaskId(null)}>
          <div
            role="menu"
            className="glass-popover w-full rounded-t-2xl border p-2 pb-[max(env(safe-area-inset-bottom),8px)]"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="truncate px-3 pt-1 pb-2 text-xs text-muted-foreground">{menuTask.title}</p>
            <button
              role="menuitem"
              onClick={() => {
                if (isReviewUnseen(menuTask)) void markReviewSeen(menuTask.id)
                else void markReviewUnseen(menuTask.id)
                setMenuTaskId(null)
              }}
              className="w-full rounded-xl px-3 py-3 text-left text-sm active:bg-accent"
            >
              {isReviewUnseen(menuTask) ? 'Mark as seen' : 'Mark as unseen'}
            </button>
            <button
              onClick={() => setMenuTaskId(null)}
              className="w-full rounded-xl px-3 py-3 text-left text-sm text-muted-foreground active:bg-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
