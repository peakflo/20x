import { create } from 'zustand'
import type { Secret, CreateSecretDTO, UpdateSecretDTO } from '@/types'
import { secretApi } from '@/lib/ipc-client'

interface SecretState {
  secrets: Secret[]
  isLoading: boolean
  error: string | null

  fetchSecrets: () => Promise<void>
  createSecret: (data: CreateSecretDTO) => Promise<Secret | null>
  updateSecret: (id: string, data: UpdateSecretDTO) => Promise<Secret | null>
  deleteSecret: (id: string) => Promise<boolean>
}

export const useSecretStore = create<SecretState>((set) => ({
  secrets: [],
  isLoading: false,
  error: null,

  fetchSecrets: async () => {
    set({ isLoading: true, error: null })
    try {
      const secrets = await secretApi.getAll()
      set({ secrets, isLoading: false })
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  createSecret: async (data) => {
    try {
      const secret = await secretApi.create(data)
      set((state) => ({ secrets: [...state.secrets, secret] }))
      return secret
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  updateSecret: async (id, data) => {
    try {
      const updated = await secretApi.update(id, data)
      if (updated) {
        set((state) => ({
          secrets: state.secrets.map((s) => (s.id === id ? updated : s))
        }))
      }
      return updated || null
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  deleteSecret: async (id) => {
    try {
      const success = await secretApi.delete(id)
      if (success) {
        set((state) => ({
          secrets: state.secrets.filter((s) => s.id !== id)
        }))
      }
      return success
    } catch (err) {
      set({ error: String(err) })
      return false
    }
  }
}))
