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
  useThemeStore.getState().setDesktopBackdrop(false)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('offers and persists the optional macOS desktop backdrop across pages', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  render(<AppearanceSettings />)
  fireEvent.click(screen.getByLabelText(/Blur desktop behind app/))

  expect(localStorage.getItem('ui-desktop-backdrop')).toBe('true')
  expect(screen.getByLabelText(/Blur desktop behind app/)).toBeChecked()
})

it('persists the opacity chosen in Appearance settings', () => {
  render(<AppearanceSettings />)
  fireEvent.change(screen.getByLabelText('Glass opacity'), { target: { value: '100' } })

  expect(screen.getByText('100%')).toBeInTheDocument()
  expect(localStorage.getItem('ui-glass-opacity')).toBe('100')
  expect(document.documentElement).toHaveClass('glass-solid-mode')
})
