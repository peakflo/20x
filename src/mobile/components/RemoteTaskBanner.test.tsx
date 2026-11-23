import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RemoteTaskBanner } from './RemoteTaskBanner'
import type { RemoteTaskState } from '@shared/enterprise-runners'

afterEach(cleanup)
const state = (o: Partial<RemoteTaskState> = {}): RemoteTaskState => ({
  taskId: 't', serverTaskId: 's', remoteSessionId: 'r', runnerId: 'r1', runnerName: 'studio-mac', harness: 'claude-code',
  sync: 'live', lastSyncedAt: 1000, sessionStatus: 'running', webUrl: 'https://app.peakflo.ai/t/1', branch: null, usageLine: null, ...o
})

describe('RemoteTaskBanner', () => {
  it('shows runner chip, sync badge and Open in Spaces', () => {
    render(<RemoteTaskBanner state={state()} now={5000} />)
    expect(screen.getByTestId('runner-chip').textContent).toContain('studio-mac · Claude Code')
    expect(screen.getByTestId('sync-badge').textContent).toContain('Synced')
    expect(screen.getByText(/Open in Spaces/).getAttribute('href')).toBe('https://app.peakflo.ai/t/1')
  })
  it('completed on Spaces has no complete action', () => {
    render(<RemoteTaskBanner state={state({ sync: 'completed-on-spaces', completedBy: 'Priya A.' })} />)
    expect(screen.getByTestId('banner-completed').textContent).toContain('Completed on Spaces')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/^Complete task/i)).toBeNull()
  })
  it('renders offline / web-edit / paused banners', () => {
    const { rerender } = render(<RemoteTaskBanner state={state({ sync: 'runner-offline' })} />)
    expect(screen.getByTestId('banner-runner-offline')).toBeTruthy()
    rerender(<RemoteTaskBanner state={state({ sync: 'edited-on-web', editedOnWebBy: 'Priya A.' })} />)
    expect(screen.getByTestId('banner-edited-on-web')).toBeTruthy()
    rerender(<RemoteTaskBanner state={state({ sync: 'sync-paused' })} />)
    expect(screen.getByTestId('banner-sync-paused')).toBeTruthy()
  })
  it('shows the remote branch and PR instead of a diff', () => {
    render(<RemoteTaskBanner state={state({ branch: { branch: 'fix/x', repository: null, commitsAhead: 3, prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, prState: 'open', ciState: 'passing', files: [] } })} />)
    expect(screen.getByTestId('remote-branch-panel').textContent).toContain('fix/x')
    expect(screen.getByText(/Open PR #1/)).toBeTruthy()
  })
})
