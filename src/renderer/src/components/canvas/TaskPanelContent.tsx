import { useCallback } from 'react'
import { TaskWorkspace, type TaskWorkspaceLayout } from '@/components/tasks/TaskWorkspace'
import { useCanvasStore, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT } from '@/stores/canvas-store'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'
import { useTaskCompletion } from '@/hooks/use-task-completion'
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
  // Per-action selectors: a selector-less useStore() subscribes to the whole
  // store, so every ui-store change (modals, filters, sidebar) would re-render
  // every canvas task panel's entire TaskWorkspace tree.
  const openEditModal = useUIStore((s) => s.openEditModal)
  const openDeleteModal = useUIStore((s) => s.openDeleteModal)
  // Source-backed tasks ask whether to close the task in the source system.
  const { requestComplete, completionDialog } = useTaskCompletion()

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
    if (task) await requestComplete(task.id)
  }, [task, requestComplete])

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
      {completionDialog}
    </div>
  )
}
