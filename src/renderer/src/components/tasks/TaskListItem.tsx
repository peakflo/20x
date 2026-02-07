import { Calendar } from 'lucide-react'
import { cn, formatDate, isOverdue, isDueSoon } from '@/lib/utils'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import type { WorkfloTask, TaskStatus } from '@/types'

const statusDotColor: Record<TaskStatus, string> = {
  inbox: 'bg-muted-foreground',
  accepted: 'bg-blue-400',
  in_progress: 'bg-purple-400',
  pending_review: 'bg-amber-400',
  completed: 'bg-emerald-400',
  cancelled: 'bg-red-400'
}

interface TaskListItemProps {
  task: WorkfloTask
  isSelected: boolean
  onSelect: () => void
}

export function TaskListItem({ task, isSelected, onSelect }: TaskListItemProps) {
  const isActive = task.status !== 'completed' && task.status !== 'cancelled'
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
        <div className={cn('mt-[7px] h-2 w-2 rounded-full shrink-0', statusDotColor[task.status])} />
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
          </div>
        </div>
      </div>
    </button>
  )
}
