import { TaskStatus } from '@shared/constants'
import { TaskPriorityBadge } from '@/components/tasks/TaskPriorityBadge'
import type { TaskPriority } from '@/types'
import { cn, formatDate, isOverdue, isDueSoon, isSnoozed } from '../lib/utils'
import type { Task } from '../stores/task-store'
import type { TaskSession } from '../stores/agent-store'

interface TaskListItemProps {
  task: Task
  onSelect: () => void
  session?: TaskSession
}

export function TaskListItem({ task, onSelect, session }: TaskListItemProps) {
  const isActive = task.status !== TaskStatus.Completed
  const overdue = isActive && isOverdue(task.due_date)
  const dueSoon = isActive && !overdue && isDueSoon(task.due_date)
  const hasActiveAgent = session && session.status !== 'idle'

  // Status indicator color — matches desktop TaskListItem exactly
  const statusDotColor = (() => {
    if (task.status === TaskStatus.AgentLearning) return 'bg-blue-400 animate-pulse'
    if (task.status === TaskStatus.Triaging) return 'bg-muted-foreground animate-pulse'
    if (hasActiveAgent) return 'bg-amber-400 animate-pulse'
    const map: Record<string, string> = {
      [TaskStatus.NotStarted]: 'bg-muted-foreground',
      [TaskStatus.AgentWorking]: 'bg-amber-400',
      [TaskStatus.ReadyForReview]: 'bg-purple-400',
      [TaskStatus.Completed]: 'bg-emerald-400',
    }
    return map[task.status] || 'bg-muted-foreground'
  })()

  return (
    <button
      onClick={onSelect}
      className="w-full text-left px-3 py-2.5 rounded-md transition-colors cursor-pointer group hover:bg-accent/50 active:bg-accent"
    >
      <div className="flex items-start gap-3">
        <div className={cn('mt-[7px] h-2 w-2 rounded-full shrink-0', statusDotColor)} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{task.title}</div>
          <div className="flex items-center gap-2 mt-1">
            <TaskPriorityBadge priority={task.priority as TaskPriority} />
            {task.due_date && (
              <span className={cn(
                'flex items-center gap-1 text-xs',
                overdue ? 'text-destructive' : dueSoon ? 'text-amber-400' : 'text-muted-foreground'
              )}>
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" />
                </svg>
                {formatDate(task.due_date)}
              </span>
            )}
            {isSnoozed(task.snoozed_until) && (
              <svg className="h-3 w-3 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 6v6l4 2" /><circle cx="12" cy="12" r="10" /><path d="m2 2 20 20" />
              </svg>
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
