import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyGlassOpacity, clampGlassOpacity, readGlassOpacity } from '@shared/glass-settings'

describe('glass opacity', () => {
  const stored = new Map<string, string>()
  beforeEach(() => {
    stored.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key)
    })
  })
  afterEach(() => {
    applyGlassOpacity(55)
    vi.unstubAllGlobals()
  })

  it('clamps invalid values and reads the stored preference', () => {
    expect(clampGlassOpacity(Number.NaN)).toBe(55)
    expect(clampGlassOpacity(120)).toBe(100)
    expect(readGlassOpacity()).toBe(55)
    localStorage.setItem('ui-glass-opacity', '42')
    expect(readGlassOpacity()).toBe(42)
  })

  it('takes every glass surface gradually toward solid mode', () => {
    const root = document.documentElement
    applyGlassOpacity(99)
    const before = Number.parseFloat(root.style.getPropertyValue('--glass-solid-mix'))
    expect(before).toBeGreaterThan(90)
    expect(before).toBeLessThan(100)
    expect(Number(root.style.getPropertyValue('--glass-blur-factor'))).toBeGreaterThan(0)
    expect(root).not.toHaveClass('glass-solid-mode')

    applyGlassOpacity(100)
    expect(root.style.getPropertyValue('--glass-solid-mix')).toBe('100%')
    expect(root.style.getPropertyValue('--glass-blur-factor')).toBe('0')
    expect(root).toHaveClass('glass-solid-mode')
  })
})
