import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron-updater
const mockAutoUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn()
}

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test'),
    getName: vi.fn(() => '20x'),
    getVersion: vi.fn(() => '0.0.31'),
    isPackaged: true
  },
  BrowserWindow: vi.fn(),
  dialog: { showMessageBox: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn()
  }
}))

describe('auto-updater', () => {
  beforeEach(() => {
    vi.resetModules()
    mockAutoUpdater.autoDownload = false
    mockAutoUpdater.autoInstallOnAppQuit = false
    mockAutoUpdater.on.mockReset()
    mockAutoUpdater.checkForUpdates.mockReset()
    mockAutoUpdater.downloadUpdate.mockReset()
  })

  describe('initAutoUpdater', () => {
    it('should set autoDownload to true for silent background downloads', async () => {
      const { initAutoUpdater } = await import('./auto-updater')
      const mockWindow = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } } as any

      initAutoUpdater(mockWindow)

      expect(mockAutoUpdater.autoDownload).toBe(true)
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false)
    })

    it('should register all required event listeners', async () => {
      const { initAutoUpdater } = await import('./auto-updater')
      const mockWindow = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } } as any

      initAutoUpdater(mockWindow)

      const events = mockAutoUpdater.on.mock.calls.map((c: any[]) => c[0])
      expect(events).toContain('checking-for-update')
      expect(events).toContain('update-available')
      expect(events).toContain('update-not-available')
      expect(events).toContain('download-progress')
      expect(events).toContain('update-downloaded')
      expect(events).toContain('error')
    })

    it('should register IPC handlers via registerUpdaterIpc', async () => {
      const { ipcMain } = await import('electron')
      const { registerUpdaterIpc } = await import('./auto-updater')

      registerUpdaterIpc()

      const registeredChannels = (ipcMain.handle as any).mock.calls.map((c: any[]) => c[0])
      expect(registeredChannels).toContain('updater:check')
      expect(registeredChannels).toContain('updater:download')
      expect(registeredChannels).toContain('updater:install')
      expect(registeredChannels).toContain('updater:getVersion')
    })

    it('should send release notes in update-available event', async () => {
      const { initAutoUpdater } = await import('./auto-updater')
      const sendMock = vi.fn()
      const mockWindow = { isDestroyed: vi.fn(() => false), webContents: { send: sendMock } } as any

      initAutoUpdater(mockWindow)

      // Find and invoke the 'update-available' handler
      const updateAvailableHandler = mockAutoUpdater.on.mock.calls.find(
        (c: any[]) => c[0] === 'update-available'
      )?.[1]

      expect(updateAvailableHandler).toBeDefined()
      updateAvailableHandler({
        version: '1.0.0',
        releaseNotes: '## What\'s new\n- Bug fixes',
        releaseDate: '2026-04-01'
      })

      expect(sendMock).toHaveBeenCalledWith('updater:status', expect.objectContaining({
        status: 'available',
        version: '1.0.0',
        releaseNotes: '## What\'s new\n- Bug fixes',
        releaseDate: '2026-04-01',
        currentVersion: '0.0.31'
      }))
    })

    it('should send up-to-date status on 404 errors instead of suppressing', async () => {
      const { initAutoUpdater } = await import('./auto-updater')
      const sendMock = vi.fn()
      const mockWindow = { isDestroyed: vi.fn(() => false), webContents: { send: sendMock } } as any

      initAutoUpdater(mockWindow)

      const errorHandler = mockAutoUpdater.on.mock.calls.find(
        (c: any[]) => c[0] === 'error'
      )?.[1]

      expect(errorHandler).toBeDefined()
      errorHandler(new Error('HttpError: 404 Not Found'))

      expect(sendMock).toHaveBeenCalledWith('updater:status', expect.objectContaining({
        status: 'up-to-date',
        currentVersion: '0.0.31'
      }))
    })
  })

  describe('isUpdateDownloaded', () => {
    it('should return false initially', async () => {
      const { isUpdateDownloaded } = await import('./auto-updater')
      expect(isUpdateDownloaded()).toBe(false)
    })
  })

  describe('getPendingVersion', () => {
    it('should return null initially', async () => {
      const { getPendingVersion } = await import('./auto-updater')
      expect(getPendingVersion()).toBeNull()
    })
  })
})
