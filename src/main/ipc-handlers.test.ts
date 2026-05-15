import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() }))
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
