import { create } from 'zustand'
import type { MastermindMemory, CreateMemoryDTO, UpdateMemoryDTO, ListMemoriesFilterDTO } from '@/types'
import { memoryApi } from '@/lib/ipc-client'

interface MemoryState {
  memories: MastermindMemory[]
  isLoading: boolean
  error: string | null

  fetchMemories: (filter?: ListMemoriesFilterDTO) => Promise<void>
  createMemory: (data: CreateMemoryDTO) => Promise<MastermindMemory | null>
  updateMemory: (id: string, data: UpdateMemoryDTO) => Promise<MastermindMemory | null>
  deleteMemory: (id: string) => Promise<boolean>
  clearAll: (scope?: string) => Promise<number>
  /** Puts a memory back after an Undo of a delete/save toast — a plain re-insert, not a re-dedupe. */
  restoreMemory: (memory: MastermindMemory) => void
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  isLoading: false,
  error: null,

  fetchMemories: async (filter) => {
    set({ isLoading: true, error: null })
    try {
      const memories = await memoryApi.list(filter)
      set({ memories, isLoading: false })
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  createMemory: async (data) => {
    try {
      const memory = await memoryApi.create(data)
      set((state) => ({ memories: [memory, ...state.memories] }))
      return memory
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  updateMemory: async (id, data) => {
    try {
      const updated = await memoryApi.update(id, data)
      if (updated) {
        set((state) => ({ memories: state.memories.map((m) => (m.id === id ? updated : m)) }))
      }
      return updated ?? null
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  deleteMemory: async (id) => {
    try {
      const ok = await memoryApi.delete(id)
      if (ok) set((state) => ({ memories: state.memories.filter((m) => m.id !== id) }))
      return ok
    } catch (err) {
      set({ error: String(err) })
      return false
    }
  },

  clearAll: async (scope) => {
    try {
      const removed = await memoryApi.clearAll(scope)
      const remaining = get().memories.filter((m) => (scope ? m.scope !== scope : false))
      set({ memories: remaining })
      return removed
    } catch (err) {
      set({ error: String(err) })
      return 0
    }
  },

  restoreMemory: (memory) => {
    set((state) => (state.memories.some((m) => m.id === memory.id) ? state : { memories: [memory, ...state.memories] }))
  }
}))
