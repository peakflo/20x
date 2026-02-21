import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.0') },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() }))
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    on: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue({}),
    downloadUpdate: vi.fn().mockResolvedValue({}),
    quitAndInstall: vi.fn()
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false }
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
    expect(channels).toContain('updater:check')
    expect(channels).toContain('updater:download')
    expect(channels).toContain('updater:install')
    expect(channels).toContain('app:getVersion')
  })
})
