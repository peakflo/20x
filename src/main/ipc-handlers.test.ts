import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() })),
  app: { isPackaged: false }
}))

const { mockChildKill, mockSpawn } = vi.hoisted(() => {
  const kill = vi.fn()
  const spawn = vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { writable: true, write: vi.fn() },
    on: vi.fn(),
    kill,
    pid: 4242
  }))
  return { mockChildKill: kill, mockSpawn: spawn }
})

vi.mock('child_process', () => ({
  spawn: mockSpawn
}))

import { ipcMain } from 'electron'
import { registerIpcHandlers } from './ipc-handlers'

describe('registerIpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the expected number of IPC handlers', () => {
    const db = {} as unknown as Parameters<typeof registerIpcHandlers>[0]
    const agentManager = {} as unknown as Parameters<typeof registerIpcHandlers>[1]
    const githubManager = {} as unknown as Parameters<typeof registerIpcHandlers>[2]
    const worktreeManager = {} as unknown as Parameters<typeof registerIpcHandlers>[3]
    const syncManager = {} as unknown as Parameters<typeof registerIpcHandlers>[4]
    const pluginRegistry = {} as unknown as Parameters<typeof registerIpcHandlers>[5]

    registerIpcHandlers(db, agentManager, githubManager, worktreeManager, syncManager, pluginRegistry)

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls
    expect(handleCalls.length).toBeGreaterThanOrEqual(30)

    const channels = handleCalls.map((call: unknown[]) => call[0])
    expect(channels).toContain('db:getTasks')
    expect(channels).toContain('db:createTask')
    expect(channels).toContain('db:updateTask')
    expect(channels).toContain('db:deleteTask')
    expect(channels).toContain('agent:getAll')
    expect(channels).toContain('agentSession:start')
    expect(channels).toContain('mcp:getAll')
    expect(channels).toContain('settings:get')
    expect(channels).toContain('skills:getAll')
    expect(channels).toContain('taskSource:sync')
    expect(channels).toContain('plugin:list')
    expect(channels).toContain('artifacts:scan')
    expect(channels).toContain('artifacts:read')
    expect(channels).toContain('voice:startTurn')
    expect(channels).toContain('voice:pushAudio')
    expect(channels).toContain('voice:confirm')
    expect(channels).toContain('voice:selectModel')
  })

  it('voice handlers stay safe when the voice manager is absent', async () => {
    const db = {} as unknown as Parameters<typeof registerIpcHandlers>[0]
    const agentManager = {} as unknown as Parameters<typeof registerIpcHandlers>[1]
    const githubManager = {} as unknown as Parameters<typeof registerIpcHandlers>[2]
    const worktreeManager = {} as unknown as Parameters<typeof registerIpcHandlers>[3]
    const syncManager = {} as unknown as Parameters<typeof registerIpcHandlers>[4]
    const pluginRegistry = {} as unknown as Parameters<typeof registerIpcHandlers>[5]

    registerIpcHandlers(db, agentManager, githubManager, worktreeManager, syncManager, pluginRegistry)

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const snapshot = handleCalls.find((call) => call[0] === 'voice:getSnapshot')?.[1]
    const pushAudio = handleCalls.find((call) => call[0] === 'voice:pushAudio')?.[1]
    const startTurn = handleCalls.find((call) => call[0] === 'voice:startTurn')?.[1]

    await expect(snapshot!({}, {})).resolves.toMatchObject({ enabled: false, state: 'disabled' })
    expect(() => pushAudio!({}, { turnId: 't', chunk: new Uint8Array(2) })).not.toThrow()
    // The handler is async now, so it rejects rather than throwing.
    await expect(startTurn!({}, { mode: 'command' })).rejects.toThrow(/not available/i)
  })

  it('passes every turn mode through, including conversation', async () => {
    const db = {} as unknown as Parameters<typeof registerIpcHandlers>[0]
    const agentManager = {} as unknown as Parameters<typeof registerIpcHandlers>[1]
    const githubManager = {} as unknown as Parameters<typeof registerIpcHandlers>[2]
    const worktreeManager = {} as unknown as Parameters<typeof registerIpcHandlers>[3]
    const syncManager = {} as unknown as Parameters<typeof registerIpcHandlers>[4]
    const pluginRegistry = {} as unknown as Parameters<typeof registerIpcHandlers>[5]
    const startTurnSpy = vi.fn(async (_mode: string, _context: unknown) => ({ turnId: 't1' }))
    const voice = { startTurn: startTurnSpy } as unknown as Parameters<typeof registerIpcHandlers>[16]

    registerIpcHandlers(
      db, agentManager, githubManager, worktreeManager, syncManager, pluginRegistry,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, voice
    )

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const startTurn = handleCalls.filter((call) => call[0] === 'voice:startTurn').pop()?.[1]

    // Coercing an unknown mode to 'dictation' once threw 'conversation' away,
    // which ended the loop after the first sentence.
    await startTurn!({}, { mode: 'conversation', context: {} })
    await startTurn!({}, { mode: 'command', context: {} })
    await startTurn!({}, { mode: 'dictation', context: {} })
    await startTurn!({}, { mode: 'nonsense', context: {} })

    expect(startTurnSpy.mock.calls.map((call) => call[0])).toEqual([
      'conversation',
      'command',
      'dictation',
      'dictation',
    ])
  })

  it('terminal:kill ignores stale expectedPid and only kills matching process', async () => {
    const db = {} as unknown as Parameters<typeof registerIpcHandlers>[0]
    const agentManager = {} as unknown as Parameters<typeof registerIpcHandlers>[1]
    const githubManager = {} as unknown as Parameters<typeof registerIpcHandlers>[2]
    const worktreeManager = {} as unknown as Parameters<typeof registerIpcHandlers>[3]
    const syncManager = {} as unknown as Parameters<typeof registerIpcHandlers>[4]
    const pluginRegistry = {} as unknown as Parameters<typeof registerIpcHandlers>[5]

    registerIpcHandlers(db, agentManager, githubManager, worktreeManager, syncManager, pluginRegistry)

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const createHandler = handleCalls.find((call) => call[0] === 'terminal:create')?.[1]
    const killHandler = handleCalls.find((call) => call[0] === 'terminal:kill')?.[1]

    expect(createHandler).toBeDefined()
    expect(killHandler).toBeDefined()

    const sender = { isDestroyed: () => false, send: vi.fn() }
    await createHandler?.({ sender }, { id: 'panel-1', cols: 80, rows: 24 })

    await killHandler?.({}, { id: 'panel-1', expectedPid: 9999 })
    expect(mockChildKill).not.toHaveBeenCalled()

    await killHandler?.({}, { id: 'panel-1', expectedPid: 4242 })
    expect(mockChildKill).toHaveBeenCalledTimes(1)
    expect(mockChildKill).toHaveBeenCalledWith('SIGTERM')
  })
})

describe('db:updateTask coordinator wake-up', () => {
  function setup(existing: Record<string, unknown>, updated: Record<string, unknown>) {
    const notifyParent = vi.fn().mockResolvedValue(undefined)
    const agentManager = { notifyParentOfSubtaskCompletion: notifyParent } as unknown as Parameters<typeof registerIpcHandlers>[1]
    const db = {
      getTask: vi.fn(() => existing),
      updateTask: vi.fn(() => updated)
    } as unknown as Parameters<typeof registerIpcHandlers>[0]

    registerIpcHandlers(db, agentManager, {} as never, {} as never, {} as never, {} as never)

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const updateHandler = handleCalls.filter((call) => call[0] === 'db:updateTask').pop()?.[1]
    expect(updateHandler).toBeDefined()
    return { notifyParent, updateHandler: updateHandler! }
  }

  it('wakes the parent coordinator when a subtask is moved to a terminal state from the UI', () => {
    const existing = { id: 'sub-1', parent_task_id: 'parent-1', status: 'agent_working' }
    const updated = { ...existing, status: 'ready_for_review' }
    const { notifyParent, updateHandler } = setup(existing, updated)

    updateHandler({}, 'sub-1', { status: 'ready_for_review' })

    expect(notifyParent).toHaveBeenCalledWith('parent-1', 'sub-1')
  })

  it('wakes the parent when a UI completion closes a subtask', () => {
    const existing = { id: 'sub-2', parent_task_id: 'parent-1', status: 'ready_for_review' }
    const updated = { ...existing, status: 'completed' }
    const { notifyParent, updateHandler } = setup(existing, updated)

    updateHandler({}, 'sub-2', { status: 'completed' })

    expect(notifyParent).toHaveBeenCalledWith('parent-1', 'sub-2')
  })

  it('does not wake the parent for a non-terminal status change', () => {
    const existing = { id: 'sub-3', parent_task_id: 'parent-1', status: 'not_started' }
    const updated = { ...existing, status: 'agent_working' }
    const { notifyParent, updateHandler } = setup(existing, updated)

    updateHandler({}, 'sub-3', { status: 'agent_working' })

    expect(notifyParent).not.toHaveBeenCalled()
  })

  it('does not wake the parent when the status did not change', () => {
    const existing = { id: 'sub-4', parent_task_id: 'parent-1', status: 'ready_for_review' }
    const updated = { ...existing, title: 'rename only path' }
    const { notifyParent, updateHandler } = setup(existing, updated)

    updateHandler({}, 'sub-4', { title: 'rename only path' })

    expect(notifyParent).not.toHaveBeenCalled()
  })

  it('does not wake anything for a top-level task', () => {
    const existing = { id: 'top-1', parent_task_id: null, status: 'agent_working' }
    const updated = { ...existing, status: 'ready_for_review' }
    const { notifyParent, updateHandler } = setup(existing, updated)

    updateHandler({}, 'top-1', { status: 'ready_for_review' })

    expect(notifyParent).not.toHaveBeenCalled()
  })
})
