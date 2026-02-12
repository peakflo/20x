import { create } from 'zustand'
import { taskSourceApi, settingsApi } from '@/lib/ipc-client'
import type { SourceUser } from '@/types'

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

interface CacheEntry {
  users: SourceUser[]
  fetchedAt: number
}

interface UserStore {
  cache: Map<string, CacheEntry>
  loadingSourceIds: Set<string>
  currentUserEmail: string | null
  cacheVersion: number

  fetchUsers: (sourceId: string) => Promise<SourceUser[]>
  getUsersForSource: (sourceId: string) => SourceUser[]
  isMe: (nameOrEmail: string) => boolean
  loadCurrentUser: () => Promise<void>
  invalidateCache: () => void
}

export const useUserStore = create<UserStore>((set, get) => ({
  cache: new Map(),
  loadingSourceIds: new Set(),
  currentUserEmail: null,
  cacheVersion: 0,

  fetchUsers: async (sourceId: string) => {
    const { cache, loadingSourceIds } = get()

    // Return cached if fresh
    const cached = cache.get(sourceId)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return cached.users
    }

    // Dedup in-flight
    if (loadingSourceIds.has(sourceId)) {
      return cached?.users ?? []
    }

    set({ loadingSourceIds: new Set([...loadingSourceIds, sourceId]) })

    try {
      const users = await taskSourceApi.getUsers(sourceId)
      const newCache = new Map(get().cache)
      newCache.set(sourceId, { users, fetchedAt: Date.now() })
      set({ cache: newCache })
      return users
    } catch (err) {
      console.error('[user-store] Failed to fetch users:', err)
      return cached?.users ?? []
    } finally {
      const updated = new Set(get().loadingSourceIds)
      updated.delete(sourceId)
      set({ loadingSourceIds: updated })
    }
  },

  getUsersForSource: (sourceId: string) => {
    return get().cache.get(sourceId)?.users ?? []
  },

  isMe: (nameOrEmail: string) => {
    const email = get().currentUserEmail
    if (!email || !nameOrEmail) return false
    const lower = nameOrEmail.toLowerCase()
    return lower === email.toLowerCase() || lower.includes(email.toLowerCase())
  },

  loadCurrentUser: async () => {
    try {
      const email = await settingsApi.get('current_user_email')
      set({ currentUserEmail: email })
    } catch {
      // ignore
    }
  },

  invalidateCache: () => {
    set((state) => ({ cache: new Map(), cacheVersion: state.cacheVersion + 1 }))
  }
}))
