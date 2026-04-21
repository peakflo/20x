import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { useSettingsStore } from './settings-store'

const mockElectronAPI = window.electronAPI

beforeEach(() => {
  useSettingsStore.setState({
    githubOrg: null,
    ghCliStatus: null,
    glabCliStatus: null,
    gitProvider: null,
    isLoading: false
  })
  vi.clearAllMocks()
})

describe('useSettingsStore', () => {
  describe('fetchSettings', () => {
    it('loads github_org and git_provider from settings', async () => {
      ;(mockElectronAPI.settings.getAll as unknown as Mock).mockResolvedValue({
        github_org: 'peakflo',
        git_provider: 'github'
      })

      await useSettingsStore.getState().fetchSettings()

      expect(useSettingsStore.getState().githubOrg).toBe('peakflo')
      expect(useSettingsStore.getState().gitProvider).toBe('github')
      expect(useSettingsStore.getState().isLoading).toBe(false)
    })

    it('sets githubOrg and gitProvider to null when not present', async () => {
      ;(mockElectronAPI.settings.getAll as unknown as Mock).mockResolvedValue({})

      await useSettingsStore.getState().fetchSettings()

      expect(useSettingsStore.getState().githubOrg).toBeNull()
      expect(useSettingsStore.getState().gitProvider).toBeNull()
    })

    it('sets gitProvider to null when saved provider is not github or gitlab', async () => {
      ;(mockElectronAPI.settings.getAll as unknown as Mock).mockResolvedValue({
        git_provider: 'none'
      })

      await useSettingsStore.getState().fetchSettings()

      expect(useSettingsStore.getState().gitProvider).toBeNull()
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

  describe('setGitProvider', () => {
    it('saves provider choice and updates state', async () => {
      await useSettingsStore.getState().setGitProvider('gitlab')

      expect(mockElectronAPI.settings.set).toHaveBeenCalledWith('git_provider', 'gitlab')
      expect(useSettingsStore.getState().gitProvider).toBe('gitlab')
    })

    it('saves github provider choice', async () => {
      await useSettingsStore.getState().setGitProvider('github')

      expect(mockElectronAPI.settings.set).toHaveBeenCalledWith('git_provider', 'github')
      expect(useSettingsStore.getState().gitProvider).toBe('github')
    })

    it('clears provider choice for users without repo tools', async () => {
      await useSettingsStore.getState().setGitProvider(null)

      expect(mockElectronAPI.settings.set).toHaveBeenCalledWith('git_provider', '')
      expect(useSettingsStore.getState().gitProvider).toBeNull()
    })
  })

  describe('checkGlabCli', () => {
    it('fetches and stores GitLab CLI status', async () => {
      const status = { installed: true, authenticated: true, username: 'gitlab-user' }
      ;(mockElectronAPI.gitlab.checkCli as unknown as Mock).mockResolvedValue(status)

      const result = await useSettingsStore.getState().checkGlabCli()

      expect(result).toEqual(status)
      expect(useSettingsStore.getState().glabCliStatus).toEqual(status)
    })
  })

  describe('startGlabAuth', () => {
    it('starts GitLab auth and re-checks status', async () => {
      const status = { installed: true, authenticated: true, username: 'gitlab-user' }
      ;(mockElectronAPI.gitlab.checkCli as unknown as Mock).mockResolvedValue(status)

      await useSettingsStore.getState().startGlabAuth()

      expect(mockElectronAPI.gitlab.startAuth).toHaveBeenCalled()
      expect(mockElectronAPI.gitlab.checkCli).toHaveBeenCalled()
      expect(useSettingsStore.getState().glabCliStatus).toEqual(status)
    })
  })
})
