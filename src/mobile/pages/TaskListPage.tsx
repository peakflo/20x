import { useState, useMemo, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { TaskStatus } from '@shared/constants'
import { useTaskStore, type Task } from '../stores/task-store'
import { useAgentStore, SessionStatus } from '../stores/agent-store'
import { TaskListItem } from '../components/TaskListItem'
import { isSnoozed } from '../lib/utils'
import type { Route } from '../App'

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: TaskStatus.AgentWorking, label: 'Working' },
  { value: TaskStatus.ReadyForReview, label: 'Review' },
  { value: TaskStatus.NotStarted, label: 'Not Started' },
  { value: TaskStatus.Completed, label: 'Done' }
]

export function TaskListPage({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const tasks = useTaskStore((s) => s.tasks)
  const isLoading = useTaskStore((s) => s.isLoading)
  const isSyncing = useTaskStore((s) => s.isSyncing)
  const syncAndFetch = useTaskStore((s) => s.syncAndFetch)
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
    if (filter !== 'all') {
      filtered = filtered.filter((t) => t.status === filter)
    }

    // Split into active vs completed (excluding snoozed, recurring templates, and subtasks)
    const active: Task[] = []
    const completed: Task[] = []

    for (const t of filtered) {
      // Skip subtasks from top-level grouping — they render under their parent
      if (t.parent_task_id) continue

      if (t.status === TaskStatus.Completed) {
        completed.push(t)
      } else if (!isSnoozed(t.snoozed_until) && !(t.is_recurring && !t.recurrence_parent_id)) {
        active.push(t)
      }
    }

    return { active, completed }
  }, [tasks, filter, search, snoozeTick])

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
                isSubtask
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-4 pt-3 pb-2 border-b border-border/30">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-lg font-semibold">Tasks</h1>
          <button
            onClick={() => syncAndFetch()}
            disabled={isLoading || isSyncing}
            className="p-2 active:opacity-60 hover:bg-accent rounded-md transition-colors disabled:opacity-40"
            aria-label="Sync and refresh tasks"
            title="Sync all sources"
          >
            <svg className={`w-4 h-4 text-foreground ${isSyncing ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tasks..."
          className="w-full bg-transparent border border-input rounded-md px-3 py-1 h-9 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring/30 mb-2"
        />

        {/* Filter pills */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
              className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors min-h-[28px] ${
                filter === opt.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground active:bg-accent'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Task list (relative for FAB positioning) */}
      <div className="flex-1 overflow-y-auto relative">
        {active.length === 0 && completed.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <svg className="w-12 h-12 mb-3 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" />
            </svg>
            <p className="text-sm">No tasks found</p>
          </div>
        ) : (
          <>
            {active.map(renderTaskWithSubtasks)}

            {completed.length > 0 && (
              <>
                <button
                  onClick={() => setShowCompleted(!showCompleted)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground active:bg-accent/30 border-b border-border/30"
                >
                  <span className="text-[10px]">{showCompleted ? '\u25BC' : '\u25B6'}</span>
                  <span>Completed ({completed.length})</span>
                </button>
                {showCompleted && completed.map(renderTaskWithSubtasks)}
              </>
            )}
          </>
        )}

        {/* FAB — Create Task */}
        <button
          onClick={() => onNavigate({ page: 'create' })}
          className="sticky bottom-4 left-full -translate-x-4 ml-auto w-12 h-12 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center active:scale-95 transition-transform"
          aria-label="Create task"
        >
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14"/><path d="M12 5v14"/>
          </svg>
        </button>
      </div>
    </div>
  )
}
