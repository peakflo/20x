import { create } from 'zustand'
import type { Secret, CreateSecretDTO, UpdateSecretDTO } from '@/types'
import { secretApi } from '@/lib/ipc-client'

interface SecretState {
  secrets: Secret[]
  isLoading: boolean
  error: string | null
  /** null = not checked yet. Re-checked on every create/update attempt, so a keychain that unlocks mid-session is picked up without a restart. */
  encryptionAvailable: boolean | null

  fetchSecrets: () => Promise<void>
  checkEncryptionAvailable: () => Promise<boolean>
  createSecret: (data: CreateSecretDTO) => Promise<Secret | null>
  updateSecret: (id: string, data: UpdateSecretDTO) => Promise<Secret | null>
  deleteSecret: (id: string) => Promise<boolean>
}

export const useSecretStore = create<SecretState>((set) => ({
  secrets: [],
  isLoading: false,
  error: null,
  encryptionAvailable: null,

  fetchSecrets: async () => {
    set({ isLoading: true, error: null })
    try {
      const secrets = await secretApi.getAll()
      set({ secrets, isLoading: false })
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
    void useSecretStore.getState().checkEncryptionAvailable()
  },

  checkEncryptionAvailable: async () => {
    try {
      const available = await secretApi.encryptionAvailable()
      set({ encryptionAvailable: available })
      return available
    } catch {
      // Treat an unexpected IPC failure as "unknown", not "unavailable" —
      // surfacing a false alarm is worse than staying silent until the next check.
      return true
    }
  },

  createSecret: async (data) => {
    try {
      const secret = await secretApi.create(data)
      set((state) => ({ secrets: [...state.secrets, secret], error: null }))
      return secret
    } catch (err) {
      set({ error: String(err) })
      return null
    } finally {
      void useSecretStore.getState().checkEncryptionAvailable()
    }
  },

  updateSecret: async (id, data) => {
    try {
      const updated = await secretApi.update(id, data)
      if (updated) {
        set((state) => ({
          secrets: state.secrets.map((s) => (s.id === id ? updated : s)),
          error: null
        }))
      }
      return updated || null
    } catch (err) {
      set({ error: String(err) })
      return null
    } finally {
      void useSecretStore.getState().checkEncryptionAvailable()
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
