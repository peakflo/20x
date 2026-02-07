import { Calendar, Bot } from 'lucide-react'
import { cn, formatDate, isOverdue, isDueSoon } from '@/lib/utils'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { useAgentStore } from '@/stores/agent-store'
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
  const { getSessionForTask } = useAgentStore()
  const activeSession = getSessionForTask(task.id)

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
            {task.agent_id && (
              <span className={cn(
                'flex items-center gap-1 text-xs',
                activeSession?.status === 'working' ? 'text-green-400' : 
                activeSession?.status === 'error' ? 'text-red-400' :
                activeSession?.status === 'waiting_approval' ? 'text-yellow-400' :
                'text-muted-foreground'
              )}>
                <Bot className="h-3 w-3" />
                {activeSession?.status === 'working' && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  )
}
