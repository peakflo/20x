import { create } from 'zustand'
import { settingsApi, githubApi, gitlabApi } from '@/lib/ipc-client'
import type { GhCliStatus, GlabCliStatus } from '@/types/electron'

export type GitProvider = 'github' | 'gitlab'

interface SettingsState {
  githubOrg: string | null
  ghCliStatus: GhCliStatus | null
  glabCliStatus: GlabCliStatus | null
  gitProvider: GitProvider | null
  isLoading: boolean

  fetchSettings: () => Promise<void>
  setGithubOrg: (org: string) => Promise<void>
  setGitProvider: (provider: GitProvider | null) => Promise<void>
  checkGhCli: () => Promise<GhCliStatus>
  startGhAuth: () => Promise<void>
  checkGlabCli: () => Promise<GlabCliStatus>
  startGlabAuth: () => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  githubOrg: null,
  ghCliStatus: null,
  glabCliStatus: null,
  gitProvider: null,
  isLoading: false,

  fetchSettings: async () => {
    set({ isLoading: true })
    try {
      const all = await settingsApi.getAll()
      set({
        githubOrg: all.github_org || null,
        gitProvider: all.git_provider === 'github' || all.git_provider === 'gitlab'
          ? all.git_provider
          : null,
        isLoading: false
      })
    } catch {
      set({ isLoading: false })
    }
  },

  setGithubOrg: async (org: string) => {
    await settingsApi.set('github_org', org)
    set({ githubOrg: org })
  },

  setGitProvider: async (provider: GitProvider | null) => {
    await settingsApi.set('git_provider', provider ?? '')
    set({ gitProvider: provider })
  },

  checkGhCli: async () => {
    const status = await githubApi.checkCli()
    set({ ghCliStatus: status })
    return status
  },

  startGhAuth: async () => {
    await githubApi.startAuth()
    // Re-check status after auth
    const status = await githubApi.checkCli()
    set({ ghCliStatus: status })
  },

  checkGlabCli: async () => {
    const status = await gitlabApi.checkCli()
    set({ glabCliStatus: status })
    return status
  },

  startGlabAuth: async () => {
    await gitlabApi.startAuth()
    // Re-check status after auth
    const status = await gitlabApi.checkCli()
    set({ glabCliStatus: status })
  }
}))
