import { Calendar, AlarmClockOff, Repeat } from 'lucide-react'
import { cn, formatDate, isOverdue, isDueSoon, isSnoozed } from '@/lib/utils'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { useAgentStore } from '@/stores/agent-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask, RecurrencePattern, RecurrencePatternObject } from '@/types'

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`
  const last = n % 10
  if (last === 1) return `${n}st`
  if (last === 2) return `${n}nd`
  if (last === 3) return `${n}rd`
  return `${n}th`
}

function formatRecurrenceShort(pattern: RecurrencePattern): string {
  if (typeof pattern === 'string') {
    const parts = pattern.trim().split(/\s+/)
    if (parts.length < 5) return pattern

    const [minute, hour, dayOfMonth, , dayOfWeek] = parts
    const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

    if (dayOfWeek !== '*') {
      const days = dayOfWeek.split(',').flatMap(part => {
        if (part.includes('-')) {
          const [start, end] = part.split('-').map(Number)
          const result: number[] = []
          for (let i = start; i <= end; i++) result.push(i)
          return result
        }
        return [parseInt(part)]
      }).filter(n => !isNaN(n)).map(d => dayNames[d]).join(', ')
      return `${days} at ${time}`
    }

    if (dayOfMonth !== '*' && !dayOfMonth.startsWith('*/')) {
      return `${ordinal(parseInt(dayOfMonth))} at ${time}`
    }

    if (dayOfMonth.startsWith('*/')) {
      return `Every ${dayOfMonth.slice(2)}d at ${time}`
    }

    return `Daily at ${time}`
  }

  const p = pattern as RecurrencePatternObject
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  if (p.type === 'weekly' && p.weekdays) {
    return `${p.weekdays.map(d => dayNames[d]).join(', ')} at ${p.time}`
  }
  if (p.type === 'monthly' && p.monthDay) {
    return `${ordinal(p.monthDay)} at ${p.time}`
  }
  if (p.type === 'daily' && p.interval > 1) {
    return `Every ${p.interval}d at ${p.time}`
  }
  return `Daily at ${p.time}`
}

const statusDotColor: Record<TaskStatus, string> = {
  [TaskStatus.NotStarted]: 'bg-muted-foreground',
  [TaskStatus.Triaging]: 'bg-muted-foreground animate-pulse',
  [TaskStatus.AgentWorking]: 'bg-amber-400',
  [TaskStatus.ReadyForReview]: 'bg-purple-400',
  [TaskStatus.AgentLearning]: 'bg-blue-400',
  [TaskStatus.Completed]: 'bg-emerald-400'
}

interface TaskListItemProps {
  task: WorkfloTask
  isSelected: boolean
  onSelect: () => void
}

export function TaskListItem({ task, isSelected, onSelect }: TaskListItemProps) {
  const isActive = task.status !== TaskStatus.Completed
  const overdue = isActive && isOverdue(task.due_date)
  const dueSoon = isActive && !overdue && isDueSoon(task.due_date)
  const session = useAgentStore((s) => s.sessions.get(task.id))
  const hasActiveAgent = session && session.status !== 'idle'
  const hasPendingQuestion = Boolean(
    session?.pendingApproval &&
    session.status !== 'idle' &&
    (session.pendingApproval as any).action
  )

  // Determine status indicator color
  const getStatusColor = () => {
    if (hasPendingQuestion) {
      return 'bg-blue-400 animate-pulse' // Waiting for user input
    }
    // Check task status first - AgentLearning/Triaging takes priority over session status
    if (task.status === TaskStatus.AgentLearning) {
      return 'bg-blue-400 animate-pulse' // Agent learning
    }
    if (task.status === TaskStatus.Triaging) {
      return 'bg-muted-foreground animate-pulse' // Triaging
    }
    if (hasActiveAgent) {
      return 'bg-amber-400 animate-pulse' // Agent working
    }
    return statusDotColor[task.status] // Task status
  }

  return (
    <button
      onClick={onSelect}
      aria-current={isSelected ? 'true' : undefined}
      className={cn(
        'w-full text-left px-3 py-2.5 rounded-md transition-colors cursor-pointer group',
        isSelected ? 'bg-accent' : 'hover:bg-accent/50'
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn(
          'mt-[7px] h-2 w-2 rounded-full shrink-0',
          getStatusColor()
        )} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{task.title}</div>
          <div className="flex items-center gap-2 mt-1">
            <TaskPriorityBadge priority={task.priority} />
            {task.due_date && (
              <span className={cn('flex items-center gap-1 text-xs', overdue ? 'text-destructive' : dueSoon ? 'text-amber-400' : 'text-muted-foreground')}>
                <Calendar className="h-3 w-3" />
                {formatDate(task.due_date)}
              </span>
            )}
            {isSnoozed(task.snoozed_until) && (
              <AlarmClockOff className="h-3 w-3 text-muted-foreground" />
            )}
            {task.is_recurring && !task.recurrence_parent_id && task.recurrence_pattern && (
              <span
                className="flex items-center gap-1 text-xs text-muted-foreground"
                title={task.next_occurrence_at ? `Next: ${formatDate(task.next_occurrence_at)}` : undefined}
              >
                <Repeat className="h-3 w-3" />
                {formatRecurrenceShort(task.recurrence_pattern)}
              </span>
            )}
            {task.recurrence_parent_id && (
              <span title="From recurring template">
                <Repeat className="h-3 w-3 text-muted-foreground opacity-50" />
              </span>
            )}
            {task.source !== 'local' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground">{task.source}</span>
            )}
          </div>
        </div>
      </div>
    </button>
  )
}
