import { useState, useMemo } from 'react'
import { TaskStatus } from '@shared/constants'
import { useTaskStore, type Task } from '../stores/task-store'
import { useAgentStore } from '../stores/agent-store'
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
  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const sessions = useAgentStore((s) => s.sessions)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [showCompleted, setShowCompleted] = useState(false)

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

    // Split into active vs completed (excluding snoozed and recurring templates)
    const active: Task[] = []
    const completed: Task[] = []

    for (const t of filtered) {
      if (t.status === TaskStatus.Completed) {
        completed.push(t)
      } else if (!isSnoozed(t.snoozed_until) && !(t.is_recurring && !t.recurrence_parent_id)) {
        active.push(t)
      }
    }

    return { active, completed }
  }, [tasks, filter, search])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-4 pt-3 pb-2 border-b border-border/30">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-lg font-semibold">Tasks</h1>
          <button onClick={() => fetchTasks()} disabled={isLoading} className="text-xs text-primary active:opacity-60">
            {isLoading ? 'Loading...' : 'Refresh'}
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

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        {active.length === 0 && completed.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <svg className="w-12 h-12 mb-3 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" />
            </svg>
            <p className="text-sm">No tasks found</p>
          </div>
        ) : (
          <>
            {active.map((task) => (
              <TaskListItem
                key={task.id}
                task={task}
                onSelect={() => onNavigate({ page: 'detail', taskId: task.id })}
                session={sessions.get(task.id)}
              />
            ))}

            {completed.length > 0 && (
              <>
                <button
                  onClick={() => setShowCompleted(!showCompleted)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground active:bg-accent/30 border-b border-border/30"
                >
                  <span className="text-[10px]">{showCompleted ? '\u25BC' : '\u25B6'}</span>
                  <span>Completed ({completed.length})</span>
                </button>
                {showCompleted && completed.map((task) => (
                  <TaskListItem
                    key={task.id}
                    task={task}
                    onSelect={() => onNavigate({ page: 'detail', taskId: task.id })}
                    session={sessions.get(task.id)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
