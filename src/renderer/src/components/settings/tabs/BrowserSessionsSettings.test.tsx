import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BrowserSessionsSettings } from './BrowserSessionsSettings'

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { browser: { listImportSources: vi.fn(() => new Promise<never>(() => {})) } }
  })
})

describe('browser session settings', () => {
  it('starts with selected domains and warns before all-site exposure', () => {
    render(<BrowserSessionsSettings />)
    expect((screen.getByLabelText('Selected domains') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByLabelText('Domains')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('All sites'))
    expect(screen.getByText(/including email, banking, and single sign-on/)).toBeTruthy()
  })
})
