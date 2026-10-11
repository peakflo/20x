import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { UsageSummary } from '@shared/usage'

const limits = vi.fn()
const refreshLimits = vi.fn()
const summaryMock = vi.fn()

vi.mock('../api/client', () => ({
  api: {
    usage: {
      limits: (...args: unknown[]) => limits(...args),
      refreshLimits: (...args: unknown[]) => refreshLimits(...args),
      summary: (...args: unknown[]) => summaryMock(...args)
    }
  }
}))

// The shared mobile test setup stubs `onEvent` as a bare `vi.fn()` (no
// return value); this component's effect cleanup always calls what it
// returns, so give it a real unsubscribe function.
vi.mock('../api/websocket', () => ({ onEvent: vi.fn(() => () => undefined) }))

import { SubscriptionUsageSection } from './SubscriptionUsageSection'

const aggregate = {
  inputTokens: 1_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 500,
  reasoningTokens: 0,
  records: 2,
  unpricedRecords: 0,
  costUsd: 1.23,
  reportedCostUsd: null,
  estimatedCostUsd: 1.23,
  cacheSavingsUsd: null
}

const summary: UsageSummary = {
  sinceMs: 0,
  untilMs: 1,
  totals: aggregate,
  byProvider: [],
  byModel: [],
  byDay: [],
  byDayHour: [],
  topTasks: [],
  countingFromMs: null
}

beforeEach(() => {
  cleanup()
  limits.mockReset().mockResolvedValue([])
  refreshLimits.mockReset().mockResolvedValue({ limits: [], refreshed: [] })
  summaryMock.mockReset().mockResolvedValue(summary)
})

describe('SubscriptionUsageSection (mobile, read-only)', () => {
  it('shows the total tokens and estimated cost for the period', async () => {
    render(<SubscriptionUsageSection />)
    expect(await screen.findByText('1.5K tokens')).toBeInTheDocument()
    expect(screen.getByText('est. $1.23')).toBeInTheDocument()
  })

  it('shows the estimate disclaimer when cost is entirely estimated', async () => {
    render(<SubscriptionUsageSection />)
    await screen.findByText('1.5K tokens')
    expect(screen.getByText('API-equivalent estimate — not your subscription bill')).toBeInTheDocument()
  })

  it('shows a "not reported" hint when nothing could be priced at all', async () => {
    summaryMock.mockResolvedValue({ ...summary, totals: { ...aggregate, costUsd: null, reportedCostUsd: null, estimatedCostUsd: null, unpricedRecords: 2 } })
    render(<SubscriptionUsageSection />)
    await screen.findByText('1.5K tokens')
    expect(screen.getByText('not reported')).toBeInTheDocument()
  })

  it('offers no price-editing UI (read-only)', async () => {
    render(<SubscriptionUsageSection />)
    await screen.findByText('1.5K tokens')
    expect(screen.queryByText(/model prices/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/set price/i)).not.toBeInTheDocument()
  })
})
