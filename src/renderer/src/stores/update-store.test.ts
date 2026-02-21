import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useUpdateStore } from './update-store'

const mockElectronAPI = window.electronAPI

/** Helper to extract the callback registered via onUpdaterStatus */
function getUpdaterCallback(): ((event: any) => void) | undefined {
  const calls = (mockElectronAPI.onUpdaterStatus as ReturnType<typeof vi.fn>).mock.calls
  return calls.length > 0 ? calls[calls.length - 1][0] : undefined
}

beforeEach(() => {
  useUpdateStore.setState({
    status: 'idle',
    version: null,
    releaseNotes: null,
    progress: null,
    error: null,
    dismissed: false,
    appVersion: null
  })
  vi.clearAllMocks()
})

describe('useUpdateStore', () => {
  describe('initial state', () => {
    it('has correct default values', () => {
      const state = useUpdateStore.getState()
      expect(state.status).toBe('idle')
      expect(state.version).toBeNull()
      expect(state.releaseNotes).toBeNull()
      expect(state.progress).toBeNull()
      expect(state.error).toBeNull()
      expect(state.dismissed).toBe(false)
      expect(state.appVersion).toBeNull()
    })
  })

  describe('dismiss', () => {
    it('sets dismissed to true', () => {
      useUpdateStore.getState().dismiss()
      expect(useUpdateStore.getState().dismissed).toBe(true)
    })
  })

  describe('checkForUpdates', () => {
    it('calls updater.check via electronAPI', async () => {
      await useUpdateStore.getState().checkForUpdates()
      expect(mockElectronAPI.updater.check).toHaveBeenCalled()
    })

    it('handles check errors gracefully', async () => {
      ;(mockElectronAPI.updater.check as any).mockRejectedValueOnce(new Error('Network error'))

      // Should not throw
      await useUpdateStore.getState().checkForUpdates()
    })
  })

  describe('downloadUpdate', () => {
    it('calls updater.download via electronAPI', async () => {
      await useUpdateStore.getState().downloadUpdate()
      expect(mockElectronAPI.updater.download).toHaveBeenCalled()
    })

    it('handles download errors gracefully', async () => {
      ;(mockElectronAPI.updater.download as any).mockRejectedValueOnce(
        new Error('Download failed')
      )

      await useUpdateStore.getState().downloadUpdate()
    })
  })

  describe('installUpdate', () => {
    it('calls updater.install via electronAPI', async () => {
      await useUpdateStore.getState().installUpdate()
      expect(mockElectronAPI.updater.install).toHaveBeenCalled()
    })

    it('handles install errors gracefully', async () => {
      ;(mockElectronAPI.updater.install as any).mockRejectedValueOnce(new Error('Install failed'))

      await useUpdateStore.getState().installUpdate()
    })
  })

  describe('loadAppVersion', () => {
    it('loads and stores app version', async () => {
      ;(mockElectronAPI.app.getVersion as any).mockResolvedValue('2.5.0')

      await useUpdateStore.getState().loadAppVersion()

      expect(mockElectronAPI.app.getVersion).toHaveBeenCalled()
      expect(useUpdateStore.getState().appVersion).toBe('2.5.0')
    })

    it('handles errors gracefully', async () => {
      ;(mockElectronAPI.app.getVersion as any).mockRejectedValueOnce(new Error('fail'))

      await useUpdateStore.getState().loadAppVersion()

      expect(useUpdateStore.getState().appVersion).toBeNull()
    })
  })

  describe('initListener', () => {
    it('registers onUpdaterStatus listener', () => {
      const cleanup = useUpdateStore.getState().initListener()

      expect(mockElectronAPI.onUpdaterStatus).toHaveBeenCalled()
      expect(typeof cleanup).toBe('function')
    })

    it('updates status when updater event fires', () => {
      useUpdateStore.getState().initListener()
      const cb = getUpdaterCallback()

      cb?.({ status: 'checking' })

      expect(useUpdateStore.getState().status).toBe('checking')
    })

    it('updates version and releaseNotes on available event', () => {
      useUpdateStore.getState().initListener()
      const cb = getUpdaterCallback()

      cb?.({
        status: 'available',
        version: '3.0.0',
        releaseNotes: 'New features'
      })

      const state = useUpdateStore.getState()
      expect(state.status).toBe('available')
      expect(state.version).toBe('3.0.0')
      expect(state.releaseNotes).toBe('New features')
    })

    it('updates progress on downloading event', () => {
      useUpdateStore.getState().initListener()
      const cb = getUpdaterCallback()

      cb?.({
        status: 'downloading',
        progress: {
          percent: 45.2,
          bytesPerSecond: 512000,
          transferred: 2000000,
          total: 5000000
        }
      })

      const state = useUpdateStore.getState()
      expect(state.status).toBe('downloading')
      expect(state.progress).toEqual({
        percent: 45.2,
        bytesPerSecond: 512000,
        transferred: 2000000,
        total: 5000000
      })
    })

    it('updates error on error event', () => {
      useUpdateStore.getState().initListener()
      const cb = getUpdaterCallback()

      cb?.({
        status: 'error',
        error: 'Something went wrong'
      })

      const state = useUpdateStore.getState()
      expect(state.status).toBe('error')
      expect(state.error).toBe('Something went wrong')
    })

    it('sets downloaded status', () => {
      useUpdateStore.getState().initListener()
      const cb = getUpdaterCallback()

      cb?.({
        status: 'downloaded',
        version: '3.0.0'
      })

      const state = useUpdateStore.getState()
      expect(state.status).toBe('downloaded')
      expect(state.version).toBe('3.0.0')
    })

    it('resets dismissed when a new version is detected', () => {
      // Dismiss an existing update
      useUpdateStore.setState({ version: '2.0.0', dismissed: true })

      useUpdateStore.getState().initListener()
      const cb = getUpdaterCallback()

      // New version detected
      cb?.({
        status: 'available',
        version: '3.0.0'
      })

      expect(useUpdateStore.getState().dismissed).toBe(false)
    })

    it('does not reset dismissed for the same version', () => {
      useUpdateStore.setState({ version: '2.0.0', dismissed: true })

      useUpdateStore.getState().initListener()
      const cb = getUpdaterCallback()

      // Same version
      cb?.({
        status: 'available',
        version: '2.0.0'
      })

      expect(useUpdateStore.getState().dismissed).toBe(true)
    })

    it('clears error when status changes to non-error', () => {
      useUpdateStore.setState({ status: 'error', error: 'Previous error' })

      useUpdateStore.getState().initListener()
      const cb = getUpdaterCallback()

      cb?.({ status: 'checking' })

      const state = useUpdateStore.getState()
      expect(state.status).toBe('checking')
      expect(state.error).toBeNull()
    })

    it('clears progress when status changes to non-downloading', () => {
      useUpdateStore.setState({
        status: 'downloading',
        progress: { percent: 50, bytesPerSecond: 1024, transferred: 500, total: 1000 }
      })

      useUpdateStore.getState().initListener()
      const cb = getUpdaterCallback()

      cb?.({
        status: 'downloaded',
        version: '3.0.0'
      })

      const state = useUpdateStore.getState()
      expect(state.status).toBe('downloaded')
      expect(state.progress).toBeNull()
    })
  })
})
