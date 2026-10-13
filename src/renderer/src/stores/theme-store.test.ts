import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('desktop backdrop preference', () => {
  it('carries the existing Canvas preference to the app-wide setting', async () => {
    const stored = new Map([['ui-canvas-desktop-backdrop', 'true']])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value)
    })
    vi.resetModules()

    const { useThemeStore } = await import('./theme-store')
    expect(useThemeStore.getState().desktopBackdrop).toBe(true)

    useThemeStore.getState().setDesktopBackdrop(false)
    expect(stored.get('ui-desktop-backdrop')).toBe('false')

    vi.resetModules()
    const { useThemeStore: reloaded } = await import('./theme-store')
    expect(reloaded.getState().desktopBackdrop).toBe(false)
  })
})
