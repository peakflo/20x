import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: () => <div>App layout</div> }))
vi.mock('@/components/agents/CursorCliSetupDialog', () => ({
  CursorCliSetupDialog: ({ open, taskTitle, onOpenChange, onRetry }: {
    open: boolean; taskTitle: string; onOpenChange: (open: boolean) => void; onRetry: () => Promise<void>
  }) => open ? <div role="dialog"><span>{taskTitle}</span><button onClick={() => void onRetry()}>Retry</button><button onClick={() => onOpenChange(false)}>Dismiss</button></div> : null
}))
vi.mock('@/lib/analytics', () => ({
  identifyAnalyticsUser: vi.fn(), resetAnalyticsUser: vi.fn(), setAnalyticsEnterpriseEmail: vi.fn()
}))

describe('Cursor CLI prompt queue', () => {
  it('keeps the first task retry when another task fails, then shows the next task', async () => {
    const firstRetry = vi.fn().mockResolvedValue('first-session')
    const secondRetry = vi.fn().mockResolvedValue('second-session')
    render(<App />)

    act(() => {
      window.dispatchEvent(new CustomEvent('cursor-cli-missing', { detail: {
        taskId: 'task-1', taskTitle: 'Review crash', operation: 'resume', retry: firstRetry
      } }))
      window.dispatchEvent(new CustomEvent('cursor-cli-missing', { detail: {
        taskId: 'task-2', taskTitle: 'Repair build', operation: 'start', retry: secondRetry
      } }))
    })

    expect(screen.getByRole('dialog').textContent).toContain('Review crash')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(firstRetry).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('Repair build'))
    expect(secondRetry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(secondRetry).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
