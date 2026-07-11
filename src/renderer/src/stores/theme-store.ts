import { create } from 'zustand'

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'ui-theme'

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
}

function applyMode(mode: ThemeMode): 'light' | 'dark' {
  const resolved = resolveMode(mode)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
  return resolved
}

interface ThemeState {
  /** User preference: explicit light/dark or follow the OS. */
  mode: ThemeMode
  /** The concrete theme currently painted. */
  resolved: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
  /** Flip between light and dark, pinning an explicit preference. */
  toggle: () => void
}

const initialMode: ThemeMode = (() => {
  try {
    return (localStorage.getItem(STORAGE_KEY) as ThemeMode | null) ?? 'dark'
  } catch {
    return 'dark'
  }
})()

export const useThemeStore = create<ThemeState>((set, get) => {
  // Apply immediately (the index.html pre-paint script already set the class to
  // avoid FOUC — this keeps the store authoritative once JS boots).
  const resolved = applyMode(initialMode)

  // Keep "system" mode reactive to OS-level changes.
  if (typeof window !== 'undefined') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (get().mode === 'system') {
        set({ resolved: applyMode('system') })
      }
    })
  }

  return {
    mode: initialMode,
    resolved,
    setMode: (mode) => {
      try { localStorage.setItem(STORAGE_KEY, mode) } catch { /* ignore */ }
      set({ mode, resolved: applyMode(mode) })
    },
    toggle: () => {
      const next: ThemeMode = get().resolved === 'dark' ? 'light' : 'dark'
      try { localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
      set({ mode: next, resolved: applyMode(next) })
    }
  }
})
