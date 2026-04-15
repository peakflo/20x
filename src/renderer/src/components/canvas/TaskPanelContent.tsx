import { useCallback } from 'react'
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { TaskStatus, PluginActionId } from '@/types'
import type { FileAttachment } from '@/types'

interface TaskPanelContentProps {
  taskId: string
}

/**
 * Embeds the full TaskWorkspace inside a canvas panel.
 * Self-contained: fetches its own task from the store and provides all callbacks.
 */
export function TaskPanelContent({ taskId }: TaskPanelContentProps) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))
  const agents = useAgentStore((s) => s.agents)
  const updateTask = useTaskStore((s) => s.updateTask)
  const { executeAction } = useTaskSourceStore()
  const { openEditModal, openDeleteModal } = useUIStore()

  const handleEdit = useCallback(() => {
    if (task) openEditModal(task.id)
  }, [task, openEditModal])

  const handleDelete = useCallback(() => {
    if (task) openDeleteModal(task.id)
  }, [task, openDeleteModal])

  const handleUpdateAttachments = useCallback(
    async (attachments: FileAttachment[]) => {
      if (task) await updateTask(task.id, { attachments })
    },
    [task, updateTask]
  )

  const handleUpdateOutputFields = useCallback(
    async (output_fields: unknown[]) => {
      if (task) await updateTask(task.id, { output_fields } as Record<string, unknown>)
    },
    [task, updateTask]
  )

  const handleCompleteTask = useCallback(async () => {
    if (!task) return
    try {
      if (task.source_id) {
        const actionField = task.output_fields.find((f) => f.id === 'action')
        const actionValue = actionField?.value ? String(actionField.value) : PluginActionId.Complete
        const result = await executeAction(actionValue, task.id, task.source_id)
        if (!result.success) return
      }
      await updateTask(task.id, { status: TaskStatus.Completed })
    } catch (err) {
      console.error('Failed to complete task:', err)
    }
  }, [task, updateTask, executeAction])

  const handleAssignAgent = useCallback(
    async (tid: string, agentId: string | null) => {
      await updateTask(tid, { agent_id: agentId })
    },
    [updateTask]
  )

  const handleUpdateTask = useCallback(
    async (tid: string, data: Record<string, unknown>) => {
      await updateTask(tid, data)
    },
    [updateTask]
  )

  const handleNavigateToTask = useCallback(
    (tid: string) => {
      // In canvas context, selecting a task just updates the sidebar selection
      useTaskStore.getState().selectTask(tid)
    },
    []
  )

  if (!task) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">
        Task not found or deleted
      </div>
    )
  }

  return (
    <TaskWorkspace
      task={task}
      agents={agents}
      onEdit={handleEdit}
      onDelete={handleDelete}
      onUpdateAttachments={handleUpdateAttachments}
      onUpdateOutputFields={handleUpdateOutputFields}
      onCompleteTask={handleCompleteTask}
      onAssignAgent={handleAssignAgent}
      onUpdateTask={handleUpdateTask}
      onNavigateToTask={handleNavigateToTask}
    />
  )
}
