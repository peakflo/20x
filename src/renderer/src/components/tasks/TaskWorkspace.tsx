import { LayoutList } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { TaskDetailView } from './TaskDetailView'
import type { WorkfloTask, ChecklistItem, FileAttachment } from '@/types'

interface TaskWorkspaceProps {
  task?: WorkfloTask
  onEdit: () => void
  onDelete: () => void
  onUpdateChecklist: (checklist: ChecklistItem[]) => void
  onUpdateAttachments: (attachments: FileAttachment[]) => void
}

export function TaskWorkspace({ task, onEdit, onDelete, onUpdateChecklist, onUpdateAttachments }: TaskWorkspaceProps) {
  if (!task) {
    return (
      <div className="flex items-center justify-center h-full">
        <EmptyState
          icon={LayoutList}
          title="No task selected"
          description="Select a task from the sidebar to view its details, or create a new one"
        />
      </div>
    )
  }

  return (
    <TaskDetailView
      task={task}
      onEdit={onEdit}
      onDelete={onDelete}
      onUpdateChecklist={onUpdateChecklist}
      onUpdateAttachments={onUpdateAttachments}
    />
  )
}
