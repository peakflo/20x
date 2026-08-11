import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleRoute, setTaskApiNotifier, setTaskApiUiState } from './task-api-server'
import { UI_COMMAND_CHANNEL } from '../shared/ui-commands'
import type { TaskRecord } from './database'

/**
 * The tools that drive the window.
 *
 * The rule these tests protect: a command that reaches no window is a failure.
 * An agent told "done" would go on to describe a screen the user never saw.
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

let sent: Array<{ channel: string; data: unknown }>

/** A window is open, showing `view`, with `panels` on the canvas. */
function windowShowing(view: string, panels: Array<{ taskId: string | null }> = []): void {
  setTaskApiUiState({ view, canvas: { viewport: { x: 0, y: 0, zoom: 1 }, panels } })
}

beforeEach(() => {
  sent = []
  setTaskApiNotifier((channel, data) => sent.push({ channel, data }))
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
    expect(sent[0]).toEqual({ channel: UI_COMMAND_CHANNEL, data: { kind: 'navigate', view: 'canvas', settingsTab: undefined } })
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
