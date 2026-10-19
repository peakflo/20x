import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { useCanvasStore, DEFAULT_PANEL_HEIGHT, DEFAULT_PANEL_WIDTH, type CanvasViewCommand } from '@/stores/canvas-store'
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

/**
 * How long a command waits for the canvas to carry out a viewport change. The
 * canvas may have to mount first (the command can switch to it). Shorter than
 * the main-process timeout, so the window answers with a reason of its own.
 */
export const UI_VIEW_COMMAND_TIMEOUT_MS = 3000

/**
 * The task, loading it if the window does not have it yet.
 *
 * The window only holds open tasks and the completed ones already paged in, so
 * a completed task (or a completed subtask) is usually absent. Refusing those
 * made `open_task` a silent no-op for most of a user's history.
 */
async function loadTask(taskId: string): Promise<boolean> {
  if (useTaskStore.getState().tasks.some((task) => task.id === taskId)) return true
  const task = await useTaskStore.getState().ensureTask(taskId)
  return Boolean(task)
}

/**
 * Queues a viewport change and waits for the canvas to report it done. False
 * when the canvas could not do it, or did not get to it in time.
 */
async function runViewCommand(command: CanvasViewCommand): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), UI_VIEW_COMMAND_TIMEOUT_MS)
  })
  try {
    return await Promise.race([useCanvasStore.getState().requestViewCommand(command), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The canvas restores its panels on first mount; adding one before that would be overwritten. */
async function ensureCanvasLoaded(): Promise<void> {
  const canvas = useCanvasStore.getState()
  if (!canvas.isLoaded) await canvas.loadCanvas()
}

/**
 * Puts a panel for the task at the centre of what the canvas shows, right now
 * in the store — not through the canvas's "pending task" queue, which runs on
 * a later render and quietly drops a task it cannot find.
 */
function addTaskPanelAtViewportCentre(taskId: string): string {
  const canvas = useCanvasStore.getState()
  const task = useTaskStore.getState().tasks.find((t) => t.id === taskId)
  const vp = canvas.viewport
  const width = typeof window !== 'undefined' ? window.innerWidth : 0
  const height = typeof window !== 'undefined' ? window.innerHeight : 0
  const zoom = vp.zoom > 0 ? vp.zoom : 1
  const offset = (canvas.panels.length % 5) * 30
  return canvas.addPanel({
    type: 'task',
    title: task?.title ?? taskId,
    refId: taskId,
    x: (width / 2 - vp.x) / zoom - DEFAULT_PANEL_WIDTH / 2 + offset,
    y: (height / 2 - vp.y) / zoom - DEFAULT_PANEL_HEIGHT / 2 + offset,
    width: DEFAULT_PANEL_WIDTH,
    height: DEFAULT_PANEL_HEIGHT,
  })
}

function toSettingsTab(value: string | undefined): SettingsTab | null {
  if (!value) return null
  const match = SETTINGS_TABS.find((tab) => tab.value === value)
  return match ? match.value : null
}

/**
 * Applies one command and resolves with what really happened. The result is
 * sent back to main, which reports it as the tool result — so `applied: true`
 * must mean the screen changed, not that the command arrived.
 */
export async function applyUiCommand(command: UiCommand): Promise<UiCommandResult> {
  const ui = useUIStore.getState()

  switch (command.kind) {
    case 'navigate': {
      if (command.view === 'settings') {
        const tab = toSettingsTab(command.settingsTab)
        if (command.settingsTab && !tab) {
          return {
            applied: false,
            detail: `Unknown settings_tab "${command.settingsTab}". Use one of: ${SETTINGS_TABS.map((t) => t.value).join(', ')}`,
          }
        }
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
      if (!(await loadTask(command.taskId))) return { applied: false, detail: 'The 20x window could not load that task. Check the task_id with get_task.' }
      useTaskStore.getState().selectTask(command.taskId)

      if (command.where === 'canvas') {
        await ensureCanvasLoaded()
        if (ui.activeModal === 'settings') ui.closeModal()
        ui.closeDashboardPreview()
        let panelId = findTaskPanel(command.taskId)?.id
        if (!panelId) panelId = addTaskPanelAtViewportCentre(command.taskId)
        useCanvasStore.getState().setSelectedPanelId(panelId)
        ui.setSidebarView('canvas')
        // Centre it. The panel is already in the store, so it is on the canvas
        // either way; failing to centre is reported, not hidden.
        if (!(await runViewCommand({ kind: 'focus_task', taskId: command.taskId }))) {
          return { applied: false, detail: 'The panel is on the canvas, but the canvas could not centre it (the 20x window may be minimised). Call get_ui_state for its position.' }
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
      if (!panel) return { applied: false, detail: 'That task has no panel on the canvas. Call open_task with where="canvas" first.' }
      useCanvasStore.getState().updatePanel(panel.id, { x: command.x, y: command.y })
      return { applied: true }
    }

    case 'close_task_panel': {
      const panel = findTaskPanel(command.taskId)
      if (!panel) return { applied: false, detail: 'That task has no panel on the canvas, so there is nothing to close.' }
      useCanvasStore.getState().removePanel(panel.id)
      return { applied: true }
    }

    case 'set_canvas_view': {
      await ensureCanvasLoaded()
      if (command.mode === 'fit_all' && useCanvasStore.getState().panels.length === 0) {
        return { applied: false, detail: 'The canvas is empty' }
      }
      // The canvas carries this out with its own rect, so it has to be shown.
      if (ui.activeModal === 'settings') ui.closeModal()
      ui.setSidebarView('canvas')
      const applied = await runViewCommand(
        command.mode === 'zoom'
          ? { kind: 'zoom', zoom: command.zoom ?? 1 }
          : { kind: command.mode }
      )
      return applied ? { applied: true } : { applied: false, detail: 'The canvas did not apply the view change (the 20x window may be minimised). Call get_ui_state to see the current viewport.' }
    }

    case 'open_artifact': {
      if (!(await loadTask(command.taskId))) return { applied: false, detail: 'The 20x window could not load that task. Check the task_id with get_task.' }

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

/**
 * Task IDs on screen, most relevant first: the selected task and every task
 * with a canvas panel, then the rest of the loaded list. Capped like the panels.
 * Without the first two, a task opened from history sat past the cap and an
 * agent could not see that it had been opened.
 */
function listVisibleTaskIds(
  loaded: Array<{ id: string }>,
  selected: string | null,
  panels: Array<{ type: string; refId?: string | null }>
): string[] {
  const ids = new Set<string>()
  if (selected) ids.add(selected)
  for (const panel of panels) {
    if (panel.type === 'task' && panel.refId) ids.add(panel.refId)
  }
  for (const task of loaded) ids.add(task.id)
  return [...ids].slice(0, UI_MAX_PUBLISHED_PANELS)
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
    visibleTaskIds: listVisibleTaskIds(tasks.tasks, selected, canvas.panels),
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
