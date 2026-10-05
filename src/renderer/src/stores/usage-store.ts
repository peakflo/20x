import { create } from 'zustand'
import type { ProviderUsageLimits, UsageLimitsRefreshResult } from '@shared/usage'
import { onUsageLimitsUpdated, usageApi } from '@/lib/ipc-client'

const ENABLE_CURSOR_KEYCHAIN_ACTION = 'enable-cursor-keychain'

interface UsageState {
  /** Latest plan-limit snapshot per harness instance. */
  limits: ProviderUsageLimits[]
  loaded: boolean
  refreshing: boolean
  error: string | null

  /** Loads limits and subscribes to live updates. Returns an unsubscribe function. */
  init: () => () => void
  /** Re-reads plan limits. `force` = manual refresh; otherwise throttled in the main process. */
  refresh: (force?: boolean) => Promise<void>
  /** Runs a provider action offered on a limits card (e.g. allow Cursor Keychain access). */
  runAction: (actionId: string) => Promise<void>
  /** Applies a pushed snapshot (exported for tests). */
  upsert: (limits: ProviderUsageLimits) => void
}

function sortLimits(limits: ProviderUsageLimits[]): ProviderUsageLimits[] {
  return [...limits].sort((a, b) =>
    a.provider.localeCompare(b.provider) || (a.instanceId ?? '').localeCompare(b.instanceId ?? '')
  )
}

let subscribers = 0
let unsubscribeIpc: (() => void) | null = null

export const useUsageStore = create<UsageState>((set, get) => {
  const applyResult = (result: UsageLimitsRefreshResult): void => {
    set({ limits: sortLimits(result.limits) })
  }

  return {
    limits: [],
    loaded: false,
    refreshing: false,
    error: null,

    init: () => {
      subscribers++
      if (subscribers === 1) {
        try {
          unsubscribeIpc = onUsageLimitsUpdated((limits) => get().upsert(limits))
        } catch (err) {
          console.warn('[usage-store] Live plan-limit updates unavailable:', err)
        }
        void (async () => {
          try {
            const limits = await usageApi.getLimits()
            set({ limits: sortLimits(limits), loaded: true })
          } catch (err) {
            set({ loaded: true, error: err instanceof Error ? err.message : String(err) })
          }
          await get().refresh(false)
        })()
      }
      return () => {
        subscribers = Math.max(0, subscribers - 1)
        if (subscribers === 0) {
          unsubscribeIpc?.()
          unsubscribeIpc = null
        }
      }
    },

    refresh: async (force = false) => {
      if (force) set({ refreshing: true, error: null })
      try {
        applyResult(force ? await usageApi.refreshLimits({ force: true }) : await usageApi.refreshLimits())
      } catch (err) {
        if (force) set({ error: err instanceof Error ? err.message : String(err) })
      } finally {
        if (force) set({ refreshing: false })
      }
    },

    runAction: async (actionId) => {
      if (actionId !== ENABLE_CURSOR_KEYCHAIN_ACTION) return
      set({ refreshing: true, error: null })
      try {
        applyResult(await usageApi.setCursorKeychainAccess(true))
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      } finally {
        set({ refreshing: false })
      }
    },

    upsert: (limits) => {
      set((state) => ({
        limits: sortLimits([...state.limits.filter((l) => (l.instanceId ?? l.provider) !== (limits.instanceId ?? limits.provider)), limits])
      }))
    }
  }
})
