import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron-updater before any imports
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
    getPath: vi.fn((name: string) => {
      if (name === 'appData') return '/tmp/test-appdata'
      if (name === 'home') return '/tmp/test-home'
      if (name === 'temp') return '/tmp/test-temp'
      return '/tmp/test'
    }),
    getName: vi.fn(() => '20x'),
    getVersion: vi.fn(() => '0.0.31'),
    isPackaged: true,
    exit: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
  shell: {},
  dialog: {}
}))

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  execSync: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn()
}))

describe('updater', () => {
  beforeEach(() => {
    vi.resetModules()
    mockAutoUpdater.autoDownload = false
    mockAutoUpdater.autoInstallOnAppQuit = false
    mockAutoUpdater.on.mockReset()
    mockAutoUpdater.checkForUpdates.mockReset()
    mockAutoUpdater.downloadUpdate.mockReset()
  })

  describe('initUpdater', () => {
    it('should configure autoUpdater with autoDownload=true for silent background downloads', async () => {
      const { initUpdater } = await import('./updater')
      const mockWindow = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } } as any

      initUpdater(mockWindow)

      expect(mockAutoUpdater.autoDownload).toBe(true)
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false)
    })

    it('should register all required event listeners on autoUpdater', async () => {
      const { initUpdater } = await import('./updater')
      const mockWindow = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } } as any

      initUpdater(mockWindow)

      const registeredEvents = mockAutoUpdater.on.mock.calls.map((c: any[]) => c[0])
      expect(registeredEvents).toContain('update-available')
      expect(registeredEvents).toContain('update-not-available')
      expect(registeredEvents).toContain('download-progress')
      expect(registeredEvents).toContain('update-downloaded')
      expect(registeredEvents).toContain('error')
    })

    it('should only initialize once (idempotent)', async () => {
      const { initUpdater } = await import('./updater')
      const mockWindow = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } } as any

      initUpdater(mockWindow)
      const callCount = mockAutoUpdater.on.mock.calls.length
      initUpdater(mockWindow)
      expect(mockAutoUpdater.on.mock.calls.length).toBe(callCount)
    })
  })

  describe('getCurrentVersion', () => {
    it('should return the app version', async () => {
      const { getCurrentVersion } = await import('./updater')
      expect(getCurrentVersion()).toBe('0.0.31')
    })
  })

  describe('shouldCheckForUpdate', () => {
    it('should return true when no previous check exists', async () => {
      const { shouldCheckForUpdate } = await import('./updater')
      const mockDb = { getSetting: vi.fn(() => null) } as any
      expect(shouldCheckForUpdate(mockDb)).toBe(true)
    })

    it('should return false when last check was recent', async () => {
      const { shouldCheckForUpdate } = await import('./updater')
      const mockDb = { getSetting: vi.fn(() => Date.now().toString()) } as any
      expect(shouldCheckForUpdate(mockDb)).toBe(false)
    })

    it('should return true when last check was more than 24h ago', async () => {
      const { shouldCheckForUpdate } = await import('./updater')
      const longAgo = (Date.now() - 25 * 60 * 60 * 1000).toString()
      const mockDb = { getSetting: vi.fn(() => longAgo) } as any
      expect(shouldCheckForUpdate(mockDb)).toBe(true)
    })
  })

  describe('recordUpdateCheck', () => {
    it('should store the current timestamp', async () => {
      const { recordUpdateCheck } = await import('./updater')
      const mockDb = { setSetting: vi.fn() } as any

      recordUpdateCheck(mockDb)

      expect(mockDb.setSetting).toHaveBeenCalledWith('last_update_check', expect.any(String))
      const storedTime = parseInt(mockDb.setSetting.mock.calls[0][1], 10)
      expect(Math.abs(storedTime - Date.now())).toBeLessThan(1000)
    })
  })

  describe('isUpdateReadyToInstall', () => {
    it('should return false when no update is downloaded', async () => {
      const { isUpdateReadyToInstall } = await import('./updater')
      expect(isUpdateReadyToInstall()).toBe(false)
    })
  })

  describe('getPendingUpdateVersion', () => {
    it('should return null when no update is pending', async () => {
      const { getPendingUpdateVersion } = await import('./updater')
      expect(getPendingUpdateVersion()).toBeNull()
    })
  })

  describe('checkForUpdates', () => {
    it('should call autoUpdater.checkForUpdates', async () => {
      const { checkForUpdates } = await import('./updater')
      mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: {} })

      const result = await checkForUpdates()
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled()
      expect(result).toBe(true)
    })
  })

  describe('downloadUpdate', () => {
    it('should call autoUpdater.downloadUpdate', async () => {
      const { downloadUpdate } = await import('./updater')
      mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined)

      await downloadUpdate()
      expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalled()
    })
  })
})
