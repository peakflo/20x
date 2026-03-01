import type { Task } from '../stores/task-store'
import { TaskStatusDot } from './TaskStatusDot'
import { PriorityBadge } from './PriorityBadge'
import { formatRelativeDate, isOverdue } from '../lib/utils'

interface TaskListItemProps {
  task: Task
  onSelect: () => void
  hasActiveSession?: boolean
}

export function TaskListItem({ task, onSelect, hasActiveSession }: TaskListItemProps) {
  const overdue = isOverdue(task.due_date)

  return (
    <button
      onClick={onSelect}
      className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-accent/60 transition-colors border-b border-border/30"
    >
      <TaskStatusDot status={task.status} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">{task.title}</span>
          {hasActiveSession && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {task.due_date && (
            <span className={`text-[10px] ${overdue ? 'text-red-400' : 'text-muted-foreground'}`}>
              {new Date(task.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          )}
          {task.source !== 'local' && (
            <span className="text-[10px] text-muted-foreground bg-muted px-1 rounded">{task.source}</span>
          )}
          <span className="text-[10px] text-muted-foreground">{formatRelativeDate(task.updated_at)}</span>
        </div>
      </div>

      <PriorityBadge priority={task.priority} />
    </button>
  )
}
