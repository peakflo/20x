import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import type { ProviderUsageLimits, UsageParallelismResponse, UsageSummary } from '@shared/usage'

const listeners: {
  limits: ((limits: ProviderUsageLimits) => void) | null
  recorded: (() => void) | null
} = { limits: null, recorded: null }

const getLimits = vi.fn()
const refreshLimits = vi.fn()
const getSummary = vi.fn()
const getParallelismSummary = vi.fn()
const setCursorKeychainAccess = vi.fn()
const refreshRates = vi.fn()
const listModelPrices = vi.fn()
const setModelPrice = vi.fn()
const resetModelPrice = vi.fn()
const copyImageToClipboard = vi.fn()
const saveImage = vi.fn()

const settingsGet = vi.fn(async () => null as string | null)
const settingsSet = vi.fn(async () => undefined)

vi.mock('@/lib/ipc-client', () => ({
  settingsApi: {
    get: (...args: unknown[]) => settingsGet(...(args as [])),
    set: (...args: unknown[]) => settingsSet(...(args as []))
  },
  usageApi: {
    getLimits: (...args: unknown[]) => getLimits(...args),
    refreshLimits: (...args: unknown[]) => refreshLimits(...args),
    getSummary: (...args: unknown[]) => getSummary(...args),
    getParallelismSummary: (...args: unknown[]) => getParallelismSummary(...args),
    setCursorKeychainAccess: (...args: unknown[]) => setCursorKeychainAccess(...args),
    refreshRates: (...args: unknown[]) => refreshRates(...args),
    listModelPrices: (...args: unknown[]) => listModelPrices(...args),
    setModelPrice: (...args: unknown[]) => setModelPrice(...args),
    resetModelPrice: (...args: unknown[]) => resetModelPrice(...args),
    copyImageToClipboard: (...args: unknown[]) => copyImageToClipboard(...args),
    saveImage: (...args: unknown[]) => saveImage(...args)
  },
  onUsageLimitsUpdated: (cb: (limits: ProviderUsageLimits) => void) => {
    listeners.limits = cb
    return () => { listeners.limits = null }
  },
  onUsageRecorded: (cb: () => void) => {
    listeners.recorded = cb
    return () => { listeners.recorded = null }
  },
  onUsageModelPricesUpdated: () => () => undefined
}))

import { UsageSettings } from './UsageSettings'
import { useUsageStore } from '@/stores/usage-store'

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
  reportedCostUsd: 3.21,
  estimatedCostUsd: null,
  cacheSavingsUsd: null,
  records: 4,
  unpricedRecords: 1
}

const summary: UsageSummary = {
  sinceMs: 0,
  untilMs: 1,
  totals: aggregate,
  byProvider: [{ provider: 'claude-code', ...aggregate }],
  byModel: [{ provider: 'claude-code', model: 'claude-opus-4-7', costSource: 'reported' as const, ...aggregate }],
  byDay: [
    { day: '2026-10-04', ...aggregate, byProvider: [{ provider: 'claude-code', tokens: 10_000 }] },
    { day: '2026-10-05', ...aggregate, byProvider: [{ provider: 'claude-code', tokens: 20_000 }] }
  ],
  topTasks: [{ taskId: 't1', title: 'Fix login flow', ...aggregate }]
}

const parallelismResponse: UsageParallelismResponse = {
  periodDays: 30,
  periodStartMs: 0,
  periodEndMs: 1,
  tasksShipped: 5,
  countingFromMs: null,
  parallelism: {
    periodStartMs: 0,
    periodEndMs: 1,
    hasData: true,
    totalRunMs: 6 * 60 * 60 * 1000,
    wallMs: 5 * 60 * 60 * 1000,
    screenTimeMs: 2 * 60 * 60 * 1000,
    multiplier: 3,
    peak: { count: 4, atMs: Date.now(), day: '2026-10-04' },
    peakDayLanes: [{ sessionId: 's1', taskId: 't1', agentId: 'a1', provider: 'claude-code', harnessInstanceId: null, segments: [{ startFrac: 0, endFrac: 1 }] }],
    perDay: []
  }
}

beforeEach(() => {
  cleanup()
  useUsageStore.setState({ limits: [], loaded: false, refreshing: false, error: null })
  getLimits.mockReset().mockResolvedValue([claude, codexUnsupported])
  refreshLimits.mockReset().mockResolvedValue({ limits: [claude, codexUnsupported], refreshed: [] })
  getSummary.mockReset().mockResolvedValue(summary)
  getParallelismSummary.mockReset().mockResolvedValue(parallelismResponse)
  refreshRates.mockReset().mockResolvedValue({ refreshed: true, fetchedAt: Date.now() })
  listModelPrices.mockReset().mockResolvedValue([])
  setModelPrice.mockReset().mockResolvedValue([])
  resetModelPrice.mockReset().mockResolvedValue([])
  copyImageToClipboard.mockReset().mockResolvedValue({ success: true })
  saveImage.mockReset().mockResolvedValue({ saved: true })
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
    expect(screen.getByText('partial — some models have no known price')).toBeInTheDocument()
    expect(screen.getByText('claude-opus-4-7')).toBeInTheDocument()
    expect(screen.getByText('Fix login flow')).toBeInTheDocument()
    expect(screen.getByText(/not your subscription bill/)).toBeInTheDocument()
  })

  it('reloads the summary for a different period', async () => {
    render(<UsageSettings />)
    await screen.findByText('claude-opus-4-7')
    const before = getSummary.mock.calls.length
    // Default period is 30 days (matches the approved mock) — click a different tab.
    fireEvent.click(screen.getByRole('tab', { name: '7 days' }))
    await waitFor(() => expect(getSummary.mock.calls.length).toBeGreaterThan(before))
    const query = getSummary.mock.calls.at(-1)?.[0] as { sinceMs: number; untilMs: number }
    expect(query.untilMs - query.sinceMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000)
    expect(query.untilMs - query.sinceMs).toBeLessThan(8 * 24 * 60 * 60 * 1000)
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

  it('runs a card action such as allowing Keychain access for Cursor', async () => {
    const cursorNeedsConsent: ProviderUsageLimits = {
      provider: 'cursor',
      checkedAt: new Date().toISOString(),
      windows: [],
      unavailable: { reason: 'unsupported', message: 'Cursor keeps its CLI login in the macOS Keychain.' },
      action: { id: 'enable-cursor-keychain', label: 'Allow Keychain access' }
    }
    getLimits.mockResolvedValue([cursorNeedsConsent])
    refreshLimits.mockResolvedValue({ limits: [cursorNeedsConsent], refreshed: [] })
    setCursorKeychainAccess.mockResolvedValue({
      limits: [{ ...cursorNeedsConsent, action: null, unavailable: null, windows: [{ id: 'total', kind: 'monthly', label: 'Monthly · Overall', usedPercent: 12 }] }],
      refreshed: ['cursor']
    })
    render(<UsageSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Allow Keychain access' }))
    await waitFor(() => expect(setCursorKeychainAccess).toHaveBeenCalledWith(true))
    expect(await screen.findByText(/12% used/)).toBeInTheDocument()
  })

  it('toggles automatic continuation after a limit reset (on by default)', async () => {
    render(<UsageSettings />)
    const toggle = await screen.findByRole('switch', { name: /Continue automatically after a limit reset/ })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    expect(settingsSet).toHaveBeenCalledWith('usage.autoResumeLimitedTasks', 'false')
  })

  it('shows an empty state without limits or usage', async () => {
    getLimits.mockResolvedValue([])
    refreshLimits.mockResolvedValue({ limits: [], refreshed: [] })
    getSummary.mockResolvedValue({ ...summary, totals: { ...aggregate, records: 0 } })
    render(<UsageSettings />)
    expect(await screen.findByText('No plan limits yet')).toBeInTheDocument()
    expect(screen.getByText(/No token usage recorded in this period/)).toBeInTheDocument()
  })

  it('marks an estimated cost and shows "No price · Set price" for a fully unpriced model', async () => {
    getSummary.mockResolvedValue({
      ...summary,
      byModel: [
        { provider: 'codex', model: 'gpt-6-astra', ...aggregate, reportedCostUsd: null, estimatedCostUsd: 0.5, costUsd: 0.5, costSource: 'estimated' as const },
        { provider: 'opencode', model: 'some-custom-model', ...aggregate, costUsd: null, reportedCostUsd: null, estimatedCostUsd: null, costSource: 'unpriced' as const }
      ]
    })
    render(<UsageSettings />)
    expect(await screen.findByText('gpt-6-astra')).toBeInTheDocument()
    expect(screen.getByTitle('Estimated from public API rates')).toBeInTheDocument()
    expect(screen.getByText(/No price · Set price/)).toBeInTheDocument()
  })

  it('opens the Model prices dialog prefilled when "Set price" is clicked', async () => {
    getSummary.mockResolvedValue({
      ...summary,
      byModel: [{ provider: 'opencode', model: 'some-custom-model', ...aggregate, costUsd: null, reportedCostUsd: null, estimatedCostUsd: null, costSource: 'unpriced' as const }]
    })
    render(<UsageSettings />)
    fireEvent.click(await screen.findByText(/No price · Set price/))
    await waitFor(() => expect(listModelPrices).toHaveBeenCalled())
    expect(await screen.findByLabelText('Model id')).toHaveValue('some-custom-model')
  })

  it('refreshing the Usage page also refreshes the rate table', async () => {
    render(<UsageSettings />)
    await screen.findByTestId('usage-limits-claude-code')
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(refreshRates).toHaveBeenCalledWith({ force: true }))
  })

  it('shows the hero card once the parallelism summary loads, with the multiplier in its aria-label', async () => {
    render(<UsageSettings />)
    const canvas = await screen.findByRole('img', { name: /agents in parallel on average/ })
    expect(canvas).toBeInTheDocument()
    expect(canvas.getAttribute('aria-label')).toContain('3 agents in parallel on average')
  })

  it('shows an inviting empty state (not 0x or NaN) when there is no agent-run data yet', async () => {
    getParallelismSummary.mockResolvedValue({
      periodDays: 30,
      periodStartMs: 0,
      periodEndMs: 1,
      tasksShipped: 0,
      countingFromMs: null,
      parallelism: {
        periodStartMs: 0,
        periodEndMs: 1,
        hasData: false,
        totalRunMs: 0,
        wallMs: 0,
        screenTimeMs: 0,
        multiplier: null,
        peak: null,
        peakDayLanes: [],
        perDay: []
      }
    })
    render(<UsageSettings />)
    expect(await screen.findByText(/Run a few agents at once/)).toBeInTheDocument()
    expect(screen.queryByText('0×')).not.toBeInTheDocument()
    expect(screen.queryByText('NaN×')).not.toBeInTheDocument()
  })

  it('shows the "Only you see this" note on Top tasks and Models — never in the shared image', async () => {
    render(<UsageSettings />)
    await screen.findByText('claude-opus-4-7')
    const notes = screen.getAllByText('Only you see this. It is never in the shared image.')
    expect(notes.length).toBeGreaterThanOrEqual(2)
  })

  it('opens the Share dialog from the top-right Share button', async () => {
    render(<UsageSettings />)
    await screen.findByText('claude-opus-4-7')
    // The hero card also has its own "Share" button overlay — pick the top-right one.
    const shareButtons = await screen.findAllByRole('button', { name: 'Share' })
    fireEvent.click(shareButtons[0])
    expect(await screen.findByText(/The image is made on your computer/)).toBeInTheDocument()
  })

  it('shows the screen-time explanation sentence, not the old "agent wall time" wording', async () => {
    render(<UsageSettings />)
    expect(await screen.findByText(/your screen time in the app/)).toBeInTheDocument()
  })
})
