import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  clipboard: { write: vi.fn(async () => undefined), writeText: vi.fn(async () => undefined) },
  ClipboardItem: class {
    constructor(public readonly items: Record<string, unknown>) {}
  },
  nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })) },
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

  it('keeps a newly created source-less task local', async () => {
    const task = { id: 'task-1', title: 'Instant task', status: 'not_started', source_id: null }
    const db = {
      createTask: vi.fn(() => task),
      getTask: vi.fn(() => task)
    } as unknown as Parameters<typeof registerIpcHandlers>[0]
    const uploadTask = vi.fn()
    const syncManager = {
      canUploadTasks: vi.fn(() => true),
      uploadTask
    } as unknown as Parameters<typeof registerIpcHandlers>[4]

    registerIpcHandlers(
      db,
      {} as Parameters<typeof registerIpcHandlers>[1],
      {} as Parameters<typeof registerIpcHandlers>[2],
      {} as Parameters<typeof registerIpcHandlers>[3],
      syncManager,
      {} as Parameters<typeof registerIpcHandlers>[5]
    )

    const handlers = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const createTask = handlers.filter(([channel]) => channel === 'db:createTask').pop()?.[1]
    const sender = { send: vi.fn() }

    await expect(createTask!({ sender }, task)).resolves.toBe(task)
    expect(uploadTask).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith('task:created', { task })
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

describe('task:completeLocally ("Only in 20x")', () => {
  function setup(task: Record<string, unknown> | undefined, source: Record<string, unknown> | undefined) {
    const notifyParent = vi.fn().mockResolvedValue(undefined)
    const agentManager = { notifyParentOfSubtaskCompletion: notifyParent } as unknown as Parameters<typeof registerIpcHandlers>[1]
    const updateTask = vi.fn((_id: string, data: Record<string, unknown>) => (task ? { ...task, ...data } : undefined))
    const db = {
      getTask: vi.fn(() => task),
      getTaskSource: vi.fn(() => source),
      updateTask
    } as unknown as Parameters<typeof registerIpcHandlers>[0]
    const disableHeartbeat = vi.fn()
    const heartbeatScheduler = { disableHeartbeat } as unknown as NonNullable<Parameters<typeof registerIpcHandlers>[11]>
    const recordTaskCompleted = vi.fn()
    const enterpriseStateSync = {
      recordTaskCompleted,
      recordTaskStatusChange: vi.fn(),
      recordFeedbackSubmitted: vi.fn()
    } as unknown as NonNullable<Parameters<typeof registerIpcHandlers>[13]>

    registerIpcHandlers(
      db, agentManager, {} as never, {} as never, {} as never, {} as never,
      undefined, undefined, undefined, undefined, undefined,
      heartbeatScheduler, undefined, enterpriseStateSync
    )

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const completeLocally = handleCalls.filter((call) => call[0] === 'task:completeLocally').pop()?.[1]
    expect(completeLocally).toBeDefined()
    return { completeLocally: completeLocally!, updateTask, notifyParent, disableHeartbeat, recordTaskCompleted }
  }

  it('completes a Notion-style sourced task with origin user-local and complete_at_source=false', async () => {
    const task = {
      id: 'task-1', status: 'ready_for_review', source_id: 'src-notion', external_id: 'page-1',
      parent_task_id: 'parent-1', heartbeat_enabled: true, type: 'general', priority: 'medium'
    }
    const { completeLocally, updateTask, notifyParent, disableHeartbeat, recordTaskCompleted } =
      setup(task, { id: 'src-notion', plugin_id: 'notion' })

    const result = await completeLocally({}, 'task-1')

    expect(updateTask).toHaveBeenCalledExactlyOnceWith(
      'task-1', { status: 'completed', complete_at_source: false }, 'user-local'
    )
    expect(result).toMatchObject({ status: 'completed', complete_at_source: false })
    // The shared post-update side effects run exactly like for db:updateTask.
    expect(disableHeartbeat).toHaveBeenCalledWith('task-1')
    expect(recordTaskCompleted).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', status: 'completed' }))
    expect(notifyParent).toHaveBeenCalledWith('parent-1', 'task-1')
  })

  it('refuses a Workflo task (plugin peakflo) so the server keeps status ownership', async () => {
    const task = { id: 'task-2', status: 'ready_for_review', source_id: 'src-wf', external_id: 'wf-1' }
    const { completeLocally, updateTask } = setup(task, { id: 'src-wf', plugin_id: 'peakflo' })

    await expect(async () => completeLocally({}, 'task-2')).rejects.toThrow('Workflo controls task status')
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('refuses a server-managed task even without a source record', async () => {
    const task = { id: 'task-2b', status: 'ready_for_review', source_id: 'src-wf', external_id: 'wf-2', server_managed: true }
    const { completeLocally, updateTask } = setup(task, undefined)

    await expect(async () => completeLocally({}, 'task-2b')).rejects.toThrow('Workflo controls task status')
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('refuses a source-less task — those complete through db:updateTask', async () => {
    const task = { id: 'task-3', status: 'ready_for_review', source_id: null, external_id: null }
    const { completeLocally, updateTask } = setup(task, undefined)

    await expect(async () => completeLocally({}, 'task-3')).rejects.toThrow(/task source/)
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('refuses an unknown task', async () => {
    const { completeLocally, updateTask } = setup(undefined, undefined)

    await expect(async () => completeLocally({}, 'missing')).rejects.toThrow('Task not found')
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('db:updateTask cannot reach the user-local origin', () => {
    const task = { id: 'task-4', status: 'ready_for_review', source_id: 'src-notion', external_id: 'page-1' }
    const { updateTask } = setup(task, { id: 'src-notion', plugin_id: 'notion' })
    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const updateHandler = handleCalls.filter((call) => call[0] === 'db:updateTask').pop()?.[1]

    updateHandler!({}, 'task-4', { status: 'completed', complete_at_source: false })

    // The renderer's data object is passed through without any origin.
    expect(updateTask).toHaveBeenCalledExactlyOnceWith('task-4', { status: 'completed', complete_at_source: false })
  })
})
