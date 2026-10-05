import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserSessionImportPanel } from './BrowserSessionImportPanel'

const listImportSources = vi.fn()
const importSessions = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  listImportSources.mockResolvedValue([{ id: 'chrome', name: 'Chrome', profiles: [{ id: 'Default', name: 'Default' }] }])
  importSessions.mockResolvedValue({ imported: 2, skipped: 0, unsupportedWindowsCookies: 0, byDomain: { 'portal.example.com': 2 } })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { browser: { listImportSources, importSessions } } })
})
afterEach(cleanup)

describe('browser session import panel', () => {
  it('defaults to the open page domain and reloads after importing', async () => {
    const onImported = vi.fn()
    render(<BrowserSessionImportPanel domain="portal.example.com" onClose={vi.fn()} onImported={onImported} />)
    expect((screen.getByLabelText('Selected domains') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Domains') as HTMLInputElement).value).toBe('portal.example.com')
    await screen.findByRole('option', { name: 'Chrome' })
    fireEvent.change(screen.getByLabelText('Browser'), { target: { value: 'chrome' } })
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'Default' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import sessions' }))
    await waitFor(() => expect(importSessions).toHaveBeenCalledWith({ browserId: 'chrome', profileId: 'Default', domains: ['portal.example.com'] }))
    expect(onImported).toHaveBeenCalledOnce()
  })

  it('requires an explicit all-sites choice and shows the exposure warning', async () => {
    render(<BrowserSessionImportPanel domain="portal.example.com" onClose={vi.fn()} onImported={vi.fn()} />)
    await screen.findByRole('option', { name: 'Chrome' })
    fireEvent.click(screen.getByLabelText('All sites'))
    expect(screen.getByText(/including email, banking, and single sign-on/)).toBeTruthy()
  })
})
