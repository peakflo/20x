import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppearanceSettings } from './AppearanceSettings'
import { useThemeStore } from '@/stores/theme-store'

const stored = new Map<string, string>()
beforeEach(() => {
  stored.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value)
  })
})
afterEach(() => {
  cleanup()
  useThemeStore.getState().setGlassOpacity(55)
  vi.unstubAllGlobals()
})

it('persists the opacity chosen in Appearance settings', () => {
  render(<AppearanceSettings />)
  fireEvent.change(screen.getByLabelText('Glass opacity'), { target: { value: '100' } })

  expect(screen.getByText('100%')).toBeInTheDocument()
  expect(localStorage.getItem('ui-glass-opacity')).toBe('100')
  expect(document.documentElement).toHaveClass('glass-solid-mode')
})
