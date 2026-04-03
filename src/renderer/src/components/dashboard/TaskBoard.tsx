import { useMemo, useCallback } from 'react'
import { Clock, AlertCircle, CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { useSnoozeTick } from '@/hooks/use-snooze-tick'
import { isSnoozed } from '@/lib/utils'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

// ── Status column definitions (matching 20x local TaskStatus enum) ──
// Completed is excluded from columns — shown as a count-only summary instead.

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
  { key: TaskStatus.AgentLearning, label: 'Agent Learning', color: 'text-blue-400', dotColor: 'bg-blue-400' }
]

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
}

function sortByPriority(tasks: WorkfloTask[]): WorkfloTask[] {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority || ''] ?? 4
    const pb = PRIORITY_ORDER[b.priority || ''] ?? 4
    return pa - pb
  })
}

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
      className="rounded-md border border-border/40 bg-[#1E2127] p-3 hover:border-border/70 hover:bg-[#191D23] transition-colors cursor-pointer"
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

// ── Column header (rendered in a separate sticky row) ─────

function ColumnHeader({ column, count }: { column: StatusColumn; count: number }) {
  return (
    <div className="flex items-center gap-2 px-2 py-2 min-w-[200px] max-w-[260px] flex-1">
      <div className={`h-2 w-2 rounded-full ${column.dotColor}`} />
      <span className={`text-xs font-semibold ${column.color}`}>{column.label}</span>
      <span className="text-[10px] text-muted-foreground bg-muted/30 rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
        {count}
      </span>
    </div>
  )
}

// ── Column cards ──────────────────────────────────────────

function ColumnCards({ tasks, onSelect }: { tasks: WorkfloTask[]; onSelect: (id: string) => void }) {
  return (
    <div className="min-w-[200px] max-w-[260px] flex-1 space-y-2">
      {tasks.length === 0 ? (
        <div className="text-[11px] text-muted-foreground text-center py-4 px-2">
          No tasks
        </div>
      ) : (
        tasks.map((task) => <TaskCard key={task.id} task={task} onSelect={onSelect} />)
      )}
    </div>
  )
}

// ── TaskBoard ──────────────────────────────────────────────

export function TaskBoard() {
  const { tasks, isLoading } = useTaskStore()
  const { openDashboardPreview } = useUIStore()
  const snoozeTick = useSnoozeTick(tasks)

  // Only show top-level tasks that are not snoozed (not subtasks)
  const topLevelTasks = useMemo(
    () => tasks.filter((t) => !t.parent_task_id && !isSnoozed(t.snoozed_until)),
    [tasks, snoozeTick]
  )

  // Open task preview modal (rendered by AppLayout with full TaskWorkspace)
  const handleSelectTask = useCallback((taskId: string) => {
    openDashboardPreview(taskId)
  }, [openDashboardPreview])

  const tasksByStatus = useMemo(() => {
    const grouped: Record<string, WorkfloTask[]> = {}
    for (const col of COLUMNS) {
      grouped[col.key] = []
    }
    let completedCount = 0
    for (const task of topLevelTasks) {
      const status = task.status || TaskStatus.NotStarted
      if (status === TaskStatus.Completed) {
        completedCount++
      } else if (grouped[status]) {
        grouped[status].push(task)
      } else {
        grouped[TaskStatus.NotStarted].push(task)
      }
    }
    return { grouped, completedCount }
  }, [topLevelTasks])

  const activeTasks = topLevelTasks.length - tasksByStatus.completedCount

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Task Board</h2>
        <div className="flex items-center gap-3">
          {tasksByStatus.completedCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-emerald-400">
              <CheckCircle2 className="h-3 w-3" />
              {tasksByStatus.completedCount} completed
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {activeTasks} active task{activeTasks !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {isLoading ? (
        <>
          <div className="flex gap-4 pb-2">
            {COLUMNS.map((col) => (
              <ColumnHeader key={col.key} column={col} count={0} />
            ))}
          </div>
          <div className="flex gap-4 pb-2">
            {COLUMNS.map((col) => (
              <div key={col.key} className="min-w-[200px] max-w-[260px] flex-1 space-y-2">
                {[1, 2].map((i) => (
                  <div key={i} className="rounded-md border border-border/40 bg-[#1E2127] p-3">
                    <div className="h-3 w-28 rounded bg-muted/50 animate-pulse mb-2" />
                    <div className="h-2.5 w-40 rounded bg-muted/30 animate-pulse" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      ) : topLevelTasks.length === 0 ? (
        <div className="rounded-lg border border-border/50 bg-[#191D23] p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No tasks yet. Create tasks or sync from an integration to see them here.
          </p>
        </div>
      ) : (
        <>
          {/* Sticky column headers — pinned when dashboard scrolls */}
          <div className="flex gap-4 sticky top-0 bg-background z-10 pb-2">
            {COLUMNS.map((col) => (
              <ColumnHeader
                key={col.key}
                column={col}
                count={(tasksByStatus.grouped[col.key] || []).length}
              />
            ))}
          </div>
          {/* Card columns */}
          <div className="flex gap-4 pb-2">
            {COLUMNS.map((col) => (
              <ColumnCards
                key={col.key}
                tasks={sortByPriority(tasksByStatus.grouped[col.key] || [])}
                onSelect={handleSelectTask}
              />
            ))}
          </div>
        </>
      )}
    </section>
  )
}
