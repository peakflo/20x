import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useArtifactStore } from '@/stores/artifact-store'
import { SETTINGS_TABS, SettingsTab } from '@/types'
import {
  UI_MAX_PUBLISHED_PANELS,
  type UiCommand,
  type UiCommandResult,
  type UiStateSnapshot,
} from '@shared/ui-commands'

/**
 * Applies one UI command from outside the renderer, and reports the screen
 * back out.
 *
 * These are plain functions, not a hook, for two reasons: the stores are read
 * at call time so nothing can hold a stale selection, and the whole surface can
 * be tested without mounting the application.
 *
 * A command is always addressed by task ID. A panel is rebuilt when a session
 * starts, so a panel ID an agent read a moment ago may already have gone.
 */

function findTaskPanel(taskId: string): { id: string } | undefined {
  return useCanvasStore.getState().panels.find((p) => p.type === 'task' && p.refId === taskId)
}

/** Registry ID (`artifactId`) to the tab ID the artifact panel uses. */
function resolveArtifactTabId(taskId: string, artifactId: string): string | null {
  const artifacts = useArtifactStore.getState().getArtifacts(taskId)
  const match =
    artifacts.find((artifact) => artifact.workpieceKey === artifactId) ??
    artifacts.find((artifact) => artifact.id === artifactId)
  return match?.id ?? null
}

function isKnownTask(taskId: string): boolean {
  return useTaskStore.getState().tasks.some((task) => task.id === taskId)
}

function toSettingsTab(value: string | undefined): SettingsTab | null {
  if (!value) return null
  const match = SETTINGS_TABS.find((tab) => tab.value === value)
  return match ? match.value : null
}

export function applyUiCommand(command: UiCommand): UiCommandResult {
  const ui = useUIStore.getState()

  switch (command.kind) {
    case 'navigate': {
      if (command.view === 'settings') {
        const tab = toSettingsTab(command.settingsTab)
        if (tab) ui.setSettingsTab(tab)
        ui.openSettings()
        return { applied: true }
      }
      // The settings pane covers the workspace, so leaving it is part of
      // going anywhere else.
      if (ui.activeModal === 'settings') ui.closeModal()
      ui.setSidebarView(command.view)
      return { applied: true }
    }

    case 'open_task': {
      if (!isKnownTask(command.taskId)) return { applied: false, detail: 'That task is not loaded' }
      useTaskStore.getState().selectTask(command.taskId)

      if (command.where === 'canvas') {
        const existing = findTaskPanel(command.taskId)
        if (ui.activeModal === 'settings') ui.closeModal()
        if (existing) {
          // Already on the canvas: bring the user to it rather than
          // opening a second copy.
          ui.setSidebarView('canvas')
          ui.closeDashboardPreview()
          useCanvasStore.getState().requestViewCommand({ kind: 'focus_task', taskId: command.taskId })
        } else {
          ui.openTaskOnCanvas(command.taskId)
        }
        return { applied: true }
      }

      if (command.where === 'modal') {
        if (ui.activeModal === 'settings') ui.closeModal()
        ui.setSidebarView('dashboard')
        ui.openDashboardPreview(command.taskId)
        return { applied: true }
      }

      if (ui.activeModal === 'settings') ui.closeModal()
      ui.closeDashboardPreview()
      ui.setSidebarView('tasks')
      return { applied: true }
    }

    case 'move_task_panel': {
      const panel = findTaskPanel(command.taskId)
      if (!panel) return { applied: false, detail: 'That task has no panel on the canvas' }
      useCanvasStore.getState().updatePanel(panel.id, { x: command.x, y: command.y })
      return { applied: true }
    }

    case 'close_task_panel': {
      const panel = findTaskPanel(command.taskId)
      if (!panel) return { applied: false, detail: 'That task has no panel on the canvas' }
      useCanvasStore.getState().removePanel(panel.id)
      return { applied: true }
    }

    case 'set_canvas_view': {
      const canvas = useCanvasStore.getState()
      if (command.mode === 'fit_all' && canvas.panels.length === 0) {
        return { applied: false, detail: 'The canvas is empty' }
      }
      canvas.requestViewCommand(
        command.mode === 'zoom'
          ? { kind: 'zoom', zoom: command.zoom ?? 1 }
          : { kind: command.mode }
      )
      // The canvas carries this out with its own rect; if it is not mounted
      // the intent simply waits there.
      if (ui.activeModal === 'settings') ui.closeModal()
      ui.setSidebarView('canvas')
      return { applied: true }
    }

    case 'open_artifact': {
      if (!isKnownTask(command.taskId)) return { applied: false, detail: 'That task is not loaded' }

      // The caller names the artifact by its registry ID. The tab is keyed
      // differently — the registry ID is the workpiece key — so the tab is
      // resolved here rather than making a caller guess at the encoding.
      const tabId = resolveArtifactTabId(command.taskId, command.artifactId)
      if (!tabId) return { applied: false, detail: 'That artifact is not on screen yet' }

      // The artifact panel lives in the task workspace, so that task has to be
      // the open one for the user to see anything.
      useTaskStore.getState().selectTask(command.taskId)
      if (ui.activeModal === 'settings') ui.closeModal()
      if (ui.sidebarView !== 'canvas') ui.setSidebarView('tasks')
      ui.closeDashboardPreview()
      useArtifactStore.getState().openArtifact(command.taskId, tabId)
      return { applied: true }
    }
  }
}

/** The screen, as an agent tool reads it. */
export function collectUiState(): UiStateSnapshot {
  const ui = useUIStore.getState()
  const tasks = useTaskStore.getState()
  const canvas = useCanvasStore.getState()
  const selected = tasks.selectedTaskId
  const session = selected ? useAgentStore.getState().sessions.get(selected) : undefined

  return {
    view: ui.sidebarView,
    modal: ui.activeModal,
    selectedTaskId: selected,
    selectedTaskTitle: tasks.tasks.find((task) => task.id === selected)?.title ?? null,
    dashboardPreviewTaskId: ui.dashboardPreviewTaskId,
    mastermindOpen: ui.showOrchestrator,
    settingsTab: ui.activeModal === 'settings' ? ui.settingsTab : null,
    waitingForYou: Boolean(session?.pendingApproval),
    visibleTaskIds: tasks.tasks.slice(0, 50).map((task) => task.id),
    canvas: {
      viewport: canvas.viewport,
      // Capped: a canvas can hold more panels than a tool reply should carry.
      panels: canvas.panels.slice(0, UI_MAX_PUBLISHED_PANELS).map((panel) => ({
        panelId: panel.id,
        type: panel.type,
        taskId: panel.type === 'task' ? panel.refId ?? null : null,
        title: panel.title,
        x: panel.x,
        y: panel.y,
        width: panel.width,
        height: panel.height,
      })),
    },
  }
}
