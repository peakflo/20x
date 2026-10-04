import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { UsageLimitRecovery } from '@shared/usage-limit-recovery'

let push: ((recovery: UsageLimitRecovery) => void) | null = null
const getLimitRecovery = vi.fn()
const setLimitRecoveryAutoResume = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  usageApi: {
    getLimitRecovery: (...args: unknown[]) => getLimitRecovery(...args),
    setLimitRecoveryAutoResume: (...args: unknown[]) => setLimitRecoveryAutoResume(...args)
  },
  onUsageLimitRecoveryUpdated: (cb: (recovery: UsageLimitRecovery) => void) => {
    push = cb
    return () => { push = null }
  }
}))

import { UsageLimitRecoveryBanner } from './UsageLimitRecoveryBanner'

function recovery(overrides: Partial<UsageLimitRecovery> = {}): UsageLimitRecovery {
  return {
    taskId: 'task-1', agentId: 'a1', provider: 'claude-code', sessionId: 's1', stoppedAt: Date.now(),
    resetAt: new Date(Date.now() + 2 * 3_600_000 + 30_000).toISOString(), autoResume: true, status: 'waiting',
    message: 'limit', attempts: 0, resumedAt: null, error: null, ...overrides
  }
}

beforeEach(() => {
  cleanup()
  getLimitRecovery.mockReset()
  setLimitRecoveryAutoResume.mockReset()
})

describe('UsageLimitRecoveryBanner', () => {
  it('shows when the task will continue and lets the user cancel', async () => {
    getLimitRecovery.mockResolvedValue(recovery())
    setLimitRecoveryAutoResume.mockResolvedValue(recovery({ autoResume: false }))
    render(<UsageLimitRecoveryBanner taskId="task-1" />)

    expect(await screen.findByText('Usage limit reached')).toBeInTheDocument()
    expect(screen.getByText(/Continues automatically at .* \(in 2h 0m\)/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel auto-continue' }))
    await waitFor(() => expect(setLimitRecoveryAutoResume).toHaveBeenCalledWith('task-1', false))
    expect(await screen.findByRole('button', { name: 'Continue at reset' })).toBeInTheDocument()
  })

  it('explains a missing reset time and hides once the task continued', async () => {
    getLimitRecovery.mockResolvedValue(recovery({ resetAt: null }))
    render(<UsageLimitRecoveryBanner taskId="task-1" />)
    expect(await screen.findByText(/did not report when the limit resets/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    act(() => { push?.(recovery({ status: 'resumed' })) })
    expect(screen.queryByTestId('usage-limit-recovery-banner')).not.toBeInTheDocument()
  })

  it('ignores updates for other tasks and renders nothing without a recovery', async () => {
    getLimitRecovery.mockResolvedValue(null)
    render(<UsageLimitRecoveryBanner taskId="task-1" />)
    await waitFor(() => expect(getLimitRecovery).toHaveBeenCalled())
    act(() => { push?.(recovery({ taskId: 'other' })) })
    expect(screen.queryByTestId('usage-limit-recovery-banner')).not.toBeInTheDocument()
  })
})
