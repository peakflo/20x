import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteStateBanner, RunnerChip } from './RemoteChips'
import { RemoteBranchPanel } from './RemoteBranchPanel'
import { makeRemote } from './test-fixtures'

const api = {
  listRunners: vi.fn(),
  reassign: vi.fn(),
  openLocally: vi.fn()
}

beforeEach(() => {
  api.listRunners.mockResolvedValue({ ok: true, fetchedAt: 1, runners: [
    { id: 'r2', name: 'build-box-01', kind: 'mine', status: 'online', harnesses: [], activeSessionCount: 0, lastSeenAt: null, version: null, selectable: true, serverReason: null }
  ] })
  api.reassign.mockResolvedValue({ ok: true })
  api.openLocally.mockResolvedValue({ ok: true, worktreePath: '/tmp/wt' })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { enterpriseRunners: api, shell: { openExternal: vi.fn() } }
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('RemoteStateBanner', () => {
  it('renders nothing when live', () => {
    const { container } = render(<RemoteStateBanner taskId="task-1" state={makeRemote()} />)
    expect(container.textContent).toBe('')
  })

  it('runner offline: explains queueing and reassigns', async () => {
    render(<RemoteStateBanner taskId="task-1" state={makeRemote({ sync: 'runner-offline' })} />)
    expect(screen.getByText(/will continue when it’s back/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Reassign to another runner/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /build-box-01/ }))
    await waitFor(() => expect(api.reassign).toHaveBeenCalledWith('task-1', 'r2'))
  })

  it('edited on web: both messages are sent', () => {
    render(<RemoteStateBanner taskId="task-1" state={makeRemote({ sync: 'edited-on-web', editedOnWebBy: 'Priya A.' })} />)
    expect(screen.getByText(/Priya A\./)).toBeTruthy()
    expect(screen.getByText(/Both messages are sent/)).toBeTruthy()
  })

  it('completed on Spaces: banner, no local complete action', () => {
    render(<RemoteStateBanner taskId="task-1" state={makeRemote({ sync: 'completed-on-spaces', completedBy: 'Priya A.' })} />)
    expect(screen.getByText('Completed on Spaces')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Complete$/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Reopen on Spaces/ }))
    expect((window.electronAPI as unknown as { shell: { openExternal: ReturnType<typeof vi.fn> } }).shell.openExternal).toHaveBeenCalledWith('https://app.peakflo.ai/tasks/srv-1')
  })

  it('sync paused when signed out offers sign in', () => {
    render(<RemoteStateBanner taskId="task-1" state={makeRemote({ sync: 'sync-paused' })} />)
    expect(screen.getByText('Sync paused')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
  })
})

describe('RunnerChip', () => {
  it('shows an offline suffix', () => {
    render(<RunnerChip state={makeRemote({ sync: 'runner-offline' })} />)
    expect(screen.getByTestId('runner-chip').textContent).toContain('studio-mac')
    expect(screen.getByTestId('runner-chip').textContent).toContain('offline')
  })
})

describe('RemoteBranchPanel', () => {
  it('replaces the local diff with fetch + PR actions', async () => {
    render(<RemoteBranchPanel taskId="task-1" state={makeRemote()} />)
    expect(screen.getByText(/No local diff/)).toBeTruthy()
    expect(screen.getByText('fix/invoice-sync-race')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open PR/ })).toBeTruthy()
    expect(screen.getByTestId('usage-line').textContent).toContain('48k tokens')
    fireEvent.click(screen.getByRole('button', { name: /Open locally \(fetch branch\)/ }))
    await waitFor(() => expect(api.openLocally).toHaveBeenCalledWith('task-1'))
    expect(await screen.findByText(/The task stays on the runner\./, { selector: '[role=status]' })).toBeTruthy()
  })

  it('shows the fetch error', async () => {
    api.openLocally.mockResolvedValueOnce({ ok: false, error: 'fetch failed' })
    render(<RemoteBranchPanel taskId="task-1" state={makeRemote()} />)
    fireEvent.click(screen.getByRole('button', { name: /Open locally/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('fetch failed')
  })
})
