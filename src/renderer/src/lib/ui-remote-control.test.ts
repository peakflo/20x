import { describe, it, expect, beforeEach, vi } from 'vitest'

// The stores subscribe to IPC as they load, so only the two calls this file
// would really make are replaced.
vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
}))

import { applyUiCommand, collectUiState } from './ui-remote-control'
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

beforeEach(() => {
  seedTasks()
  useUIStore.setState({
    sidebarView: 'dashboard',
    activeModal: null,
    dashboardPreviewTaskId: null,
    canvasPendingTaskId: null,
    settingsTab: SettingsTab.GENERAL,
    showOrchestrator: false,
  })
  useCanvasStore.setState({ panels: [], edges: [], pendingViewCommand: null, viewport: { x: 0, y: 0, zoom: 1 } })
  useArtifactStore.setState({ artifactsByTask: {}, uiByTask: {} })
})

describe('navigate', () => {
  it('switches view', () => {
    expect(applyUiCommand({ kind: 'navigate', view: 'canvas' })).toEqual({ applied: true })
    expect(useUIStore.getState().sidebarView).toBe('canvas')
  })

  it('leaves settings behind — it covers the workspace', () => {
    useUIStore.getState().openSettings()
    applyUiCommand({ kind: 'navigate', view: 'tasks' })
    expect(useUIStore.getState().activeModal).toBeNull()
    expect(useUIStore.getState().sidebarView).toBe('tasks')
  })

  it('opens settings on the tab that was asked for, and ignores one that does not exist', () => {
    applyUiCommand({ kind: 'navigate', view: 'settings', settingsTab: 'voice' })
    expect(useUIStore.getState().activeModal).toBe('settings')
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.VOICE)

    applyUiCommand({ kind: 'navigate', view: 'settings', settingsTab: 'not-a-tab' })
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.VOICE)
  })
})

describe('open_task', () => {
  it('opens the full view and closes the dashboard dialog', () => {
    useUIStore.getState().openDashboardPreview('t2')
    applyUiCommand({ kind: 'open_task', taskId: 't1', where: 'workspace' })
    const ui = useUIStore.getState()
    expect(ui.sidebarView).toBe('tasks')
    expect(ui.dashboardPreviewTaskId).toBeNull()
    expect(useTaskStore.getState().selectedTaskId).toBe('t1')
  })

  it('opens the dashboard dialog', () => {
    applyUiCommand({ kind: 'open_task', taskId: 't1', where: 'modal' })
    expect(useUIStore.getState().dashboardPreviewTaskId).toBe('t1')
    expect(useUIStore.getState().sidebarView).toBe('dashboard')
  })

  it('adds a canvas panel when the task has none', () => {
    applyUiCommand({ kind: 'open_task', taskId: 't1', where: 'canvas' })
    const ui = useUIStore.getState()
    expect(ui.sidebarView).toBe('canvas')
    // The canvas places the panel itself, so it is queued rather than added here.
    expect(ui.canvasPendingTaskId).toBe('t1')
  })

  it('centres the existing panel instead of opening a second copy', () => {
    addTaskPanel('t1')
    applyUiCommand({ kind: 'open_task', taskId: 't1', where: 'canvas' })
    expect(useUIStore.getState().canvasPendingTaskId).toBeNull()
    expect(useCanvasStore.getState().pendingViewCommand).toEqual({ kind: 'focus_task', taskId: 't1' })
    expect(useCanvasStore.getState().panels).toHaveLength(1)
  })

  it('refuses a task the window does not have', () => {
    expect(applyUiCommand({ kind: 'open_task', taskId: 'ghost', where: 'workspace' })).toEqual({
      applied: false,
      detail: 'That task is not loaded',
    })
  })
})

describe('canvas panels', () => {
  it('moves the panel of a task', () => {
    const id = addTaskPanel('t1', 10, 10)
    expect(applyUiCommand({ kind: 'move_task_panel', taskId: 't1', x: 400, y: -50 })).toEqual({ applied: true })
    const panel = useCanvasStore.getState().panels.find((p) => p.id === id)
    expect([panel?.x, panel?.y]).toEqual([400, -50])
  })

  it('closes the panel of a task and leaves the others', () => {
    addTaskPanel('t1')
    addTaskPanel('t2')
    applyUiCommand({ kind: 'close_task_panel', taskId: 't1' })
    expect(useCanvasStore.getState().panels.map((p) => p.refId)).toEqual(['t2'])
  })

  it('reports when a task has no panel rather than acting on another', () => {
    addTaskPanel('t2')
    expect(applyUiCommand({ kind: 'move_task_panel', taskId: 't1', x: 0, y: 0 }).applied).toBe(false)
    expect(applyUiCommand({ kind: 'close_task_panel', taskId: 't1' }).applied).toBe(false)
    expect(useCanvasStore.getState().panels).toHaveLength(1)
  })

  it('queues a viewport change for the canvas to carry out, and shows the canvas', () => {
    addTaskPanel('t1')
    applyUiCommand({ kind: 'set_canvas_view', mode: 'fit_all' })
    expect(useCanvasStore.getState().pendingViewCommand).toEqual({ kind: 'fit_all' })
    expect(useUIStore.getState().sidebarView).toBe('canvas')
  })

  it('does not send the user to an empty canvas to fit nothing', () => {
    expect(applyUiCommand({ kind: 'set_canvas_view', mode: 'fit_all' })).toEqual({
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

  it('opens the tab named by the registry ID, not by the tab ID', () => {
    // The caller knows `art-1`; the tab is keyed on the task and the workpiece.
    expect(applyUiCommand({ kind: 'open_artifact', taskId: 't1', artifactId: 'art-1' })).toEqual({ applied: true })
    const ui = useArtifactStore.getState().getUI('t1')
    expect(ui.open).toBe(true)
    expect(ui.activeTabId).toBe(useArtifactStore.getState().getArtifacts('t1')[0].id)
    expect(useTaskStore.getState().selectedTaskId).toBe('t1')
    expect(useUIStore.getState().sidebarView).toBe('tasks')
  })

  it('says so when the artifact has not reached the window yet', () => {
    expect(applyUiCommand({ kind: 'open_artifact', taskId: 't1', artifactId: 'art-9' })).toEqual({
      applied: false,
      detail: 'That artifact is not on screen yet',
    })
  })
})

describe('collectUiState', () => {
  it('reports the canvas, so an agent can move a panel without guessing', () => {
    addTaskPanel('t1', 30, 40)
    useCanvasStore.getState().setViewport({ x: -100, y: 20, zoom: 0.5 })
    const state = collectUiState()
    expect(state.canvas.viewport).toEqual({ x: -100, y: 20, zoom: 0.5 })
    expect(state.canvas.panels).toEqual([
      expect.objectContaining({ taskId: 't1', x: 30, y: 40, type: 'task' }),
    ])
  })

  it('reports the open task and the screen it is on', () => {
    useTaskStore.getState().selectTask('t1')
    useUIStore.getState().setSidebarView('tasks')
    const state = collectUiState()
    expect(state).toMatchObject({ view: 'tasks', selectedTaskId: 't1', selectedTaskTitle: 'Fix login' })
  })
})
