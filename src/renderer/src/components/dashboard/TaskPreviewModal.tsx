import { Calendar, User, Tag, Bot, ExternalLink, Clock, AlertCircle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge'
import { TaskPriorityBadge } from '@/components/tasks/TaskPriorityBadge'
import { TaskTypeBadge } from '@/components/tasks/TaskTypeBadge'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '--'
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function isOverdue(dateStr: string | null): boolean {
  if (!dateStr) return false
  return new Date(dateStr) < new Date()
}

interface TaskPreviewModalProps {
  task: WorkfloTask | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenFullView: (taskId: string) => void
}

export function TaskPreviewModal({ task, open, onOpenChange, onOpenFullView }: TaskPreviewModalProps) {
  if (!task) return null

  const overdue = task.due_date && task.status !== TaskStatus.Completed && isOverdue(task.due_date)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="pr-8 leading-snug">{task.title}</DialogTitle>
          <div className="flex items-center gap-1.5 mt-2">
            <TaskStatusBadge status={task.status as TaskStatus} />
            <TaskPriorityBadge priority={task.priority} />
            {task.type && <TaskTypeBadge type={task.type} />}
          </div>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {/* Description */}
          {task.description && (
            <div>
              <p className="text-sm text-foreground/90 whitespace-pre-wrap">{task.description}</p>
            </div>
          )}

          {/* Details grid */}
          <div className="grid grid-cols-2 gap-3 text-xs">
            {task.assignee && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <User className="h-3.5 w-3.5 shrink-0" />
                <span>{task.assignee}</span>
              </div>
            )}
            {task.due_date && (
              <div className={`flex items-center gap-2 ${overdue ? 'text-red-400' : 'text-muted-foreground'}`}>
                {overdue ? <AlertCircle className="h-3.5 w-3.5 shrink-0" /> : <Calendar className="h-3.5 w-3.5 shrink-0" />}
                <span>{formatDate(task.due_date)}</span>
              </div>
            )}
            {task.agent_id && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Bot className="h-3.5 w-3.5 shrink-0" />
                <span>Agent assigned</span>
              </div>
            )}
            {task.source && task.source !== 'local' && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Tag className="h-3.5 w-3.5 shrink-0" />
                <span>{task.source}</span>
              </div>
            )}
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              <span>Created {formatDate(task.created_at)}</span>
            </div>
          </div>

          {/* Labels */}
          {task.labels && task.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {task.labels.map((label) => (
                <span key={label} className="text-[10px] bg-muted/50 text-muted-foreground px-1.5 py-0.5 rounded">
                  {label}
                </span>
              ))}
            </div>
          )}

          {/* Open full view button */}
          <div className="pt-2 border-t border-border/50">
            <Button
              variant="default"
              size="sm"
              className="w-full"
              onClick={() => {
                onOpenChange(false)
                onOpenFullView(task.id)
              }}
            >
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              Open full view
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
