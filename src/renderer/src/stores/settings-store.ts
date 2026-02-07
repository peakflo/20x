import { create } from 'zustand'
import { settingsApi, githubApi } from '@/lib/ipc-client'
import type { GhCliStatus } from '@/types/electron'

interface SettingsState {
  githubOrg: string | null
  ghCliStatus: GhCliStatus | null
  isLoading: boolean

  fetchSettings: () => Promise<void>
  setGithubOrg: (org: string) => Promise<void>
  checkGhCli: () => Promise<GhCliStatus>
  startGhAuth: () => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  githubOrg: null,
  ghCliStatus: null,
  isLoading: false,

  fetchSettings: async () => {
    set({ isLoading: true })
    try {
      const all = await settingsApi.getAll()
      set({ githubOrg: all.github_org || null, isLoading: false })
    } catch {
      set({ isLoading: false })
    }
  },

  setGithubOrg: async (org: string) => {
    await settingsApi.set('github_org', org)
    set({ githubOrg: org })
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
  }
}))
