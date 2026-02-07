import { Pencil, Trash2, Calendar, User, Tag, Clock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { TaskStatusBadge } from './TaskStatusBadge'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskTypeBadge } from './TaskTypeBadge'
import { TaskChecklist } from './TaskChecklist'
import { TaskAttachments } from './TaskAttachments'
import { Badge } from '@/components/ui/Badge'
import { formatDate, formatRelativeDate, isOverdue, isDueSoon } from '@/lib/utils'
import type { WorkfloTask, ChecklistItem, FileAttachment } from '@/types'

interface TaskDetailViewProps {
  task: WorkfloTask
  onEdit: () => void
  onDelete: () => void
  onUpdateChecklist: (checklist: ChecklistItem[]) => void
  onUpdateAttachments: (attachments: FileAttachment[]) => void
}

export function TaskDetailView({ task, onEdit, onDelete, onUpdateChecklist, onUpdateAttachments }: TaskDetailViewProps) {
  const isActive = task.status !== 'completed' && task.status !== 'cancelled'
  const overdue = isActive && isOverdue(task.due_date)
  const dueSoon = isActive && !overdue && isDueSoon(task.due_date)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-6 py-4 shrink-0">
        <div className="flex items-center gap-2.5">
          <TaskStatusBadge status={task.status} />
          <TaskTypeBadge type={task.type} />
          <TaskPriorityBadge priority={task.priority} />
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-8 space-y-6">
          <div>
            <h1 className="text-xl font-semibold">{task.title}</h1>
            {task.description && (
              <p className="mt-3 text-sm text-muted-foreground whitespace-pre-wrap">{task.description}</p>
            )}
          </div>

          <div className="grid grid-cols-[auto_1fr] gap-x-10 gap-y-4 text-sm">
            {task.assignee && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><User className="h-3.5 w-3.5" /> Assignee</span>
                <span>{task.assignee}</span>
              </>
            )}
            {task.due_date && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><Calendar className="h-3.5 w-3.5" /> Due date</span>
                <span className={overdue ? 'text-destructive' : dueSoon ? 'text-amber-400' : ''}>
                  {formatDate(task.due_date)}
                  {overdue && <Badge variant="red" className="ml-2">Overdue</Badge>}
                  {dueSoon && <Badge variant="yellow" className="ml-2">Due soon</Badge>}
                </span>
              </>
            )}
            <span className="text-muted-foreground flex items-center gap-2"><Clock className="h-3.5 w-3.5" /> Created</span>
            <span className="text-muted-foreground">{formatRelativeDate(task.created_at)}</span>
            <span className="text-muted-foreground flex items-center gap-2"><Clock className="h-3.5 w-3.5" /> Updated</span>
            <span className="text-muted-foreground">{formatRelativeDate(task.updated_at)}</span>
          </div>

          {task.labels.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Tag className="h-3.5 w-3.5" /> Labels
              </div>
              <div className="flex flex-wrap gap-1.5">
                {task.labels.map((label) => (
                  <Badge key={label} variant="blue">{label}</Badge>
                ))}
              </div>
            </div>
          )}

          {task.checklist.length > 0 && (
            <div className="rounded-md border p-4">
              <TaskChecklist items={task.checklist} onChange={onUpdateChecklist} />
            </div>
          )}

          {task.attachments.length > 0 && (
            <div className="rounded-md border p-4">
              <TaskAttachments
                items={task.attachments}
                onChange={onUpdateAttachments}
                taskId={task.id}
              />
            </div>
          )}

          <div className="pt-2 border-t text-xs text-muted-foreground">
            Source: <Badge className="ml-1">{task.source}</Badge>
          </div>
        </div>
      </div>
    </div>
  )
}
