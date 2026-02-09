import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() }))
}))

import { ipcMain } from 'electron'
import { registerIpcHandlers } from './ipc-handlers'

describe('registerIpcHandlers', () => {
  it('registers the expected number of IPC handlers', () => {
    const db = {} as any
    const agentManager = {} as any
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
})
