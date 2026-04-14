import { useMemo } from 'react'
import { useTaskStore } from '@/stores/task-store'
import { TaskStatus } from '@/types'
import { Clock, Tag, User, Flag, Calendar, GitBranch, FileText } from 'lucide-react'
import { formatRelativeDate } from '@/lib/utils'

interface TaskPanelContentProps {
  taskId: string
}

const STATUS_COLORS: Record<string, string> = {
  [TaskStatus.NotStarted]: 'bg-gray-500/20 text-gray-400',
  [TaskStatus.Triaging]: 'bg-slate-500/20 text-slate-400',
  [TaskStatus.AgentWorking]: 'bg-amber-500/20 text-amber-400',
  [TaskStatus.ReadyForReview]: 'bg-purple-500/20 text-purple-400',
  [TaskStatus.AgentLearning]: 'bg-blue-500/20 text-blue-400',
  [TaskStatus.Completed]: 'bg-green-500/20 text-green-400',
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-yellow-400',
  low: 'text-gray-400',
}

function statusLabel(status: string): string {
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function TaskPanelContent({ taskId }: TaskPanelContentProps) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))

  const subtasks = useTaskStore((s) =>
    s.tasks.filter((t) => t.parent_task_id === taskId)
  )

  const completedSubtasks = useMemo(
    () => subtasks.filter((t) => t.status === TaskStatus.Completed),
    [subtasks]
  )

  if (!task) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">
        Task not found
      </div>
    )
  }

  return (
    <div className="space-y-3 text-xs">
      {/* Status + Priority row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_COLORS[task.status] || 'bg-muted/30 text-muted-foreground'}`}
        >
          {statusLabel(task.status)}
        </span>
        {task.priority && (
          <span className={`flex items-center gap-1 ${PRIORITY_COLORS[task.priority] || 'text-muted-foreground'}`}>
            <Flag className="h-3 w-3" />
            <span className="capitalize text-[10px]">{task.priority}</span>
          </span>
        )}
        <span className="text-[10px] text-muted-foreground/60 capitalize">
          {task.type}
        </span>
      </div>

      {/* Description */}
      {task.description && (
        <p className="text-muted-foreground/80 leading-relaxed line-clamp-4">
          {task.description}
        </p>
      )}

      {/* Meta info */}
      <div className="space-y-1.5 text-muted-foreground/60">
        {task.assignee && (
          <div className="flex items-center gap-1.5">
            <User className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{task.assignee}</span>
          </div>
        )}
        {task.due_date && (
          <div className="flex items-center gap-1.5">
            <Calendar className="h-3 w-3 flex-shrink-0" />
            <span>{formatRelativeDate(task.due_date)}</span>
          </div>
        )}
        {task.repos && task.repos.length > 0 && (
          <div className="flex items-center gap-1.5">
            <GitBranch className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{task.repos[0]}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Clock className="h-3 w-3 flex-shrink-0" />
          <span>Updated {formatRelativeDate(task.updated_at)}</span>
        </div>
      </div>

      {/* Labels */}
      {task.labels && task.labels.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <Tag className="h-3 w-3 text-muted-foreground/40 flex-shrink-0" />
          {task.labels.slice(0, 5).map((label) => (
            <span
              key={label}
              className="px-1.5 py-0.5 rounded text-[10px] bg-muted/30 text-muted-foreground/70"
            >
              {label}
            </span>
          ))}
          {task.labels.length > 5 && (
            <span className="text-[10px] text-muted-foreground/40">
              +{task.labels.length - 5}
            </span>
          )}
        </div>
      )}

      {/* Subtasks progress */}
      {subtasks.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-muted-foreground/60">
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3" />
              Subtasks
            </span>
            <span>
              {completedSubtasks.length}/{subtasks.length}
            </span>
          </div>
          <div className="h-1 rounded-full bg-muted/20 overflow-hidden">
            <div
              className="h-full rounded-full bg-green-500/60 transition-all duration-300"
              style={{
                width: `${(completedSubtasks.length / subtasks.length) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Resolution */}
      {task.resolution && (
        <div className="border-t border-border/20 pt-2">
          <div className="text-[10px] text-muted-foreground/40 uppercase font-medium mb-1">
            Resolution
          </div>
          <p className="text-muted-foreground/70 line-clamp-3 leading-relaxed">
            {task.resolution}
          </p>
        </div>
      )}
    </div>
  )
}
