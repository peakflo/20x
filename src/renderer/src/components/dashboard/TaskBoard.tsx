import { useMemo, useCallback, memo } from 'react'
import {
  Clock,
  AlertCircle,
  CheckCircle2,
  Bot,
  Terminal,
  Circle,
  CircleDashed,
  CircleDot,
  CircleAlert,
  CircleDotDashed,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import { OpenCodeLogo, AnthropicLogo, OpenAILogo, PiLogo } from '@/components/icons/AgentLogos'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'
import { useSnoozeTick } from '@/hooks/use-snooze-tick'
import { cn, isSnoozed } from '@/lib/utils'
import { TaskStatus, CodingAgentType } from '@/types'
import { isTaskClosed } from '@shared/constants'
import type { WorkfloTask, Agent } from '@/types'

// ── Status column definitions (matching 20x local TaskStatus enum) ──
// Completed is excluded from columns — shown as a count-only summary instead.
// Each column gets a faint wash of its header-icon hue. The tint is an
// opacity-based `-500` shade, so it sits subtly on both the light and dark
// background and white cards keep their contrast. `text-*-400` shades are
// remapped to darker, legible values in light mode by globals.css.

interface StatusColumn {
  key: TaskStatus
  label: string
  Icon: LucideIcon
  iconColor: string
  surface: string
}

const COLUMNS: StatusColumn[] = [
  { key: TaskStatus.NotStarted, label: 'Not Started', Icon: Circle, iconColor: 'text-muted-foreground', surface: 'border-border/70 bg-foreground/[0.025]' },
  { key: TaskStatus.Triaging, label: 'Triaging', Icon: CircleDashed, iconColor: 'text-slate-400', surface: 'border-slate-500/15 bg-slate-500/[0.06]' },
  { key: TaskStatus.AgentWorking, label: 'Agent Working', Icon: CircleDotDashed, iconColor: 'text-amber-400', surface: 'border-amber-500/15 bg-amber-500/[0.06]' },
  { key: TaskStatus.ModelError, label: 'Model Error', Icon: CircleAlert, iconColor: 'text-red-400', surface: 'border-red-500/15 bg-red-500/[0.06]' },
  { key: TaskStatus.ReadyForReview, label: 'Ready for Review', Icon: CircleDot, iconColor: 'text-pink-400', surface: 'border-pink-500/15 bg-pink-500/[0.06]' },
  { key: TaskStatus.AgentLearning, label: 'Agent Learning', Icon: Sparkles, iconColor: 'text-blue-400', surface: 'border-blue-500/15 bg-blue-500/[0.06]' }
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

// ── Priority indicator (Linear-style signal bars) ─────────────

const PRIORITY_LEVEL: Record<string, number> = { low: 1, medium: 2, high: 3 }

function PriorityIcon({ priority }: { priority: string }) {
  if (!priority) return null
  const label = `${priority.charAt(0).toUpperCase()}${priority.slice(1)} priority`
  if (priority === 'critical') {
    return (
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-red-500 text-[10px] font-bold leading-none text-white"
        title={label}
      >
        <span aria-hidden="true">!</span>
        <span className="sr-only">{priority}</span>
      </span>
    )
  }
  const level = PRIORITY_LEVEL[priority]
  if (!level) return null
  return (
    <span className="inline-flex" title={label}>
      <span className="sr-only">{priority}</span>
      <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <rect
            key={i}
            x={2 + i * 4.5}
            y={10 - i * 3.5}
            width={3}
            height={4 + i * 3.5}
            rx={1}
            className={i < level ? 'fill-foreground/70' : 'fill-foreground/15'}
          />
        ))}
      </svg>
    </span>
  )
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

// ── Initials Avatar ──────────────────────────────────────────

const AVATAR_COLORS = [
  'bg-blue-500',
  'bg-emerald-500',
  'bg-teal-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-indigo-500',
  'bg-violet-500',
]

function getAvatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function AssigneeAvatar({ name }: { name: string }) {
  return (
    <div
      className={`h-5 w-5 rounded-full flex items-center justify-center text-[8.5px] font-semibold text-white shrink-0 ring-2 ring-card ${getAvatarColor(name)}`}
      title={name}
    >
      {getInitials(name)}
    </div>
  )
}

function UnassignedAvatar() {
  return (
    <div
      className="h-5 w-5 shrink-0 rounded-full border border-dashed border-muted-foreground/45"
      title="Unassigned"
      aria-label="Unassigned"
    />
  )
}

// ── Source chip ──────────────────────────────────────────────
// Neutral chip with a small brand-coloured dot — legible on any surface.

function getSourceConfig(source: string): { label: string; dot: string } {
  const s = source.toLowerCase()
  if (s.includes('trello')) return { label: 'Trello', dot: 'bg-blue-500' }
  if (s.includes('jira')) return { label: 'Jira', dot: 'bg-sky-500' }
  if (s.includes('linear')) return { label: 'Linear', dot: 'bg-indigo-500' }
  if (s.includes('asana')) return { label: 'Asana', dot: 'bg-rose-500' }
  if (s.includes('github')) return { label: 'GitHub', dot: 'bg-foreground/70' }
  if (s.includes('notion')) return { label: 'Notion', dot: 'bg-foreground/50' }
  return { label: source, dot: 'bg-muted-foreground' }
}

const CHIP =
  'inline-flex h-5 items-center gap-1 rounded-md border border-border bg-foreground/[0.025] px-1.5 text-[10.5px] font-medium leading-none text-muted-foreground shrink-0'

// ── Agent display helper ─────────────────────────────────

function getAgentDisplay(agent: Agent | undefined): { name: string; Logo: React.FC<{ className?: string }> } | null {
  if (!agent) return null
  const name = agent.name || 'Agent'
  const codingAgent = agent.config?.coding_agent
  switch (codingAgent) {
    case CodingAgentType.CLAUDE_CODE:
      return { name, Logo: AnthropicLogo }
    case CodingAgentType.OPENCODE:
      return { name, Logo: OpenCodeLogo }
    case CodingAgentType.CODEX:
      return { name, Logo: OpenAILogo }
    case CodingAgentType.CURSOR:
      return { name, Logo: Terminal }
    case CodingAgentType.PI:
      return { name, Logo: PiLogo }
    default:
      return { name, Logo: ({ className }: { className?: string }) => <Bot className={className} /> }
  }
}

// ── Task Card ──────────────────────────────────────────────

const TaskCard = memo(function TaskCard({ task, onSelect, agent }: { task: WorkfloTask; onSelect: (id: string) => void; agent?: Agent }) {
  const overdue = task.due_date && !isTaskClosed(task.status) && isOverdue(task.due_date)
  const sourceConfig = task.source && task.source !== 'local' ? getSourceConfig(task.source) : null
  const agentDisplay = getAgentDisplay(agent)
  const labels = task.labels ?? []

  return (
    <div
      className="group relative rounded-[10px] border border-border bg-card p-3 shadow-[var(--shadow-xs)] cursor-pointer transition-[border-color,box-shadow,transform] duration-150 ease-out hover:-translate-y-px hover:border-foreground/15 hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      onClick={() => onSelect(task.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(task.id) } }}
    >
      {/* Title + priority */}
      <div className="flex items-start gap-2">
        <h4 className="flex-1 text-[13px] font-medium leading-[1.4] tracking-[-0.005em] text-foreground line-clamp-2">
          {task.title}
        </h4>
        <span className="mt-px">
          <PriorityIcon priority={task.priority} />
        </span>
      </div>

      {/* Description */}
      {task.description && (
        <p className="mt-1 text-[12px] leading-[1.45] text-muted-foreground line-clamp-2">{task.description}</p>
      )}

      {/* Footer: chips on the left, agent + assignee on the right */}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {task.due_date && (
            <span className={cn(CHIP, overdue && 'border-red-500/25 bg-red-500/10 text-red-400')}>
              {overdue ? <AlertCircle className="h-3 w-3" /> : <Clock className="h-3 w-3 opacity-70" />}
              {formatRelativeDate(task.due_date)}
            </span>
          )}
          {sourceConfig && (
            <span className={CHIP}>
              <span className={`h-1.5 w-1.5 rounded-full ${sourceConfig.dot}`} />
              {sourceConfig.label}
            </span>
          )}
          {labels.slice(0, 2).map((label) => (
            <span key={label} className={cn(CHIP, 'max-w-[96px] font-normal')}>
              <span className="truncate">{label}</span>
            </span>
          ))}
          {labels.length > 2 && (
            <span className="shrink-0 px-0.5 text-[10.5px] tabular-nums text-muted-foreground/80">
              +{labels.length - 2}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 min-w-0">
          {agentDisplay && (
            <span
              className="flex max-w-[110px] items-center gap-1 text-[10.5px] text-muted-foreground"
              title={agentDisplay.name}
            >
              <agentDisplay.Logo className="h-3 w-3 shrink-0 opacity-80" />
              <span className="truncate">{agentDisplay.name}</span>
            </span>
          )}
          {task.assignee ? (
            <AssigneeAvatar name={task.assignee} />
          ) : (
            !agentDisplay && <UnassignedAvatar />
          )}
        </div>
      </div>
    </div>
  )
})

// ── Column header ────────────────────────────────────────────

const ColumnHeader = memo(function ColumnHeader({ column, count }: { column: StatusColumn; count: number }) {
  const { Icon } = column
  return (
    <div className="flex items-center gap-2 px-3 h-10">
      <Icon className={`h-3.5 w-3.5 shrink-0 ${column.iconColor}`} strokeWidth={2.25} />
      <span className="text-[12.5px] font-semibold tracking-[-0.005em] text-foreground">{column.label}</span>
      <span className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-full bg-foreground/[0.06] px-1.5 text-[10.5px] font-medium tabular-nums text-muted-foreground">
        {count}
      </span>
    </div>
  )
})

const COLUMN_SURFACE =
  'min-w-[240px] max-w-[320px] flex-1 flex flex-col rounded-xl border'

// ── Column wrapper ───────────────────────────────────────────

const BoardColumn = memo(function BoardColumn({ column, tasks, onSelect, agentMap }: { column: StatusColumn; tasks: WorkfloTask[]; onSelect: (id: string) => void; agentMap: Map<string, Agent> }) {
  return (
    <div className={cn(COLUMN_SURFACE, column.surface)}>
      {/* Sticky header within column */}
      <div className="sticky top-0 z-10 rounded-t-xl">
        <ColumnHeader column={column} count={tasks.length} />
      </div>

      {/* Cards */}
      <div className="flex-1 px-2 pb-2 space-y-2 overflow-y-auto">
        {tasks.length === 0 ? (
          <div className="flex h-20 items-center justify-center rounded-[10px] border border-dashed border-border text-[11.5px] text-muted-foreground/80">
            No tasks
          </div>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} onSelect={onSelect} agent={task.agent_id ? agentMap.get(task.agent_id) : undefined} />)
        )}
      </div>
    </div>
  )
})

// ── TaskBoard ──────────────────────────────────────────────

export function TaskBoard() {
  // Use individual selectors to prevent re-renders from unrelated store changes
  const tasks = useTaskStore((s) => s.tasks)
  const isLoading = useTaskStore((s) => s.isLoading)
  // Completed history is not loaded into the store; its count comes from the DB.
  const completedTotal = useTaskStore((s) => s.completedTotal)
  const agents = useAgentStore((s) => s.agents)
  const openDashboardPreview = useUIStore((s) => s.openDashboardPreview)
  const snoozeTick = useSnoozeTick(tasks)

  // Build agent lookup map by id
  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>()
    for (const agent of agents) {
      map.set(agent.id, agent)
    }
    return map
  }, [agents])

  // Only show top-level tasks that are not snoozed (not subtasks) and not recurring templates
  const topLevelTasks = useMemo(
    () => tasks.filter((t) => !t.parent_task_id && !isSnoozed(t.snoozed_until) && !(t.is_recurring && !t.recurrence_parent_id)),
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
      if (isTaskClosed(status)) {
        completedCount++
      } else if (grouped[status]) {
        grouped[status].push(task)
      } else {
        grouped[TaskStatus.NotStarted].push(task)
      }
    }
    // Sort each column's tasks by priority within the same useMemo to avoid
    // creating new arrays on every render via inline sortByPriority() calls
    for (const col of COLUMNS) {
      grouped[col.key] = sortByPriority(grouped[col.key])
    }
    return { grouped, completedCount }
  }, [topLevelTasks])

  const activeTasks = topLevelTasks.length - tasksByStatus.completedCount

  return (
    <section>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.015em]">Task Board</h2>
        <div className="flex items-center gap-2">
          {completedTotal > 0 && (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-[11.5px] font-medium text-muted-foreground shadow-[var(--shadow-xs)]">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              <span className="tabular-nums text-foreground">{completedTotal}</span> completed
            </span>
          )}
          <span className="inline-flex h-6 items-center rounded-full border border-border bg-card px-2.5 text-[11.5px] font-medium tabular-nums text-muted-foreground shadow-[var(--shadow-xs)]">
            {`${activeTasks} active task${activeTasks !== 1 ? 's' : ''}`}
          </span>
        </div>
      </div>

      {isLoading ? (
        <div className="flex gap-3 pb-2 overflow-x-auto">
          {COLUMNS.map((col) => (
            <div key={col.key} className={cn(COLUMN_SURFACE, col.surface)}>
              <div className="flex items-center gap-2 px-3 h-10">
                <col.Icon className={`h-3.5 w-3.5 ${col.iconColor} opacity-50`} strokeWidth={2.25} />
                <span className="text-[12.5px] font-semibold text-muted-foreground/70">{col.label}</span>
              </div>
              <div className="px-2 pb-2 space-y-2">
                {[1, 2].map((i) => (
                  <div key={i} className="rounded-[10px] border border-border bg-card p-3 shadow-[var(--shadow-xs)]">
                    <div className="h-3 w-3/4 rounded-md bg-muted animate-pulse mb-2" />
                    <div className="h-3 w-1/2 rounded-md bg-muted animate-pulse mb-3" />
                    <div className="h-4 w-16 rounded-md bg-muted/70 animate-pulse" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : topLevelTasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/30 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No tasks yet. Create tasks or sync from an integration to see them here.
          </p>
        </div>
      ) : (
        <div className="flex gap-3 pb-2 overflow-x-auto">
          {COLUMNS.map((col) => (
            <BoardColumn
              key={col.key}
              column={col}
              tasks={tasksByStatus.grouped[col.key] || []}
              onSelect={handleSelectTask}
              agentMap={agentMap}
            />
          ))}
        </div>
      )}
    </section>
  )
}
