import { useMemo, useCallback, useState } from 'react'
import { Clock, AlertCircle } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'
import { TaskPreviewModal } from './TaskPreviewModal'

// ── Status column definitions (matching 20x local TaskStatus enum) ──

interface StatusColumn {
  key: TaskStatus
  label: string
  color: string
  dotColor: string
}

const COLUMNS: StatusColumn[] = [
  { key: TaskStatus.NotStarted, label: 'Not Started', color: 'text-muted-foreground', dotColor: 'bg-muted-foreground' },
  { key: TaskStatus.Triaging, label: 'Triaging', color: 'text-muted-foreground', dotColor: 'bg-muted-foreground' },
  { key: TaskStatus.AgentWorking, label: 'Agent Working', color: 'text-amber-400', dotColor: 'bg-amber-400' },
  { key: TaskStatus.ReadyForReview, label: 'Ready for Review', color: 'text-purple-400', dotColor: 'bg-purple-400' },
  { key: TaskStatus.AgentLearning, label: 'Agent Learning', color: 'text-blue-400', dotColor: 'bg-blue-400' },
  { key: TaskStatus.Completed, label: 'Completed', color: 'text-emerald-400', dotColor: 'bg-emerald-400' }
]

function getPriorityVariant(priority: string): 'red' | 'orange' | 'yellow' | 'default' {
  switch (priority) {
    case 'critical':
      return 'red'
    case 'high':
      return 'orange'
    case 'medium':
      return 'yellow'
    case 'low':
      return 'default'
    default:
      return 'default'
  }
}

function formatRelativeDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60))
  const isFuture = diffMs < 0

  if (diffHours < 1) return isFuture ? 'in <1h' : '<1h ago'
  if (diffHours < 24) return isFuture ? `in ${diffHours}h` : `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return isFuture ? 'tomorrow' : 'yesterday'
  if (diffDays < 30) return isFuture ? `in ${diffDays}d` : `${diffDays}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function isOverdue(dateStr: string | null): boolean {
  if (!dateStr) return false
  return new Date(dateStr) < new Date()
}

// ── Task Card ──────────────────────────────────────────────

function TaskCard({ task, onSelect }: { task: WorkfloTask; onSelect: (id: string) => void }) {
  const overdue = task.due_date && task.status !== TaskStatus.Completed && isOverdue(task.due_date)

  return (
    <div
      className="rounded-md border border-border/40 bg-[#0d1117] p-3 hover:border-border/70 hover:bg-[#161b22] transition-colors cursor-pointer"
      onClick={() => onSelect(task.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(task.id) } }}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <h4 className="text-xs font-medium leading-snug line-clamp-2 flex-1">{task.title}</h4>
        {task.priority && task.priority !== 'low' && (
          <Badge variant={getPriorityVariant(task.priority)} className="text-[9px] px-1 py-0 shrink-0">
            {task.priority}
          </Badge>
        )}
      </div>
      {task.description && (
        <p className="text-[11px] text-muted-foreground line-clamp-2 mb-2">{task.description}</p>
      )}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        {task.due_date && (
          <span className={`flex items-center gap-0.5 ${overdue ? 'text-red-400' : ''}`}>
            {overdue ? <AlertCircle className="h-2.5 w-2.5" /> : <Clock className="h-2.5 w-2.5" />}
            {formatRelativeDate(task.due_date)}
          </span>
        )}
        {task.assignee && (
          <span className="truncate max-w-[100px]">
            {task.assignee}
          </span>
        )}
        {task.source && task.source !== 'local' && (
          <span className="text-[9px] bg-muted/30 px-1 rounded">{task.source}</span>
        )}
      </div>
    </div>
  )
}

// ── Column ─────────────────────────────────────────────────

function Column({ column, tasks, onSelect }: { column: StatusColumn; tasks: WorkfloTask[]; onSelect: (id: string) => void }) {
  return (
    <div className="flex flex-col min-w-[200px] max-w-[260px] flex-1">
      {/* Column header */}
      <div className="flex items-center gap-2 px-2 py-2 mb-2">
        <div className={`h-2 w-2 rounded-full ${column.dotColor}`} />
        <span className={`text-xs font-semibold ${column.color}`}>{column.label}</span>
        <span className="text-[10px] text-muted-foreground bg-muted/30 rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
          {tasks.length}
        </span>
      </div>
      {/* Cards */}
      <div className="flex-1 space-y-2 overflow-y-auto pr-1 max-h-[400px]">
        {tasks.length === 0 ? (
          <div className="text-[11px] text-muted-foreground text-center py-4 px-2">
            No tasks
          </div>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} onSelect={onSelect} />)
        )}
      </div>
    </div>
  )
}

// ── TaskBoard ──────────────────────────────────────────────

export function TaskBoard() {
  const { tasks, isLoading, selectTask } = useTaskStore()
  const { setSidebarView } = useUIStore()
  const [previewTaskId, setPreviewTaskId] = useState<string | null>(null)

  // Only show top-level tasks (not subtasks)
  const topLevelTasks = useMemo(() => tasks.filter((t) => !t.parent_task_id), [tasks])

  const previewTask = useMemo(
    () => (previewTaskId ? tasks.find((t) => t.id === previewTaskId) ?? null : null),
    [previewTaskId, tasks]
  )

  // Open preview modal
  const handlePreviewTask = useCallback((taskId: string) => {
    setPreviewTaskId(taskId)
  }, [])

  // Navigate to full task view with agent transcript
  const handleOpenFullView = useCallback((taskId: string) => {
    selectTask(taskId)
    setSidebarView('tasks')
  }, [selectTask, setSidebarView])

  const tasksByStatus = useMemo(() => {
    const grouped: Record<string, WorkfloTask[]> = {}
    for (const col of COLUMNS) {
      grouped[col.key] = []
    }
    for (const task of topLevelTasks) {
      const status = task.status || TaskStatus.NotStarted
      if (grouped[status]) {
        grouped[status].push(task)
      } else {
        // Unknown status → put in not_started
        grouped[TaskStatus.NotStarted].push(task)
      }
    }
    return grouped
  }, [topLevelTasks])

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Task Board</h2>
        <span className="text-xs text-muted-foreground">
          {topLevelTasks.length} task{topLevelTasks.length !== 1 ? 's' : ''}
        </span>
      </div>

      {isLoading ? (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {COLUMNS.map((col) => (
            <div key={col.key} className="min-w-[200px] flex-1">
              <div className="flex items-center gap-2 px-2 py-2 mb-2">
                <div className={`h-2 w-2 rounded-full ${col.dotColor}`} />
                <span className={`text-xs font-semibold ${col.color}`}>{col.label}</span>
              </div>
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <div key={i} className="rounded-md border border-border/40 bg-[#0d1117] p-3">
                    <div className="h-3 w-28 rounded bg-muted/50 animate-pulse mb-2" />
                    <div className="h-2.5 w-40 rounded bg-muted/30 animate-pulse" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : topLevelTasks.length === 0 ? (
        <div className="rounded-lg border border-border/50 bg-[#161b22] p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No tasks yet. Create tasks or sync from an integration to see them here.
          </p>
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {COLUMNS.map((col) => (
            <Column
              key={col.key}
              column={col}
              tasks={tasksByStatus[col.key] || []}
              onSelect={handlePreviewTask}
            />
          ))}
        </div>
      )}

      {/* Task preview modal */}
      <TaskPreviewModal
        task={previewTask}
        open={previewTaskId !== null}
        onOpenChange={(open) => { if (!open) setPreviewTaskId(null) }}
        onOpenFullView={handleOpenFullView}
      />
    </section>
  )
}
