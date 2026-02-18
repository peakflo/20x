import { Calendar, AlarmClockOff, Repeat } from 'lucide-react'
import { cn, formatDate, isOverdue, isDueSoon, isSnoozed } from '@/lib/utils'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { useAgentStore } from '@/stores/agent-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

const statusDotColor: Record<TaskStatus, string> = {
  [TaskStatus.NotStarted]: 'bg-muted-foreground',
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
    // Check task status first - AgentLearning takes priority over session status
    if (task.status === TaskStatus.AgentLearning) {
      return 'bg-blue-400 animate-pulse' // Agent learning
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
            {task.is_recurring && !task.recurrence_parent_id && task.next_occurrence_at && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground" title={`Next: ${formatDate(task.next_occurrence_at)}`}>
                <Repeat className="h-3 w-3" />
                {formatDate(task.next_occurrence_at)}
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
