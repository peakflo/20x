import { Calendar } from 'lucide-react'
import { cn, formatDate, isOverdue, isDueSoon } from '@/lib/utils'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

const statusDotColor: Record<TaskStatus, string> = {
  [TaskStatus.NotStarted]: 'bg-muted-foreground',
  [TaskStatus.AgentWorking]: 'bg-amber-400',
  [TaskStatus.ReadyForReview]: 'bg-purple-400',
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
          statusDotColor[task.status],
          task.status === TaskStatus.AgentWorking && 'animate-pulse'
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
            {task.source !== 'local' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground">{task.source}</span>
            )}
          </div>
        </div>
      </div>
    </button>
  )
}
