import { useCallback } from 'react'
import { TaskWorkspace, type TaskWorkspaceLayout } from '@/components/tasks/TaskWorkspace'
import { useCanvasStore, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT } from '@/stores/canvas-store'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { TaskStatus, PluginActionId } from '@/types'
import type { FileAttachment } from '@/types'

interface TaskPanelContentProps {
  panelId: string
  taskId: string
  /** Controlled layout from CanvasPanel title bar */
  panelLayout?: TaskWorkspaceLayout
}

/**
 * Embeds the full TaskWorkspace inside a canvas panel.
 * Self-contained: fetches its own task from the store and provides all callbacks.
 */
export function TaskPanelContent({ panelId, taskId, panelLayout = 'both' }: TaskPanelContentProps) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))
  const agents = useAgentStore((s) => s.agents)
  const updateTask = useTaskStore((s) => s.updateTask)
  const updatePanel = useCanvasStore((s) => s.updatePanel)
  const addPanel = useCanvasStore((s) => s.addPanel)
  const addEdge = useCanvasStore((s) => s.addEdge)
  const bringToFront = useCanvasStore((s) => s.bringToFront)
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
      const targetTask = useTaskStore.getState().tasks.find((candidate) => candidate.id === tid)
      if (!targetTask) return

      updatePanel(panelId, {
        refId: targetTask.id,
        title: targetTask.title,
      })
      useTaskStore.getState().selectTask(targetTask.id)
    },
    [panelId, updatePanel]
  )

  // Open a subtask as a separate window (a new task panel) on the canvas,
  // rather than replacing the current panel. Positions the new panel to the
  // right of this one and links them with an edge. If the subtask is already
  // open, bring its panel to the front instead of duplicating it.
  const handleOpenSubtaskInWindow = useCallback(
    (tid: string) => {
      const targetTask = useTaskStore.getState().tasks.find((candidate) => candidate.id === tid)
      if (!targetTask) return

      const { panels } = useCanvasStore.getState()

      const existing = panels.find((p) => p.type === 'task' && p.refId === tid)
      if (existing) {
        bringToFront(existing.id)
        return
      }

      const currentPanel = panels.find((p) => p.id === panelId)
      const gap = 40
      const newX = currentPanel ? currentPanel.x + currentPanel.width + gap : 0
      const newY = currentPanel ? currentPanel.y : 0

      const newId = addPanel({
        type: 'task',
        title: targetTask.title,
        refId: targetTask.id,
        x: newX,
        y: newY,
        width: DEFAULT_PANEL_WIDTH,
        height: DEFAULT_PANEL_HEIGHT,
      })

      if (newId) addEdge(panelId, newId)
    },
    [panelId, addPanel, addEdge, bringToFront]
  )

  if (!task) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">
        Task not found or deleted
      </div>
    )
  }

  return (
    <div className="h-full select-text">
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
        onOpenSubtaskInWindow={handleOpenSubtaskInWindow}
        panelLayout={panelLayout}
      />
    </div>
  )
}
