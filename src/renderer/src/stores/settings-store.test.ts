import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { useSettingsStore } from './settings-store'

const mockElectronAPI = window.electronAPI

beforeEach(() => {
  useSettingsStore.setState({
    githubOrg: null,
    ghCliStatus: null,
    isLoading: false
  })
  vi.clearAllMocks()
})

describe('useSettingsStore', () => {
  describe('fetchSettings', () => {
    it('loads github_org from settings', async () => {
      ;(mockElectronAPI.settings.getAll as unknown as Mock).mockResolvedValue({
        github_org: 'peakflo'
      })

      await useSettingsStore.getState().fetchSettings()

      expect(useSettingsStore.getState().githubOrg).toBe('peakflo')
      expect(useSettingsStore.getState().isLoading).toBe(false)
    })

    it('sets githubOrg to null when not present', async () => {
      ;(mockElectronAPI.settings.getAll as unknown as Mock).mockResolvedValue({})

      await useSettingsStore.getState().fetchSettings()

      expect(useSettingsStore.getState().githubOrg).toBeNull()
    })

    it('handles errors gracefully', async () => {
      ;(mockElectronAPI.settings.getAll as unknown as Mock).mockRejectedValue(new Error('fail'))

      await useSettingsStore.getState().fetchSettings()

      expect(useSettingsStore.getState().isLoading).toBe(false)
    })
  })

  describe('setGithubOrg', () => {
    it('saves org and updates state', async () => {
      await useSettingsStore.getState().setGithubOrg('my-org')

      expect(mockElectronAPI.settings.set).toHaveBeenCalledWith('github_org', 'my-org')
      expect(useSettingsStore.getState().githubOrg).toBe('my-org')
    })
  })

  describe('checkGhCli', () => {
    it('fetches and stores CLI status', async () => {
      const status = { installed: true, authenticated: true, username: 'user' }
      ;(mockElectronAPI.github.checkCli as unknown as Mock).mockResolvedValue(status)

      const result = await useSettingsStore.getState().checkGhCli()

      expect(result).toEqual(status)
      expect(useSettingsStore.getState().ghCliStatus).toEqual(status)
    })
  })

  describe('startGhAuth', () => {
    it('starts auth and re-checks status', async () => {
      const status = { installed: true, authenticated: true, username: 'user' }
      ;(mockElectronAPI.github.checkCli as unknown as Mock).mockResolvedValue(status)

      await useSettingsStore.getState().startGhAuth()

      expect(mockElectronAPI.github.startAuth).toHaveBeenCalled()
      expect(mockElectronAPI.github.checkCli).toHaveBeenCalled()
      expect(useSettingsStore.getState().ghCliStatus).toEqual(status)
    })
  })
})
