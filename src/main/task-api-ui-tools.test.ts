import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleRoute, resolveTaskApiUiCommand, setTaskApiUiCommandSender, setTaskApiUiState } from './task-api-server'
import { UI_COMMAND_TIMEOUT_MS, type UiCommandEnvelope, type UiCommandResult } from '../shared/ui-commands'
import type { TaskRecord } from './database'

/**
 * The tools that drive the window.
 *
 * The rule these tests protect: a command that reaches no window, that the
 * window refuses, or that the window never confirms is a failure. An agent told
 * "done" would go on to describe a screen the user never saw.
 */

vi.mock('./artifacts', () => ({
  createRegisteredTaskArtifact: vi.fn(),
  editRegisteredTaskArtifactFile: vi.fn(),
  readRegisteredTaskArtifactFile: vi.fn(),
  writeRegisteredTaskArtifactFile: vi.fn(),
  listRegisteredTaskArtifacts: vi.fn(async () => [
    { artifactId: 'art-1', taskId: 't1', title: 'Design', type: 'markdown', files: ['design.md'], createdAt: 1, updatedAt: 2 },
  ]),
}))

const handle = (route: string, params: Record<string, unknown> = {}): Promise<unknown> =>
  handleRoute(makeDb() as never, route, params)

function makeDb() {
  const task = { id: 't1', title: 'Fix login' } as TaskRecord
  return {
    getTask: vi.fn((id: string) => (id === 't1' ? task : undefined)),
    getWorkspaceDir: vi.fn(() => '/tmp/workspace/t1'),
  }
}

let sent: Array<{ data: UiCommandEnvelope['command'] }>
/** What the fake window answers. Null: it says nothing. */
let windowAnswer: ((command: UiCommandEnvelope['command']) => (UiCommandResult & { state?: unknown }) | null) | null
let windowReachable: boolean

/**
 * Answers like the real renderer: a canvas open places a panel and the answer
 * carries the screen with it; a move moves it.
 */
let screenPanels: Array<{ panelId: string; type: string; taskId: string; x: number; y: number; width: number; height: number }>
function realisticWindow(command: UiCommandEnvelope['command']): UiCommandResult & { state?: unknown } {
  if (command.kind === 'open_task' && command.where === 'canvas' && !screenPanels.some((p) => p.taskId === command.taskId)) {
    screenPanels.push({ panelId: `panel-${screenPanels.length + 1}`, type: 'task', taskId: command.taskId, x: 100, y: 200, width: 1020, height: 780 })
  }
  if (command.kind === 'move_task_panel') {
    const panel = screenPanels.find((p) => p.taskId === command.taskId)
    if (panel) Object.assign(panel, { x: command.x, y: command.y })
  }
  return {
    applied: true,
    state: { view: 'canvas', canvas: { viewport: { x: 0, y: 0, zoom: 0.5 }, panels: screenPanels.map((p) => ({ ...p })) } },
  }
}

/** A window is open, showing `view`, with `panels` on the canvas. */
function windowShowing(view: string, panels: Array<{ taskId: string | null }> = []): void {
  setTaskApiUiState({ view, canvas: { viewport: { x: 0, y: 0, zoom: 1 }, panels } })
}

beforeEach(() => {
  vi.useRealTimers()
  sent = []
  screenPanels = []
  windowReachable = true
  windowAnswer = realisticWindow
  setTaskApiUiCommandSender((envelope) => {
    if (!windowReachable) return false
    sent.push({ data: envelope.command })
    // The renderer answers asynchronously, over IPC.
    queueMicrotask(() => {
      const answer = windowAnswer?.(envelope.command)
      if (answer) resolveTaskApiUiCommand({ requestId: envelope.requestId, ...answer } as never)
    })
    return true
  })
  windowShowing('tasks')
})

describe('no window', () => {
  it('refuses every command rather than reporting a screen nobody saw', async () => {
    setTaskApiUiState(null)
    for (const [route, params] of [
      ['/navigate', { view: 'canvas' }],
      ['/open_task', { task_id: 't1' }],
      ['/set_canvas_view', { mode: 'reset' }],
      ['/open_artifact', { task_id: 't1', artifact_id: 'art-1' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = (await handle(route, params)) as { error?: string }
      expect(result.error, route).toMatch(/no 20x window/i)
    }
    expect(sent).toHaveLength(0)
  })
})

describe('navigate', () => {
  it('sends the user to a view', async () => {
    const result = (await handle('/navigate', { view: 'canvas' })) as { success: boolean }
    expect(result.success).toBe(true)
    expect(sent[0]).toEqual({ data: { kind: 'navigate', view: 'canvas', settingsTab: undefined } })
  })

  it('carries a settings tab', async () => {
    await handle('/navigate', { view: 'settings', settings_tab: 'voice' })
    expect(sent[0].data).toMatchObject({ view: 'settings', settingsTab: 'voice' })
  })

  it('refuses a view that does not exist', async () => {
    const result = (await handle('/navigate', { view: 'kanban' })) as { error?: string }
    expect(result.error).toMatch(/view must be one of/)
    expect(sent).toHaveLength(0)
  })
})

describe('open_task', () => {
  it('follows the canvas when the user is on the canvas', async () => {
    windowShowing('canvas')
    const result = (await handle('/open_task', { task_id: 't1' })) as { where: string }
    expect(result.where).toBe('canvas')
    expect(sent[0].data).toMatchObject({ kind: 'open_task', where: 'canvas' })
  })

  it('opens the dialog when the user is on the dashboard, so they stay there', async () => {
    windowShowing('dashboard')
    const result = (await handle('/open_task', { task_id: 't1' })) as { where: string }
    expect(result.where).toBe('modal')
  })

  it('opens the full view from anywhere else', async () => {
    windowShowing('skills')
    const result = (await handle('/open_task', { task_id: 't1' })) as { where: string }
    expect(result.where).toBe('workspace')
  })

  it('obeys an explicit target over the open view', async () => {
    windowShowing('dashboard')
    const result = (await handle('/open_task', { task_id: 't1', where: 'canvas' })) as { where: string }
    expect(result.where).toBe('canvas')
  })

  it('refuses an unknown task and an unknown target', async () => {
    const unknownTask = (await handle('/open_task', { task_id: 'nope' })) as { error?: string }
    expect(unknownTask.error).toMatch(/not found/i)

    const badTarget = (await handle('/open_task', { task_id: 't1', where: 'sidebar' })) as { error?: string }
    expect(badTarget.error).toMatch(/where must be one of/)
    expect(sent).toHaveLength(0)
  })
})

describe('move_task_panel', () => {
  it('moves a panel that is really there', async () => {
    windowShowing('canvas', [{ taskId: 't1' }])
    const result = (await handle('/move_task_panel', { task_id: 't1', x: 120, y: -40 })) as { success: boolean }
    expect(result.success).toBe(true)
    expect(sent[0].data).toEqual({ kind: 'move_task_panel', taskId: 't1', x: 120, y: -40 })
  })

  it('refuses when that task has no panel, instead of doing nothing quietly', async () => {
    windowShowing('canvas', [{ taskId: 'other' }])
    const result = (await handle('/move_task_panel', { task_id: 't1', x: 0, y: 0 })) as { error?: string }
    expect(result.error).toMatch(/no panel on the canvas/i)
    expect(sent).toHaveLength(0)
  })

  it('refuses coordinates that are not numbers', async () => {
    windowShowing('canvas', [{ taskId: 't1' }])
    const result = (await handle('/move_task_panel', { task_id: 't1', x: 'left', y: 0 })) as { error?: string }
    expect(result.error).toMatch(/must be numbers/)
  })
})

describe('close_task_panel', () => {
  it('closes a panel that is there', async () => {
    windowShowing('canvas', [{ taskId: 't1' }])
    const result = (await handle('/close_task_panel', { task_id: 't1' })) as { success: boolean }
    expect(result.success).toBe(true)
  })

  it('refuses when there is no panel', async () => {
    const result = (await handle('/close_task_panel', { task_id: 't1' })) as { error?: string }
    expect(result.error).toMatch(/no panel on the canvas/i)
  })
})

describe('set_canvas_view', () => {
  it('fits every panel', async () => {
    windowShowing('canvas', [{ taskId: 't1' }])
    const result = (await handle('/set_canvas_view', { mode: 'fit_all' })) as { success: boolean }
    expect(result.success).toBe(true)
  })

  it('refuses to fit an empty canvas', async () => {
    const result = (await handle('/set_canvas_view', { mode: 'fit_all' })) as { error?: string }
    expect(result.error).toMatch(/canvas is empty/i)
  })

  it('keeps zoom inside the range the canvas enforces', async () => {
    const tooFar = (await handle('/set_canvas_view', { mode: 'zoom', zoom: 12 })) as { error?: string }
    expect(tooFar.error).toMatch(/between 0.1 and 3/)

    const missing = (await handle('/set_canvas_view', { mode: 'zoom' })) as { error?: string }
    expect(missing.error).toMatch(/between 0.1 and 3/)

    const fine = (await handle('/set_canvas_view', { mode: 'zoom', zoom: 1.5 })) as { success: boolean }
    expect(fine.success).toBe(true)
    expect(sent.at(-1)?.data).toEqual({ kind: 'set_canvas_view', mode: 'zoom', zoom: 1.5 })
  })
})

describe('open_artifact', () => {
  it('opens an artifact of that task', async () => {
    const result = (await handle('/open_artifact', { task_id: 't1', artifact_id: 'art-1' })) as { success: boolean }
    expect(result.success).toBe(true)
    expect(sent[0].data).toEqual({ kind: 'open_artifact', taskId: 't1', artifactId: 'art-1' })
  })

  it('refuses an artifact of another task, and names the real ones', async () => {
    const result = (await handle('/open_artifact', { task_id: 't1', artifact_id: 'art-9' })) as {
      error?: string
      artifacts?: Array<{ artifact_id: string }>
    }
    expect(result.error).toMatch(/artifact not found/i)
    expect(result.artifacts?.[0].artifact_id).toBe('art-1')
    expect(sent).toHaveLength(0)
  })
})

describe('the window has to confirm', () => {
  it('reports the reason when the window could not carry the command out', async () => {
    // The 2026-10-19 report: a completed task the window had not loaded was
    // refused by the renderer, and the tool still said success.
    windowShowing('canvas')
    windowAnswer = () => ({ applied: false, detail: 'The 20x window could not load that task.' })
    const result = (await handle('/open_task', { task_id: 't1', where: 'canvas' })) as { error?: string; success?: boolean }
    expect(result.success).toBeUndefined()
    expect(result.error).toBe('The 20x window could not load that task.')
  })

  it('fails when the window never answers', async () => {
    vi.useFakeTimers()
    windowAnswer = () => null
    const pending = handle('/navigate', { view: 'canvas' }) as Promise<{ error?: string }>
    await vi.advanceTimersByTimeAsync(UI_COMMAND_TIMEOUT_MS + 1)
    expect((await pending).error).toMatch(/did not confirm/i)
  })

  it('fails when the window is gone before it can answer', async () => {
    windowAnswer = () => null
    const pending = handle('/navigate', { view: 'canvas' }) as Promise<{ error?: string }>
    setTaskApiUiState(null)
    expect((await pending).error).toMatch(/closed/i)
  })

  it('fails when the command cannot be delivered', async () => {
    windowReachable = false
    const result = (await handle('/navigate', { view: 'canvas' })) as { error?: string }
    expect(result.error).toMatch(/cannot be reached/i)
  })

  it('caches the screen the window answers with, so get_ui_state shows the new panel at once', async () => {
    windowShowing('canvas', [])
    windowAnswer = () => ({
      applied: true,
      state: {
        view: 'canvas',
        selectedTaskId: 't1',
        visibleTaskIds: ['t1'],
        canvas: { viewport: { x: 0, y: 0, zoom: 1 }, panels: [{ panelId: 'p1', type: 'task', taskId: 't1', x: 5, y: 6, width: 1020, height: 780 }] },
      },
    })
    const result = (await handle('/open_task', { task_id: 't1', where: 'canvas' })) as { success: boolean; panel?: { x: number } }
    expect(result.success).toBe(true)
    expect(result.panel).toMatchObject({ taskId: 't1', x: 5 })

    const state = (await handle('/get_ui_state')) as { selectedTaskId: string; visibleTaskIds: string[]; canvas: { panels: Array<{ taskId: string }> } }
    expect(state.selectedTaskId).toBe('t1')
    expect(state.visibleTaskIds).toContain('t1')
    expect(state.canvas.panels.map((p) => p.taskId)).toEqual(['t1'])

    // …and so a move straight after is accepted rather than refused as "no panel".
    const moved = (await handle('/move_task_panel', { task_id: 't1', x: 1, y: 2 })) as { success?: boolean }
    expect(moved.success).toBe(true)
  })
})

describe('open_task: explicit where="canvas" and the default behave the same', () => {
  // 2026-10-19: the mastermind's first call (no where) and its later
  // where="canvas" calls all returned success with no panel; a later call
  // with no where worked. Both forms must add the panel and say where it is.
  for (const [label, params] of [
    ['where="canvas"', { task_id: 't1', where: 'canvas' }],
    ['no where, on the canvas', { task_id: 't1' }],
    ['where="auto", on the canvas', { task_id: 't1', where: 'auto' }],
    ['where=null, on the canvas', { task_id: 't1', where: null }],
    ['where="Canvas " (case and spaces)', { task_id: 't1', where: 'Canvas ' }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`adds the panel and returns its id and position: ${label}`, async () => {
      windowShowing('canvas')
      const result = (await handle('/open_task', params)) as { success?: boolean; where?: string; panel?: Record<string, unknown> }
      expect(sent.map((c) => c.data)).toEqual([{ kind: 'open_task', taskId: 't1', where: 'canvas' }])
      expect(result).toMatchObject({ success: true, where: 'canvas', task_id: 't1' })
      expect(result.panel).toEqual({ panelId: 'panel-1', type: 'task', taskId: 't1', x: 100, y: 200, width: 1020, height: 780 })

      const state = (await handle('/get_ui_state')) as { canvas: { panels: Array<{ taskId: string }> } }
      expect(state.canvas.panels.map((p) => p.taskId)).toEqual(['t1'])
    })
  }

  it('lets the agent move the panel straight from the open_task reply', async () => {
    windowShowing('canvas')
    const opened = (await handle('/open_task', { task_id: 't1', where: 'canvas' })) as { panel: { x: number; y: number } }
    const moved = (await handle('/move_task_panel', { task_id: 't1', x: opened.panel.x + 500, y: opened.panel.y })) as {
      success?: boolean
      panel?: { x: number; y: number }
    }
    expect(moved.success).toBe(true)
    expect(moved.panel).toMatchObject({ x: 600, y: 200 })
  })

  it('refuses a where it does not know, listing the valid ones, and sends nothing', async () => {
    for (const where of ['tasks', 'sidebar', 42]) {
      const result = (await handle('/open_task', { task_id: 't1', where })) as { error?: string }
      expect(result.error, String(where)).toMatch(/where must be one of auto, workspace, canvas, modal/)
      expect(result.error).toMatch(/Omit it/)
    }
    expect(sent).toHaveLength(0)
  })

  it('is an error, not a success, when the window says it opened but published no panel', async () => {
    windowShowing('canvas')
    windowAnswer = () => ({ applied: true, state: { view: 'canvas', canvas: { viewport: { x: 0, y: 0, zoom: 1 }, panels: [] } } })
    const result = (await handle('/open_task', { task_id: 't1', where: 'canvas' })) as { error?: string; success?: boolean }
    expect(result.success).toBeUndefined()
    expect(result.error).toMatch(/no canvas panel/i)
  })

  it('names the tools that find a real task when the ID is wrong', async () => {
    const result = (await handle('/open_task', { task_id: 'nope', where: 'canvas' })) as { error?: string }
    expect(result.error).toMatch(/Task not found: nope/)
    expect(result.error).toMatch(/list_tasks/)
  })
})

describe('set_canvas_view defaults', () => {
  it('fits every panel when called with nothing', async () => {
    windowShowing('canvas', [{ taskId: 't1' }])
    const result = (await handle('/set_canvas_view', {})) as { success?: boolean; mode?: string; viewport?: unknown }
    expect(result).toMatchObject({ success: true, mode: 'fit_all' })
    expect(result.viewport).toEqual({ x: 0, y: 0, zoom: 0.5 })
    expect(sent.at(-1)?.data).toEqual({ kind: 'set_canvas_view', mode: 'fit_all', zoom: undefined })
  })

  it('treats a lone zoom as mode=zoom', async () => {
    await handle('/set_canvas_view', { zoom: 0.5 })
    expect(sent.at(-1)?.data).toEqual({ kind: 'set_canvas_view', mode: 'zoom', zoom: 0.5 })
  })

  it('refuses an unknown mode with the valid ones', async () => {
    const result = (await handle('/set_canvas_view', { mode: 'center' })) as { error?: string }
    expect(result.error).toMatch(/mode must be one of fit_all, reset, zoom/)
  })
})

describe('navigate', () => {
  it('points at open_task when the agent tries to navigate to a task', async () => {
    const result = (await handle('/navigate', { view: 'task' })) as { error?: string }
    expect(result.error).toMatch(/use open_task/)
  })
})
