import { describe, it, expect, beforeEach, vi } from 'vitest'

// The stores subscribe to IPC as they load, so only the two calls this file
// would really make are replaced.
const ipc = vi.hoisted(() => ({
  persistedCanvas: null as string | null,
  // Tasks in the database that the window has not loaded (completed history).
  database: new Map<string, { id: string; title: string; status: string; parent_task_id?: string }>(),
}))

vi.mock('@/lib/ipc-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/ipc-client')>()
  return {
    ...original,
    settingsApi: { get: vi.fn(async () => ipc.persistedCanvas), set: vi.fn(async () => undefined) },
    taskApi: { ...original.taskApi, getById: vi.fn(async (id: string) => ipc.database.get(id) ?? null) },
  }
})

import { applyUiCommand, collectUiState, UI_VIEW_COMMAND_TIMEOUT_MS } from './ui-remote-control'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useArtifactStore } from '@/stores/artifact-store'
import { SettingsTab } from '@/types'
import { ArtifactType } from '@shared/artifacts'

/**
 * Driving the window from an agent command.
 *
 * The rule these tests protect: a command names a task, never a panel. A panel
 * is rebuilt when a session starts, so a panel ID read a moment ago may be gone
 * — and the settings pane covers the workspace, so leaving it is part of going
 * anywhere else.
 */

function seedTasks(): void {
  useTaskStore.setState({
    tasks: [
      { id: 't1', title: 'Fix login' },
      { id: 't2', title: 'Release notes' },
    ] as never,
    selectedTaskId: null,
  })
}

/**
 * Stands in for the mounted InfiniteCanvas: runs each queued viewport change
 * against an 800×600 container and reports it done, as the real effect does.
 */
let canvasMounted = true
function mountFakeCanvas(): () => void {
  return useCanvasStore.subscribe(
    (s) => s.pendingViewCommand,
    (command) => {
      if (!command || !canvasMounted) return
      const canvas = useCanvasStore.getState()
      let applied = true
      if (command.kind === 'fit_all') canvas.fitToContent(800, 600)
      else if (command.kind === 'reset') canvas.resetViewport()
      else if (command.kind === 'zoom') canvas.zoomTo(command.zoom, 400, 300)
      else {
        const target = canvas.panels.find((p) => p.type === 'task' && p.refId === command.taskId)
        if (target) canvas.focusPanel(target.id, 800, 600)
        applied = Boolean(target)
      }
      canvas.clearViewCommand(applied)
    }
  )
}

function addTaskPanel(taskId: string, x = 0, y = 0): string {
  return useCanvasStore.getState().addPanel({
    type: 'task',
    title: taskId,
    refId: taskId,
    x,
    y,
    width: 100,
    height: 100,
  })
}

let unmountCanvas: (() => void) | null = null

beforeEach(() => {
  vi.useRealTimers()
  ipc.persistedCanvas = null
  ipc.database.clear()
  canvasMounted = true
  unmountCanvas?.()
  unmountCanvas = mountFakeCanvas()
  seedTasks()
  useUIStore.setState({
    sidebarView: 'dashboard',
    activeModal: null,
    dashboardPreviewTaskId: null,
    canvasPendingTaskId: null,
    settingsTab: SettingsTab.GENERAL,
    showOrchestrator: false,
  })
  useCanvasStore.setState({ panels: [], edges: [], pendingViewCommand: null, viewport: { x: 0, y: 0, zoom: 1 }, isLoaded: true })
  useArtifactStore.setState({ artifactsByTask: {}, uiByTask: {} })
})

describe('navigate', () => {
  it('switches view', async () => {
    expect(await applyUiCommand({ kind: 'navigate', view: 'canvas' })).toEqual({ applied: true })
    expect(useUIStore.getState().sidebarView).toBe('canvas')
  })

  it('leaves settings behind — it covers the workspace', async () => {
    useUIStore.getState().openSettings()
    await applyUiCommand({ kind: 'navigate', view: 'tasks' })
    expect(useUIStore.getState().activeModal).toBeNull()
    expect(useUIStore.getState().sidebarView).toBe('tasks')
  })

  it('opens settings on the tab that was asked for, and refuses one that does not exist', async () => {
    await applyUiCommand({ kind: 'navigate', view: 'settings', settingsTab: 'voice' })
    expect(useUIStore.getState().activeModal).toBe('settings')
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.VOICE)

    const result = await applyUiCommand({ kind: 'navigate', view: 'settings', settingsTab: 'not-a-tab' })
    expect(result.applied).toBe(false)
    expect(result.detail).toMatch(/Unknown settings_tab "not-a-tab".*voice/)
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.VOICE)
  })
})

describe('open_task', () => {
  it('opens the full view and closes the dashboard dialog', async () => {
    useUIStore.getState().openDashboardPreview('t2')
    await applyUiCommand({ kind: 'open_task', taskId: 't1', where: 'workspace' })
    const ui = useUIStore.getState()
    expect(ui.sidebarView).toBe('tasks')
    expect(ui.dashboardPreviewTaskId).toBeNull()
    expect(useTaskStore.getState().selectedTaskId).toBe('t1')
  })

  it('opens the dashboard dialog', async () => {
    await applyUiCommand({ kind: 'open_task', taskId: 't1', where: 'modal' })
    expect(useUIStore.getState().dashboardPreviewTaskId).toBe('t1')
    expect(useUIStore.getState().sidebarView).toBe('dashboard')
  })

  it('adds a canvas panel when the task has none, in the store, and centres it', async () => {
    expect(await applyUiCommand({ kind: 'open_task', taskId: 't1', where: 'canvas' })).toEqual({ applied: true })
    const ui = useUIStore.getState()
    expect(ui.sidebarView).toBe('canvas')
    // Added directly — the canvas's pending-task queue runs on a later render
    // and dropped tasks it could not find.
    expect(ui.canvasPendingTaskId).toBeNull()
    const panels = useCanvasStore.getState().panels
    expect(panels.map((p) => p.refId)).toEqual(['t1'])
    expect(useCanvasStore.getState().selectedPanelId).toBe(panels[0].id)
    // focus_task ran: the panel's centre is the container's centre.
    const { viewport } = useCanvasStore.getState()
    const p = panels[0]
    expect((p.x + p.width / 2) * viewport.zoom + viewport.x).toBeCloseTo(400)
    expect((p.y + p.height / 2) * viewport.zoom + viewport.y).toBeCloseTo(300)
    // …and the very next screen read shows it.
    const state = collectUiState()
    expect(state.canvas.panels.map((panel) => panel.taskId)).toContain('t1')
    expect(state.visibleTaskIds).toContain('t1')
    expect(state.selectedTaskId).toBe('t1')
  })

  it('centres the existing panel instead of opening a second copy', async () => {
    addTaskPanel('t1', 5000, 5000)
    expect(await applyUiCommand({ kind: 'open_task', taskId: 't1', where: 'canvas' })).toEqual({ applied: true })
    expect(useUIStore.getState().canvasPendingTaskId).toBeNull()
    expect(useCanvasStore.getState().panels).toHaveLength(1)
    expect(useCanvasStore.getState().viewport.x).toBeLessThan(0)
  })

  it('opens a completed task (a subtask, here) that the window has not loaded', async () => {
    // The 2026-10-19 report: task_1791891595442_vdt8ha9 is a completed
    // subtask, so it was not in the working set and was refused silently.
    ipc.database.set('done-sub', { id: 'done-sub', title: 'Old subtask', status: 'completed', parent_task_id: 't1' })
    expect(await applyUiCommand({ kind: 'open_task', taskId: 'done-sub', where: 'canvas' })).toEqual({ applied: true })
    expect(useCanvasStore.getState().panels.map((p) => p.refId)).toEqual(['done-sub'])
    expect(useTaskStore.getState().selectedTaskId).toBe('done-sub')
    const state = collectUiState()
    expect(state.visibleTaskIds[0]).toBe('done-sub')
    expect(state.selectedTaskTitle).toBe('Old subtask')
  })

  it('keeps a panel added before the canvas first loaded its saved layout', async () => {
    useCanvasStore.setState({ isLoaded: false })
    ipc.persistedCanvas = JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 },
      panels: [{ id: 'panel-1-1', type: 'task', title: 't2', refId: 't2', x: 0, y: 0, width: 100, height: 100, zIndex: 1 }],
      edges: [],
      nextZIndex: 2,
    })
    await applyUiCommand({ kind: 'open_task', taskId: 't1', where: 'canvas' })
    expect(useCanvasStore.getState().panels.map((p) => p.refId)).toEqual(['t2', 't1'])
  })

  it('says so when the canvas cannot centre the panel', async () => {
    vi.useFakeTimers()
    canvasMounted = false
    const pending = applyUiCommand({ kind: 'open_task', taskId: 't1', where: 'canvas' })
    await vi.advanceTimersByTimeAsync(UI_VIEW_COMMAND_TIMEOUT_MS + 1)
    expect((await pending).applied).toBe(false)
  })

  it('refuses a task that does not exist anywhere', async () => {
    expect(await applyUiCommand({ kind: 'open_task', taskId: 'ghost', where: 'workspace' })).toEqual({
      applied: false,
      detail: expect.stringMatching(/could not load that task/),
    })
    expect(useUIStore.getState().sidebarView).toBe('dashboard')
  })
})

describe('canvas panels', () => {
  it('moves the panel of a task', async () => {
    const id = addTaskPanel('t1', 10, 10)
    expect(await applyUiCommand({ kind: 'move_task_panel', taskId: 't1', x: 400, y: -50 })).toEqual({ applied: true })
    const panel = useCanvasStore.getState().panels.find((p) => p.id === id)
    expect([panel?.x, panel?.y]).toEqual([400, -50])
  })

  it('closes the panel of a task and leaves the others', async () => {
    addTaskPanel('t1')
    addTaskPanel('t2')
    await applyUiCommand({ kind: 'close_task_panel', taskId: 't1' })
    expect(useCanvasStore.getState().panels.map((p) => p.refId)).toEqual(['t2'])
  })

  it('reports when a task has no panel rather than acting on another', async () => {
    addTaskPanel('t2')
    expect((await applyUiCommand({ kind: 'move_task_panel', taskId: 't1', x: 0, y: 0 })).applied).toBe(false)
    expect((await applyUiCommand({ kind: 'close_task_panel', taskId: 't1' })).applied).toBe(false)
    expect(useCanvasStore.getState().panels).toHaveLength(1)
  })

  it('fits every panel and shows the canvas', async () => {
    addTaskPanel('t1', 0, 0)
    addTaskPanel('t2', 3000, 2000)
    expect(await applyUiCommand({ kind: 'set_canvas_view', mode: 'fit_all' })).toEqual({ applied: true })
    expect(useUIStore.getState().sidebarView).toBe('canvas')
    const { viewport } = useCanvasStore.getState()
    expect(viewport.zoom).toBeLessThan(1)
    // The bounding box (0,0)-(3100,2100) is centred in the 800×600 container.
    expect(1550 * viewport.zoom + viewport.x).toBeCloseTo(400)
    expect(1050 * viewport.zoom + viewport.y).toBeCloseTo(300)
  })

  it('fails a viewport change the canvas never carries out', async () => {
    vi.useFakeTimers()
    canvasMounted = false
    addTaskPanel('t1')
    const pending = applyUiCommand({ kind: 'set_canvas_view', mode: 'fit_all' })
    await vi.advanceTimersByTimeAsync(UI_VIEW_COMMAND_TIMEOUT_MS + 1)
    expect(await pending).toEqual({ applied: false, detail: expect.stringMatching(/did not apply the view change/) })
  })

  it('does not send the user to an empty canvas to fit nothing', async () => {
    expect(await applyUiCommand({ kind: 'set_canvas_view', mode: 'fit_all' })).toEqual({
      applied: false,
      detail: 'The canvas is empty',
    })
    expect(useUIStore.getState().sidebarView).toBe('dashboard')
  })
})

describe('open_artifact', () => {
  beforeEach(() => {
    useArtifactStore.getState().upsertArtifact({
      taskId: 't1',
      type: ArtifactType.MARKDOWN,
      title: 'Design',
      path: 'artifacts/art-1/design.md',
      workpieceKey: 'art-1',
      updatedAt: 1,
    } as never)
  })

  it('opens the tab named by the registry ID, not by the tab ID', async () => {
    // The caller knows `art-1`; the tab is keyed on the task and the workpiece.
    expect(await applyUiCommand({ kind: 'open_artifact', taskId: 't1', artifactId: 'art-1' })).toEqual({ applied: true })
    const ui = useArtifactStore.getState().getUI('t1')
    expect(ui.open).toBe(true)
    expect(ui.activeTabId).toBe(useArtifactStore.getState().getArtifacts('t1')[0].id)
    expect(useTaskStore.getState().selectedTaskId).toBe('t1')
    expect(useUIStore.getState().sidebarView).toBe('tasks')
  })

  it('says so when the artifact has not reached the window yet', async () => {
    expect(await applyUiCommand({ kind: 'open_artifact', taskId: 't1', artifactId: 'art-9' })).toEqual({
      applied: false,
      detail: 'That artifact is not on screen yet',
    })
  })
})

describe('collectUiState', () => {
  it('reports the canvas, so an agent can move a panel without guessing', async () => {
    addTaskPanel('t1', 30, 40)
    useCanvasStore.getState().setViewport({ x: -100, y: 20, zoom: 0.5 })
    const state = collectUiState()
    expect(state.canvas.viewport).toEqual({ x: -100, y: 20, zoom: 0.5 })
    expect(state.canvas.panels).toEqual([
      expect.objectContaining({ taskId: 't1', x: 30, y: 40, type: 'task' }),
    ])
  })

  it('reports the open task and the screen it is on', async () => {
    useTaskStore.getState().selectTask('t1')
    useUIStore.getState().setSidebarView('tasks')
    const state = collectUiState()
    expect(state).toMatchObject({ view: 'tasks', selectedTaskId: 't1', selectedTaskTitle: 'Fix login' })
  })
})
