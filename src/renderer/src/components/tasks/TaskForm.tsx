import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Label } from '@/components/ui/Label'
import { TaskAttachments, type PendingFile } from './TaskAttachments'
import { OutputFieldsEditor } from './OutputFieldsEditor'
import { TaskStatus, TASK_TYPES, TASK_PRIORITIES, TASK_STATUSES } from '@/types'
import type {
  WorkfloTask,
  CreateTaskDTO,
  UpdateTaskDTO,
  FileAttachment,
  OutputField,
  TaskType,
  TaskPriority
} from '@/types'

export interface TaskFormSubmitData extends CreateTaskDTO {
  _pendingFiles?: PendingFile[]
}

interface TaskFormProps {
  task?: WorkfloTask
  onSubmit: (data: TaskFormSubmitData | UpdateTaskDTO) => Promise<void>
  onCancel: () => void
}

export function TaskForm({ task, onSubmit, onCancel }: TaskFormProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<TaskType>('general')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [status, setStatus] = useState<TaskStatus>(TaskStatus.NotStarted)
  const [assignee, setAssignee] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [labels, setLabels] = useState('')
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [outputFields, setOutputFields] = useState<OutputField[]>([])
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (task) {
      setTitle(task.title)
      setDescription(task.description)
      setType(task.type)
      setPriority(task.priority)
      setStatus(task.status)
      setAssignee(task.assignee)
      setDueDate(task.due_date ? task.due_date.slice(0, 10) : '')
      setLabels(task.labels.join(', '))
      setAttachments(task.attachments)
      setOutputFields(task.output_fields)
    }
  }, [task])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return

    setIsSubmitting(true)
    try {
      const parsedLabels = labels
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean)

      const formData: TaskFormSubmitData = {
        title: title.trim(),
        description,
        type,
        priority,
        status,
        assignee,
        due_date: dueDate ? new Date(dueDate).toISOString() : null,
        labels: parsedLabels,
        attachments,
        output_fields: outputFields
      }

      if (!task && pendingFiles.length > 0) {
        formData._pendingFiles = pendingFiles
      }

      await onSubmit(formData)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs to be done?"
          required
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add details, context, or notes..."
          rows={3}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="type">Type</Label>
          <Select id="type" value={type} onChange={(e) => setType(e.target.value as TaskType)} options={TASK_TYPES} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="priority">Priority</Label>
          <Select id="priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} options={TASK_PRIORITIES} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="status">Status</Label>
          <Select id="status" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)} options={TASK_STATUSES} />
        </div>
        {task?.source_id && (
          <div className="space-y-2">
            <Label htmlFor="assignee">Assignee</Label>
            <p className="text-sm text-muted-foreground py-1">{assignee || 'Unassigned'}</p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="dueDate">Due Date</Label>
          <Input id="dueDate" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="labels">Labels</Label>
          <Input id="labels" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="bug, feature..." />
        </div>
      </div>

      <div className="rounded-md border p-4">
        <TaskAttachments
          items={attachments}
          onChange={setAttachments}
          taskId={task?.id ?? null}
          pendingFiles={pendingFiles}
          onPendingChange={setPendingFiles}
        />
      </div>

      <div className="rounded-md border p-4">
        <OutputFieldsEditor fields={outputFields} onChange={setOutputFields} />
      </div>

      <div className="flex justify-end gap-3 pt-4 border-t">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={!title.trim() || isSubmitting}>
          {isSubmitting ? 'Saving...' : task ? 'Save Changes' : 'Create Task'}
        </Button>
      </div>
    </form>
  )
}
