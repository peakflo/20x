import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import type { ProviderUsageLimits, UsageSummary } from '@shared/usage'

const listeners: {
  limits: ((limits: ProviderUsageLimits) => void) | null
  recorded: (() => void) | null
} = { limits: null, recorded: null }

const getLimits = vi.fn()
const refreshLimits = vi.fn()
const getSummary = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  usageApi: {
    getLimits: (...args: unknown[]) => getLimits(...args),
    refreshLimits: (...args: unknown[]) => refreshLimits(...args),
    getSummary: (...args: unknown[]) => getSummary(...args)
  },
  onUsageLimitsUpdated: (cb: (limits: ProviderUsageLimits) => void) => {
    listeners.limits = cb
    return () => { listeners.limits = null }
  },
  onUsageRecorded: (cb: () => void) => {
    listeners.recorded = cb
    return () => { listeners.recorded = null }
  }
}))

import { UsageSettings } from './UsageSettings'

const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000 + 30_000).toISOString()

const claude: ProviderUsageLimits = {
  provider: 'claude-code',
  checkedAt: new Date().toISOString(),
  planType: 'max',
  windows: [
    { id: 'five_hour', kind: 'session', label: '5-hour', usedPercent: 42, resetsAt: inTwoHours, windowDurationMins: 300 },
    { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 91, resetsAt: null, windowDurationMins: 10_080 }
  ],
  unavailable: null
}

const codexUnsupported: ProviderUsageLimits = {
  provider: 'codex',
  checkedAt: new Date().toISOString(),
  windows: [],
  unavailable: { reason: 'unsupported', message: 'Codex did not report plan limits for this login.' }
}

const aggregate = {
  inputTokens: 1_200,
  cacheReadTokens: 80_000,
  cacheWriteTokens: 4_000,
  outputTokens: 9_000,
  reasoningTokens: 2_000,
  costUsd: 3.21,
  records: 4,
  unpricedRecords: 1
}

const summary: UsageSummary = {
  sinceMs: 0,
  untilMs: 1,
  totals: aggregate,
  byProvider: [{ provider: 'claude-code', ...aggregate }],
  byModel: [{ provider: 'claude-code', model: 'claude-opus-4-7', ...aggregate }],
  byDay: [{ day: '2026-10-04', ...aggregate }, { day: '2026-10-05', ...aggregate }],
  topTasks: [{ taskId: 't1', title: 'Fix login flow', ...aggregate }]
}

beforeEach(() => {
  cleanup()
  getLimits.mockReset().mockResolvedValue([claude, codexUnsupported])
  refreshLimits.mockReset().mockResolvedValue({ limits: [claude, codexUnsupported], refreshed: [] })
  getSummary.mockReset().mockResolvedValue(summary)
})

describe('UsageSettings', () => {
  it('shows plan-limit windows with usage and reset time', async () => {
    render(<UsageSettings />)

    expect(await screen.findByTestId('usage-limits-claude-code')).toBeInTheDocument()
    expect(screen.getByText('Max')).toBeInTheDocument()
    expect(screen.getByText(/42% used · resets in 2h 0m/)).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Weekly: 91% used' })).toBeInTheDocument()
    expect(screen.getByText('Codex did not report plan limits for this login.')).toBeInTheDocument()
    // Opening the view triggers an automatic (non-forced) check.
    await waitFor(() => expect(refreshLimits).toHaveBeenCalled())
    expect(refreshLimits.mock.calls[0][0]).toBeUndefined()
  })

  it('forces a re-check from the Refresh button', async () => {
    render(<UsageSettings />)
    await screen.findByTestId('usage-limits-claude-code')
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(refreshLimits).toHaveBeenCalledWith({ force: true }))
  })

  it('shows token totals, per-model rows and top tasks with an estimate disclaimer', async () => {
    render(<UsageSettings />)
    expect(await screen.findByText('$3.21', { selector: 'div' })).toBeInTheDocument()
    expect(screen.getByText('partial — Codex does not report cost')).toBeInTheDocument()
    expect(screen.getByText('claude-opus-4-7')).toBeInTheDocument()
    expect(screen.getByText('Fix login flow')).toBeInTheDocument()
    expect(screen.getByText(/subscription plans bill separately/)).toBeInTheDocument()
  })

  it('reloads the summary for a different period', async () => {
    render(<UsageSettings />)
    await screen.findByText('claude-opus-4-7')
    const before = getSummary.mock.calls.length
    fireEvent.click(screen.getByRole('tab', { name: '30 days' }))
    await waitFor(() => expect(getSummary.mock.calls.length).toBeGreaterThan(before))
    const query = getSummary.mock.calls.at(-1)?.[0] as { sinceMs: number; untilMs: number }
    expect(query.untilMs - query.sinceMs).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000)
  })

  it('applies live plan-limit updates', async () => {
    render(<UsageSettings />)
    await screen.findByTestId('usage-limits-claude-code')
    act(() => {
      listeners.limits?.({
        ...claude,
        windows: [{ ...claude.windows[0], usedPercent: 77 }, claude.windows[1]]
      })
    })
    expect(await screen.findByText(/77% used/)).toBeInTheDocument()
  })

  it('shows an empty state without limits or usage', async () => {
    getLimits.mockResolvedValue([])
    refreshLimits.mockResolvedValue({ limits: [], refreshed: [] })
    getSummary.mockResolvedValue({ ...summary, totals: { ...aggregate, records: 0 } })
    render(<UsageSettings />)
    expect(await screen.findByText('No plan limits yet')).toBeInTheDocument()
    expect(screen.getByText(/No token usage recorded in this period/)).toBeInTheDocument()
  })
})
