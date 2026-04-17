import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useUpdateStore } from './update-store'

describe('useUpdateStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Reset store to initial state
    useUpdateStore.setState({
      updateAvailable: null,
      isChecking: false,
      isDownloading: false,
      downloadProgress: null,
      isReadyToInstall: false,
      currentVersion: null,
      error: null,
      isUpToDate: false
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('has correct initial state', () => {
    const state = useUpdateStore.getState()
    expect(state.updateAvailable).toBeNull()
    expect(state.isChecking).toBe(false)
    expect(state.isDownloading).toBe(false)
    expect(state.downloadProgress).toBeNull()
    expect(state.isReadyToInstall).toBe(false)
    expect(state.currentVersion).toBeNull()
    expect(state.error).toBeNull()
    expect(state.isUpToDate).toBe(false)
  })

  it('checkForUpdates sets isChecking and clears isUpToDate', async () => {
    useUpdateStore.setState({ isUpToDate: true })
    const promise = useUpdateStore.getState().checkForUpdates()
    expect(useUpdateStore.getState().isChecking).toBe(true)
    expect(useUpdateStore.getState().isUpToDate).toBe(false)
    expect(useUpdateStore.getState().error).toBeNull()
    await promise
  })

  it('checkForUpdates sets error on failure', async () => {
    // Make the mock reject
    window.electronAPI.update.check = vi.fn().mockRejectedValueOnce(new Error('Network error'))
    await useUpdateStore.getState().checkForUpdates()
    expect(useUpdateStore.getState().isChecking).toBe(false)
    expect(useUpdateStore.getState().error).toBe('Network error')
    // Reset mock
    window.electronAPI.update.check = vi.fn().mockResolvedValue(undefined)
  })

  it('downloadUpdate sets isDownloading', async () => {
    const promise = useUpdateStore.getState().downloadUpdate()
    expect(useUpdateStore.getState().isDownloading).toBe(true)
    expect(useUpdateStore.getState().downloadProgress).toBeNull()
    expect(useUpdateStore.getState().error).toBeNull()
    await promise
  })

  it('downloadUpdate sets error on failure', async () => {
    window.electronAPI.update.download = vi.fn().mockRejectedValueOnce(new Error('Download failed'))
    await useUpdateStore.getState().downloadUpdate()
    expect(useUpdateStore.getState().isDownloading).toBe(false)
    expect(useUpdateStore.getState().error).toBe('Download failed')
    // Reset mock
    window.electronAPI.update.download = vi.fn().mockResolvedValue(undefined)
  })

  it('downloadUpdate does not overwrite isReadyToInstall on error', async () => {
    // Simulate the macOS Squirrel race condition: isReadyToInstall is set
    // by the event handler before the download promise rejects
    useUpdateStore.setState({ isReadyToInstall: true })
    window.electronAPI.update.download = vi.fn().mockRejectedValueOnce(new Error('Code signature'))
    await useUpdateStore.getState().downloadUpdate()
    // Should NOT overwrite isReadyToInstall
    expect(useUpdateStore.getState().isReadyToInstall).toBe(true)
    expect(useUpdateStore.getState().error).toBeNull()
    // Reset mock
    window.electronAPI.update.download = vi.fn().mockResolvedValue(undefined)
  })

  it('loadVersion sets currentVersion', async () => {
    await useUpdateStore.getState().loadVersion()
    expect(useUpdateStore.getState().currentVersion).toBe('0.0.28')
  })

  it('dismissUpdate clears update state', () => {
    useUpdateStore.setState({
      updateAvailable: { version: '1.0.0', releaseNotes: 'test', releaseDate: '' },
      isReadyToInstall: true,
      downloadProgress: { percent: 50, bytesPerSecond: 100, transferred: 50, total: 100 },
      isDownloading: true
    })
    useUpdateStore.getState().dismissUpdate()
    const state = useUpdateStore.getState()
    expect(state.updateAvailable).toBeNull()
    expect(state.isReadyToInstall).toBe(false)
    expect(state.downloadProgress).toBeNull()
    expect(state.isDownloading).toBe(false)
  })

  describe('initListeners', () => {
    it('sets up event listeners and returns cleanup function', () => {
      const cleanup = useUpdateStore.getState().initListeners()
      expect(typeof cleanup).toBe('function')
      // Verify the on* functions were called
      expect(window.electronAPI.onUpdateAvailable).toHaveBeenCalled()
      expect(window.electronAPI.onUpdateNotAvailable).toHaveBeenCalled()
      expect(window.electronAPI.onUpdateDownloadProgress).toHaveBeenCalled()
      expect(window.electronAPI.onUpdateDownloaded).toHaveBeenCalled()
      expect(window.electronAPI.onUpdateError).toHaveBeenCalled()
      cleanup()
    })

    it('onUpdateAvailable handler sets update info and clears isChecking', () => {
      // Capture the callback
      let availableCb: ((info: unknown) => void) | null = null
      window.electronAPI.onUpdateAvailable = vi.fn((cb) => {
        availableCb = cb
        return vi.fn()
      })

      useUpdateStore.setState({ isChecking: true })
      useUpdateStore.getState().initListeners()

      expect(availableCb).not.toBeNull()
      availableCb!({ version: '1.2.0', releaseNotes: '# Changes\n- Fix bugs', releaseDate: '2026-03-05' })

      const state = useUpdateStore.getState()
      expect(state.updateAvailable).toEqual({
        version: '1.2.0',
        releaseNotes: '# Changes\n- Fix bugs',
        releaseDate: '2026-03-05'
      })
      expect(state.isChecking).toBe(false)
      expect(state.error).toBeNull()
    })

    it('onUpdateNotAvailable handler sets isUpToDate and auto-clears after 5s', () => {
      let notAvailableCb: (() => void) | null = null
      window.electronAPI.onUpdateNotAvailable = vi.fn((cb) => {
        notAvailableCb = cb
        return vi.fn()
      })

      useUpdateStore.setState({ isChecking: true })
      useUpdateStore.getState().initListeners()

      expect(notAvailableCb).not.toBeNull()
      notAvailableCb!()

      expect(useUpdateStore.getState().isChecking).toBe(false)
      expect(useUpdateStore.getState().isUpToDate).toBe(true)

      // After 5 seconds, isUpToDate should be cleared
      vi.advanceTimersByTime(5000)
      expect(useUpdateStore.getState().isUpToDate).toBe(false)
    })

    it('onUpdateDownloaded handler sets isReadyToInstall', () => {
      let downloadedCb: (() => void) | null = null
      window.electronAPI.onUpdateDownloaded = vi.fn((cb) => {
        downloadedCb = cb
        return vi.fn()
      })

      useUpdateStore.setState({ isDownloading: true })
      useUpdateStore.getState().initListeners()

      expect(downloadedCb).not.toBeNull()
      downloadedCb!()

      const state = useUpdateStore.getState()
      expect(state.isDownloading).toBe(false)
      expect(state.isReadyToInstall).toBe(true)
      expect(state.downloadProgress).toBeNull()
    })

    it('onUpdateDownloadProgress handler updates progress', () => {
      let progressCb: ((progress: unknown) => void) | null = null
      window.electronAPI.onUpdateDownloadProgress = vi.fn((cb) => {
        progressCb = cb
        return vi.fn()
      })

      useUpdateStore.getState().initListeners()
      expect(progressCb).not.toBeNull()
      progressCb!({ percent: 42, bytesPerSecond: 1024, transferred: 420, total: 1000 })

      expect(useUpdateStore.getState().downloadProgress).toEqual({
        percent: 42,
        bytesPerSecond: 1024,
        transferred: 420,
        total: 1000
      })
    })

    it('onUpdateError handler sets error only when checking or downloading', () => {
      let errorCb: ((message: string) => void) | null = null
      window.electronAPI.onUpdateError = vi.fn((cb) => {
        errorCb = cb
        return vi.fn()
      })

      // When checking
      useUpdateStore.setState({ isChecking: true })
      useUpdateStore.getState().initListeners()

      expect(errorCb).not.toBeNull()
      errorCb!('Something went wrong')

      const state = useUpdateStore.getState()
      expect(state.isChecking).toBe(false)
      expect(state.isDownloading).toBe(false)
      expect(state.error).toBe('Something went wrong')
    })

    it('onUpdateError handler ignores error when not checking or downloading', () => {
      let errorCb: ((message: string) => void) | null = null
      window.electronAPI.onUpdateError = vi.fn((cb) => {
        errorCb = cb
        return vi.fn()
      })

      // Neither checking nor downloading
      useUpdateStore.setState({ isChecking: false, isDownloading: false })
      useUpdateStore.getState().initListeners()

      expect(errorCb).not.toBeNull()
      errorCb!('Background error')

      expect(useUpdateStore.getState().error).toBeNull()
    })

    it('subscribes to onMenuCheckForUpdates', () => {
      useUpdateStore.getState().initListeners()
      expect(window.electronAPI.onMenuCheckForUpdates).toHaveBeenCalled()
    })

    it('onMenuCheckForUpdates triggers checkForUpdates when no update available', () => {
      // Ensure window.dispatchEvent is available
      if (!window.dispatchEvent) {
        (window as any).dispatchEvent = vi.fn()
      }
      const dispatchSpy = vi.fn()
      window.dispatchEvent = dispatchSpy

      let menuCb: (() => void) | null = null
      window.electronAPI.onMenuCheckForUpdates = vi.fn((cb) => {
        menuCb = cb
        return vi.fn()
      })

      useUpdateStore.setState({ updateAvailable: null })
      useUpdateStore.getState().initListeners()

      expect(menuCb).not.toBeNull()
      menuCb!()

      // Should have started checking
      expect(useUpdateStore.getState().isChecking).toBe(true)
      // Should have dispatched the open-update-dialog event
      expect(dispatchSpy).toHaveBeenCalled()
    })

    it('onMenuCheckForUpdates skips checkForUpdates when update already available', () => {
      if (!window.dispatchEvent) {
        (window as any).dispatchEvent = vi.fn()
      }
      window.dispatchEvent = vi.fn()

      let menuCb: (() => void) | null = null
      window.electronAPI.onMenuCheckForUpdates = vi.fn((cb) => {
        menuCb = cb
        return vi.fn()
      })

      useUpdateStore.setState({
        updateAvailable: { version: '2.0.0', releaseNotes: 'New', releaseDate: '' }
      })
      useUpdateStore.getState().initListeners()

      menuCb!()

      // Should NOT have started checking since update is already known
      expect(useUpdateStore.getState().isChecking).toBe(false)
    })
  })
})
