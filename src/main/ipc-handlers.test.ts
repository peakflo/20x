import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  Notification: vi.fn().mockImplementation(function(this: any) { this.show = vi.fn() })
}))

import { ipcMain } from 'electron'
import { registerIpcHandlers } from './ipc-handlers'

describe('registerIpcHandlers', () => {
  it('registers the expected number of IPC handlers', () => {
    const db = {} as any
    const agentManager = { setSelectedTaskId: vi.fn() } as any
    const githubManager = {} as any
    const worktreeManager = {} as any
    const syncManager = {} as any
    const pluginRegistry = {} as any

    registerIpcHandlers(db, agentManager, githubManager, worktreeManager, syncManager, pluginRegistry)

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls
    expect(handleCalls.length).toBeGreaterThanOrEqual(30)

    const channels = handleCalls.map((call: any[]) => call[0])
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

  it('registers task:selectedChanged listener', () => {
    const agentManager = { setSelectedTaskId: vi.fn() } as any
    const db = {} as any

    // Reset to capture only our call
    ;(ipcMain.on as ReturnType<typeof vi.fn>).mockClear()

    registerIpcHandlers(db, agentManager, {} as any, {} as any, {} as any, {} as any)

    const onCalls = (ipcMain.on as ReturnType<typeof vi.fn>).mock.calls
    const selectedChangedCall = onCalls.find((call: any[]) => call[0] === 'task:selectedChanged')
    expect(selectedChangedCall).toBeDefined()

    // Simulate the event
    const handler = selectedChangedCall![1]
    handler({}, 'test-task-id')
    expect(agentManager.setSelectedTaskId).toHaveBeenCalledWith('test-task-id')
  })

  it('forwards null taskId to agentManager', () => {
    const agentManager = { setSelectedTaskId: vi.fn() } as any

    ;(ipcMain.on as ReturnType<typeof vi.fn>).mockClear()
    registerIpcHandlers({} as any, agentManager, {} as any, {} as any, {} as any, {} as any)

    const onCalls = (ipcMain.on as ReturnType<typeof vi.fn>).mock.calls
    const handler = onCalls.find((call: any[]) => call[0] === 'task:selectedChanged')![1]
    handler({}, null)
    expect(agentManager.setSelectedTaskId).toHaveBeenCalledWith(null)
  })
})
