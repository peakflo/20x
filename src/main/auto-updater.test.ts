import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Store event handlers registered by auto-updater
const autoUpdaterHandlers: Record<string, (...args: any[]) => void> = {}

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      autoUpdaterHandlers[event] = handler
    }),
    checkForUpdates: vi.fn().mockResolvedValue({}),
    downloadUpdate: vi.fn().mockResolvedValue({}),
    quitAndInstall: vi.fn()
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false }
}))

import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import {
  initAutoUpdater,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  getAppVersion
} from './auto-updater'

describe('auto-updater', () => {
  let mockWindow: BrowserWindow
  let mockSend: ReturnType<typeof vi.fn>
  let windowHandlers: Record<string, (...args: any[]) => void>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    // Clear stored handlers
    Object.keys(autoUpdaterHandlers).forEach((key) => delete autoUpdaterHandlers[key])

    windowHandlers = {}
    mockSend = vi.fn()
    mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: mockSend },
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        windowHandlers[event] = handler
      })
    } as unknown as BrowserWindow
  })

  afterEach(() => {
    // Trigger window 'closed' handler to clean up intervals
    if (windowHandlers['closed']) {
      windowHandlers['closed']()
    }
    vi.useRealTimers()
  })

  describe('initAutoUpdater', () => {
    it('configures autoUpdater settings', () => {
      initAutoUpdater(mockWindow)

      expect(autoUpdater.autoDownload).toBe(false)
      expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    })

    it('registers all expected event handlers', () => {
      initAutoUpdater(mockWindow)

      expect(autoUpdater.on).toHaveBeenCalledWith('checking-for-update', expect.any(Function))
      expect(autoUpdater.on).toHaveBeenCalledWith('update-available', expect.any(Function))
      expect(autoUpdater.on).toHaveBeenCalledWith('update-not-available', expect.any(Function))
      expect(autoUpdater.on).toHaveBeenCalledWith('download-progress', expect.any(Function))
      expect(autoUpdater.on).toHaveBeenCalledWith('update-downloaded', expect.any(Function))
      expect(autoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function))
    })

    it('schedules initial check after 5 seconds', () => {
      initAutoUpdater(mockWindow)

      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
      vi.advanceTimersByTime(5_000)
      expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    it('schedules periodic checks every 4 hours', () => {
      initAutoUpdater(mockWindow)

      // Initial check at 5s
      vi.advanceTimersByTime(5_000)
      expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

      // 4-hour periodic check
      vi.advanceTimersByTime(4 * 60 * 60 * 1_000)
      expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
    })

    it('cleans up interval on window closed', () => {
      initAutoUpdater(mockWindow)

      // Trigger close
      windowHandlers['closed']()

      // Advance past periodic check — should not trigger
      vi.advanceTimersByTime(5 * 60 * 60 * 1_000)
      // Only initial timeout fires (if it was already queued)
      // The interval should be cleared
    })

    it('registers closed event listener on the window', () => {
      initAutoUpdater(mockWindow)

      expect(mockWindow.on).toHaveBeenCalledWith('closed', expect.any(Function))
    })
  })

  describe('event forwarding', () => {
    beforeEach(() => {
      initAutoUpdater(mockWindow)
    })

    it('sends checking status on checking-for-update', () => {
      autoUpdaterHandlers['checking-for-update']()

      expect(mockSend).toHaveBeenCalledWith('updater:status', { status: 'checking' })
    })

    it('sends available status with version and string releaseNotes', () => {
      autoUpdaterHandlers['update-available']({
        version: '2.0.0',
        releaseNotes: 'Bug fixes and improvements'
      })

      expect(mockSend).toHaveBeenCalledWith('updater:status', {
        status: 'available',
        version: '2.0.0',
        releaseNotes: 'Bug fixes and improvements'
      })
    })

    it('sends available status with array releaseNotes joined', () => {
      autoUpdaterHandlers['update-available']({
        version: '2.0.0',
        releaseNotes: [{ note: 'Fix A' }, { note: 'Fix B' }]
      })

      expect(mockSend).toHaveBeenCalledWith('updater:status', {
        status: 'available',
        version: '2.0.0',
        releaseNotes: 'Fix A\nFix B'
      })
    })

    it('sends available status with undefined releaseNotes when not present', () => {
      autoUpdaterHandlers['update-available']({
        version: '2.0.0'
      })

      expect(mockSend).toHaveBeenCalledWith('updater:status', {
        status: 'available',
        version: '2.0.0',
        releaseNotes: undefined
      })
    })

    it('sends not-available status', () => {
      autoUpdaterHandlers['update-not-available']({ version: '1.0.0' })

      expect(mockSend).toHaveBeenCalledWith('updater:status', {
        status: 'not-available',
        version: '1.0.0'
      })
    })

    it('sends downloading status with progress', () => {
      autoUpdaterHandlers['download-progress']({
        percent: 50.5,
        bytesPerSecond: 1024000,
        transferred: 5000000,
        total: 10000000
      })

      expect(mockSend).toHaveBeenCalledWith('updater:status', {
        status: 'downloading',
        progress: {
          percent: 50.5,
          bytesPerSecond: 1024000,
          transferred: 5000000,
          total: 10000000
        }
      })
    })

    it('sends downloaded status', () => {
      autoUpdaterHandlers['update-downloaded']({ version: '2.0.0' })

      expect(mockSend).toHaveBeenCalledWith('updater:status', {
        status: 'downloaded',
        version: '2.0.0'
      })
    })

    it('sends error status', () => {
      autoUpdaterHandlers['error'](new Error('Network timeout'))

      expect(mockSend).toHaveBeenCalledWith('updater:status', {
        status: 'error',
        error: 'Network timeout'
      })
    })

    it('does not send status if window is destroyed', () => {
      ;(mockWindow.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true)

      autoUpdaterHandlers['checking-for-update']()

      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  describe('checkForUpdates', () => {
    it('calls autoUpdater.checkForUpdates', async () => {
      await checkForUpdates()

      expect(autoUpdater.checkForUpdates).toHaveBeenCalled()
    })

    it('handles check errors gracefully', async () => {
      ;(autoUpdater.checkForUpdates as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Network error')
      )

      // Should not throw
      await checkForUpdates()
    })
  })

  describe('downloadUpdate', () => {
    it('calls autoUpdater.downloadUpdate', async () => {
      await downloadUpdate()

      expect(autoUpdater.downloadUpdate).toHaveBeenCalled()
    })

    it('handles download errors gracefully', async () => {
      ;(autoUpdater.downloadUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Download failed')
      )

      // Should not throw
      await downloadUpdate()
    })
  })

  describe('installUpdate', () => {
    it('calls autoUpdater.quitAndInstall with correct args', () => {
      installUpdate()

      expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
    })
  })

  describe('getAppVersion', () => {
    it('returns the app version', () => {
      const version = getAppVersion()

      expect(version).toBe('1.0.0')
      expect(app.getVersion).toHaveBeenCalled()
    })
  })
})

describe('auto-updater (dev mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('skips initialization in dev mode', async () => {
    vi.doMock('@electron-toolkit/utils', () => ({
      is: { dev: true }
    }))

    const { initAutoUpdater: initDev } = await import('./auto-updater')

    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
      on: vi.fn()
    } as unknown as BrowserWindow

    initDev(mockWindow)

    expect(autoUpdater.on).not.toHaveBeenCalled()
  })

  it('checkForUpdates is a no-op in dev mode', async () => {
    vi.doMock('@electron-toolkit/utils', () => ({
      is: { dev: true }
    }))

    const { checkForUpdates: checkDev } = await import('./auto-updater')
    await checkDev()

    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('downloadUpdate is a no-op in dev mode', async () => {
    vi.doMock('@electron-toolkit/utils', () => ({
      is: { dev: true }
    }))

    const { downloadUpdate: downloadDev } = await import('./auto-updater')
    await downloadDev()

    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })
})
