import { useMemo, useCallback } from 'react'
import { Clock, AlertCircle, CheckCircle2, ExternalLink, Bot } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { OpenCodeLogo, AnthropicLogo, OpenAILogo } from '@/components/icons/AgentLogos'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'
import { useSnoozeTick } from '@/hooks/use-snooze-tick'
import { isSnoozed } from '@/lib/utils'
import { TaskStatus, CodingAgentType } from '@/types'
import type { WorkfloTask, Agent } from '@/types'

// ── Status column definitions (matching 20x local TaskStatus enum) ──
// Completed is excluded from columns — shown as a count-only summary instead.

interface StatusColumn {
  key: TaskStatus
  label: string
  color: string
  dotColor: string
  headerBg: string
  columnBg: string
}

const COLUMNS: StatusColumn[] = [
  { key: TaskStatus.NotStarted, label: 'Not Started', color: 'text-gray-400', dotColor: 'bg-gray-400', headerBg: 'bg-gray-500/8', columnBg: 'bg-gray-500/[0.03]' },
  { key: TaskStatus.Triaging, label: 'Triaging', color: 'text-slate-300', dotColor: 'bg-slate-400', headerBg: 'bg-slate-500/8', columnBg: 'bg-slate-500/[0.03]' },
  { key: TaskStatus.AgentWorking, label: 'Agent Working', color: 'text-amber-400', dotColor: 'bg-amber-400', headerBg: 'bg-amber-500/8', columnBg: 'bg-amber-500/[0.03]' },
  { key: TaskStatus.ReadyForReview, label: 'Ready for Review', color: 'text-purple-400', dotColor: 'bg-purple-400', headerBg: 'bg-purple-500/8', columnBg: 'bg-purple-500/[0.03]' },
  { key: TaskStatus.AgentLearning, label: 'Agent Learning', color: 'text-blue-400', dotColor: 'bg-blue-400', headerBg: 'bg-blue-500/8', columnBg: 'bg-blue-500/[0.03]' }
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

function getPriorityAccent(priority: string): string {
  switch (priority) {
    case 'critical':
      return 'border-l-red-500/40'
    case 'high':
      return 'border-l-orange-500/40'
    case 'medium':
      return 'border-l-amber-400/35'
    case 'low':
      return 'border-l-gray-500/25'
    default:
      return 'border-l-gray-500/15'
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

// ── Initials Avatar ──────────────────────────────────────────

const AVATAR_COLORS = [
  'bg-blue-500/80',
  'bg-emerald-500/80',
  'bg-purple-500/80',
  'bg-amber-500/80',
  'bg-rose-500/80',
  'bg-cyan-500/80',
  'bg-indigo-500/80',
  'bg-teal-500/80',
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
      className={`h-5 w-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white shrink-0 ring-1 ring-white/10 ${getAvatarColor(name)}`}
      title={name}
    >
      {getInitials(name)}
    </div>
  )
}

// ── Source badge ──────────────────────────────────────────────

function getSourceConfig(source: string): { label: string; color: string } {
  const s = source.toLowerCase()
  if (s.includes('trello')) return { label: 'Trello', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' }
  if (s.includes('jira')) return { label: 'Jira', color: 'text-blue-300 bg-blue-400/10 border-blue-400/20' }
  if (s.includes('linear')) return { label: 'Linear', color: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' }
  if (s.includes('asana')) return { label: 'Asana', color: 'text-rose-400 bg-rose-500/10 border-rose-500/20' }
  if (s.includes('github')) return { label: 'GitHub', color: 'text-gray-300 bg-gray-500/10 border-gray-500/20' }
  if (s.includes('notion')) return { label: 'Notion', color: 'text-gray-300 bg-gray-400/10 border-gray-400/20' }
  return { label: source, color: 'text-muted-foreground bg-muted/20 border-border/30' }
}

// ── Agent display helper ─────────────────────────────────

function getAgentDisplay(agent: Agent | undefined): { name: string; Logo: React.FC<{ className?: string }> } | null {
  if (!agent) return null
  const codingAgent = agent.config?.coding_agent
  switch (codingAgent) {
    case CodingAgentType.CLAUDE_CODE:
      return { name: 'Claude Code', Logo: AnthropicLogo }
    case CodingAgentType.OPENCODE:
      return { name: 'OpenCode', Logo: OpenCodeLogo }
    case CodingAgentType.CODEX:
      return { name: 'Codex', Logo: OpenAILogo }
    default:
      return { name: agent.name || 'Agent', Logo: ({ className }: { className?: string }) => <Bot className={className} /> }
  }
}

// ── Task Card ──────────────────────────────────────────────

function TaskCard({ task, onSelect, agent }: { task: WorkfloTask; onSelect: (id: string) => void; agent?: Agent }) {
  const overdue = task.due_date && task.status !== TaskStatus.Completed && isOverdue(task.due_date)
  const sourceConfig = task.source && task.source !== 'local' ? getSourceConfig(task.source) : null

  return (
    <div
      className={`group rounded-lg border border-border/30 bg-card/80 backdrop-blur-sm p-3.5 hover:border-border/60 hover:bg-card hover:shadow-md hover:shadow-black/10 transition-all duration-200 cursor-pointer border-l-2 ${getPriorityAccent(task.priority)}`}
      onClick={() => onSelect(task.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(task.id) } }}
    >
      {/* Title + Priority */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <h4 className="text-[13px] font-medium leading-snug line-clamp-2 flex-1 text-foreground/90 group-hover:text-foreground transition-colors">
          {task.title}
        </h4>
        {task.priority && task.priority !== 'low' && (
          <Badge variant={getPriorityVariant(task.priority)} className="text-[9px] px-1.5 py-0 shrink-0 uppercase tracking-wider font-semibold">
            {task.priority}
          </Badge>
        )}
      </div>

      {/* Description */}
      {task.description && (
        <p className="text-[11px] text-muted-foreground/80 line-clamp-2 mb-2.5 leading-relaxed">{task.description}</p>
      )}

      {/* Labels */}
      {task.labels && task.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {task.labels.slice(0, 3).map((label) => (
            <span
              key={label}
              className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-muted/30 text-muted-foreground"
            >
              {label}
            </span>
          ))}
          {task.labels.length > 3 && (
            <span className="text-[9px] text-muted-foreground/60 px-1 py-0.5">
              +{task.labels.length - 3}
            </span>
          )}
        </div>
      )}

      {/* Footer: metadata + assignee/agent */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground min-w-0">
          {task.due_date && (
            <span className={`flex items-center gap-1 shrink-0 ${overdue ? 'text-red-400 font-medium' : ''}`}>
              {overdue ? <AlertCircle className="h-3 w-3" /> : <Clock className="h-3 w-3 opacity-60" />}
              {formatRelativeDate(task.due_date)}
            </span>
          )}
          {sourceConfig && (
            <span className={`flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full border shrink-0 ${sourceConfig.color}`}>
              <ExternalLink className="h-2.5 w-2.5" />
              {sourceConfig.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {(() => {
            const agentDisplay = getAgentDisplay(agent)
            if (!agentDisplay) return null
            const { name, Logo } = agentDisplay
            return (
              <span className="flex items-center gap-1 text-[9px] text-muted-foreground" title={name}>
                <Logo className="h-3 w-3 opacity-70" />
                <span className="truncate max-w-[60px]">{name}</span>
              </span>
            )
          })()}
          {task.assignee && (
            <AssigneeAvatar name={task.assignee} />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Column header ────────────────────────────────────────────

function ColumnHeader({ column, count }: { column: StatusColumn; count: number }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <div className={`h-2.5 w-2.5 rounded-full ${column.dotColor} ring-2 ring-black/20`} />
      <span className={`text-xs font-semibold tracking-wide ${column.color}`}>{column.label}</span>
      <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 min-w-[22px] text-center ${column.headerBg} ${column.color}`}>
        {count}
      </span>
    </div>
  )
}

// ── Column wrapper ───────────────────────────────────────────

function BoardColumn({ column, tasks, onSelect, agentMap }: { column: StatusColumn; tasks: WorkfloTask[]; onSelect: (id: string) => void; agentMap: Map<string, Agent> }) {
  return (
    <div className={`min-w-[230px] max-w-[280px] flex-1 flex flex-col rounded-xl ${column.columnBg} border border-border/15`}>
      {/* Sticky header within column */}
      <div className={`sticky top-0 z-10 ${column.columnBg} backdrop-blur-md rounded-t-xl border-b border-border/15`}>
        <ColumnHeader column={column} count={tasks.length} />
      </div>

      {/* Cards */}
      <div className="flex-1 p-2 space-y-2 overflow-y-auto">
        {tasks.length === 0 ? (
          <div className="text-[11px] text-muted-foreground/50 text-center py-8 px-2">
            No tasks
          </div>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} onSelect={onSelect} agent={task.agent_id ? agentMap.get(task.agent_id) : undefined} />)
        )}
      </div>
    </div>
  )
}

// ── TaskBoard ──────────────────────────────────────────────

export function TaskBoard() {
  const { tasks, isLoading } = useTaskStore()
  const { agents } = useAgentStore()
  const { openDashboardPreview } = useUIStore()
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
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold tracking-wide">Task Board</h2>
        <div className="flex items-center gap-3">
          {tasksByStatus.completedCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full">
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
        <div className="flex gap-3 pb-2 justify-center">
          {COLUMNS.map((col) => (
            <div key={col.key} className={`min-w-[230px] max-w-[280px] flex-1 rounded-xl ${col.columnBg} border border-border/15`}>
              <div className="px-3 py-2.5 border-b border-border/15">
                <div className="flex items-center gap-2">
                  <div className={`h-2.5 w-2.5 rounded-full ${col.dotColor} opacity-40`} />
                  <span className="text-xs font-semibold text-muted-foreground/50">{col.label}</span>
                </div>
              </div>
              <div className="p-2 space-y-2">
                {[1, 2].map((i) => (
                  <div key={i} className="rounded-lg border border-border/20 bg-card/40 p-3.5 border-l-2 border-l-gray-500/30">
                    <div className="h-3 w-24 rounded-md bg-muted/40 animate-pulse mb-2.5" />
                    <div className="h-2.5 w-36 rounded-md bg-muted/25 animate-pulse mb-2" />
                    <div className="h-2 w-20 rounded-md bg-muted/15 animate-pulse" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : topLevelTasks.length === 0 ? (
        <div className="rounded-xl border border-border/30 bg-card/50 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No tasks yet. Create tasks or sync from an integration to see them here.
          </p>
        </div>
      ) : (
        <div className="flex gap-3 pb-2 justify-center">
          {COLUMNS.map((col) => (
            <BoardColumn
              key={col.key}
              column={col}
              tasks={sortByPriority(tasksByStatus.grouped[col.key] || [])}
              onSelect={handleSelectTask}
              agentMap={agentMap}
            />
          ))}
        </div>
      )}
    </section>
  )
}
