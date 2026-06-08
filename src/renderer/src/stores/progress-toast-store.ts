import { create } from 'zustand'

export type ProgressToastStatus = 'running' | 'done' | 'error'

export interface ProgressToast {
  id: string
  /** Short title shown in the header, e.g. "Setting up agent" or "Running task" */
  title: string
  /** Longer status line, e.g. "Installing OpenCode..." */
  message: string
  /** 0–100 */
  percent: number
  status: ProgressToastStatus
  /** Timestamp when the toast was created — used for ordering */
  createdAt: number
  /** Whether the user dismissed this toast */
  dismissed: boolean
}

interface ProgressToastState {
  toasts: Map<string, ProgressToast>

  /**
   * Show or restart a progress toast.
   * If a toast with the same id already exists it is replaced.
   */
  show: (id: string, title: string, message?: string) => void

  /** Merge partial updates into an existing toast. */
  update: (id: string, patch: Partial<Pick<ProgressToast, 'title' | 'message' | 'percent' | 'status'>>) => void

  /** Mark a toast as done (100 %). Auto-removed after 4 s. */
  finish: (id: string, message?: string) => void

  /** Mark a toast as failed. */
  fail: (id: string, message: string) => void

  /** Hide a toast without removing it (user clicked X while running). */
  dismiss: (id: string) => void

  /** Fully remove a toast from the map. */
  remove: (id: string) => void
}

export const useProgressToastStore = create<ProgressToastState>((set, get) => ({
  toasts: new Map(),

  show: (id, title, message = '') => {
    set((s) => {
      const next = new Map(s.toasts)
      next.set(id, {
        id,
        title,
        message,
        percent: 0,
        status: 'running',
        createdAt: Date.now(),
        dismissed: false
      })
      return { toasts: next }
    })
  },

  update: (id, patch) => {
    set((s) => {
      const existing = s.toasts.get(id)
      if (!existing) return s
      const next = new Map(s.toasts)
      next.set(id, { ...existing, ...patch })
      return { toasts: next }
    })
  },

  finish: (id, message) => {
    set((s) => {
      const existing = s.toasts.get(id)
      if (!existing) return s
      const next = new Map(s.toasts)
      next.set(id, { ...existing, status: 'done', percent: 100, ...(message ? { message } : {}) })
      return { toasts: next }
    })
    // Auto-remove after 4 s
    setTimeout(() => get().remove(id), 4000)
  },

  fail: (id, message) => {
    set((s) => {
      const existing = s.toasts.get(id)
      if (!existing) return s
      const next = new Map(s.toasts)
      next.set(id, { ...existing, status: 'error', message })
      return { toasts: next }
    })
  },

  dismiss: (id) => {
    set((s) => {
      const existing = s.toasts.get(id)
      if (!existing) return s
      const next = new Map(s.toasts)
      next.set(id, { ...existing, dismissed: true })
      return { toasts: next }
    })
  },

  remove: (id) => {
    set((s) => {
      if (!s.toasts.has(id)) return s
      const next = new Map(s.toasts)
      next.delete(id)
      return { toasts: next }
    })
  }
}))
