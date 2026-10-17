import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CursorCliSetupDialog } from './CursorCliSetupDialog'

describe('CursorCliSetupDialog', () => {
  it('shows official install steps and retries after the CLI is detected', async () => {
    const retry = vi.fn().mockResolvedValue(undefined)
    vi.mocked(window.electronAPI.agentInstaller.detect).mockResolvedValueOnce({ cursor: { installed: true, version: '1.0' } })
    render(<CursorCliSetupDialog open taskTitle="Review crash" onOpenChange={vi.fn()} onRetry={retry} />)

    expect(screen.getByRole('dialog').textContent).toContain('cursor-agent')
    expect(screen.getByRole('dialog').textContent).toContain('not installed or is not in 20x’s PATH')
    expect(screen.getByRole('dialog').textContent).toContain('Review crash')
    expect(screen.getByText(/curl https:\/\/cursor.com\/install/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /official installation instructions/i }).getAttribute('href'))
      .toBe('https://cursor.com/docs/cli/installation')

    fireEvent.click(screen.getByRole('button', { name: 'Retry task' }))
    await waitFor(() => expect(retry).toHaveBeenCalledOnce())
  })

  it('keeps the prompt open when cursor-agent is still unavailable', async () => {
    const retry = vi.fn()
    vi.mocked(window.electronAPI.agentInstaller.detect).mockResolvedValueOnce({ cursor: { installed: false, version: null } })
    render(<CursorCliSetupDialog open taskTitle="Review crash" onOpenChange={vi.fn()} onRetry={retry} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry task' }))
    expect(await screen.findByText(/still not in 20x’s PATH/)).toBeTruthy()
    expect(retry).not.toHaveBeenCalled()
  })
})
