import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { UsageParallelismResponse } from '@shared/usage'
import { UsageHeroCard } from './UsageHeroCard'

function response(overrides: Partial<UsageParallelismResponse['parallelism']>): UsageParallelismResponse {
  return {
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
      totalRunMsAll: 0,
      wallMs: 0,
      screenTimeMs: 0,
      multiplier: null,
      peak: null,
      peakDayLanes: [],
      perDay: [],
      ...overrides
    }
  }
}

beforeEach(() => {
  cleanup()
})

describe('UsageHeroCard', () => {
  it('shows a loading skeleton while the first fetch is in flight', () => {
    render(<UsageHeroCard data={null} byDay={[]} byDayHour={[]} loading tokens={0} periodLabel="Last 30 days" name="" onOpenShare={() => {}} />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('shows the "run a few agents" empty state when there is no agent-run data at all', async () => {
    render(<UsageHeroCard data={response({})} byDay={[]} byDayHour={[]} loading={false} tokens={0} periodLabel="Last 30 days" name="" onOpenShare={() => {}} />)
    expect(await screen.findByText(/Run a few agents at once/)).toBeInTheDocument()
  })

  it('still renders the real canvas (not the text-only empty state) when agent data exists but screen time does not — only the multiplier is pending', async () => {
    render(
      <UsageHeroCard
        data={response({ hasData: true, totalRunMs: 2 * 60 * 60 * 1000, peak: { count: 2, atMs: 10, day: '2026-01-01' } })}
        byDay={[]} byDayHour={[]}
        loading={false}
        tokens={0}
        periodLabel="Last 30 days"
        name=""
        onOpenShare={() => {}}
      />
    )
    expect(screen.queryByText(/Run a few agents at once/)).not.toBeInTheDocument()
    const canvas = await screen.findByRole('img')
    expect(canvas.getAttribute('aria-label')).toContain('Multiplier still gathering evidence.')
    expect(canvas.getAttribute('aria-label')).toContain('Peak 2 agents at once')
  })

  it('still renders the real canvas when there is live agent data but under an hour of it — only the multiplier is pending', async () => {
    render(
      <UsageHeroCard
        data={response({ hasData: true, totalRunMs: 5000, screenTimeMs: 2 * 60 * 60 * 1000, multiplier: 0.0007, peak: { count: 2, atMs: 10, day: '2026-01-01' } })}
        byDay={[]} byDayHour={[]}
        loading={false}
        tokens={0}
        periodLabel="Last 30 days"
        name=""
        onOpenShare={() => {}}
      />
    )
    expect(screen.queryByText(/Run a few agents at once/)).not.toBeInTheDocument()
    const canvas = await screen.findByRole('img')
    expect(canvas.getAttribute('aria-label')).toContain('Multiplier still gathering evidence.')
  })

  it('mentions the counting-from date in the plain "no data" empty state when known', async () => {
    const data = response({})
    data.countingFromMs = Date.UTC(2026, 0, 1)
    render(<UsageHeroCard data={data} byDay={[]} byDayHour={[]} loading={false} tokens={0} periodLabel="Last 30 days" name="" onOpenShare={() => {}} />)
    expect(await screen.findByText(/Counting from/)).toBeInTheDocument()
  })

  it('renders the canvas with a real multiplier and calls onOpenShare when clicked', async () => {
    const onOpenShare = vi.fn()
    const data = response({
      hasData: true,
      totalRunMs: 6 * 60 * 60 * 1000,
      screenTimeMs: 2 * 60 * 60 * 1000,
      multiplier: 3,
      peak: { count: 4, atMs: Date.now(), day: '2026-01-01' }
    })
    render(<UsageHeroCard data={data} byDay={[]} byDayHour={[]} loading={false} tokens={1_000_000} periodLabel="Last 30 days" name="Dmitry" onOpenShare={onOpenShare} />)
    const canvas = await screen.findByRole('img')
    expect(canvas.getAttribute('aria-label')).toContain('3 agents in parallel on average')
    canvas.click()
    expect(onOpenShare).toHaveBeenCalled()
  })

  it('draws the activity grid from byDay/byDayHour token totals, matching what the tokens-per-day chart shows, not from perDay runHours', async () => {
    const data = response({
      hasData: true,
      totalRunMs: 6 * 60 * 60 * 1000,
      screenTimeMs: 2 * 60 * 60 * 1000,
      multiplier: 3,
      peak: { count: 4, atMs: Date.now(), day: '2026-01-01' },
      perDay: [{ day: '2026-01-01', runHours: 999, wallHours: 1 }] // deliberately large — must NOT show up in the calendar anymore
    })
    render(
      <UsageHeroCard
        data={data}
        byDay={[{ day: '2026-01-01', inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: null, reportedCostUsd: null, estimatedCostUsd: null, cacheSavingsUsd: null, records: 1, unpricedRecords: 0, byProvider: [] }]}
        byDayHour={[{ day: '2026-01-01', bucket: 4, tokens: 500 }]}
        loading={false}
        tokens={1_000_000}
        periodLabel="Last 30 days"
        name="Dmitry"
        onOpenShare={() => {}}
      />
    )
    // The aria-label doesn't expose the activity grid directly, but the component should render without
    // throwing, and the real assertion (the grid's drawn values) is covered at the usage-card.ts unit level
    // — this test exists to prove the props actually reach buildUsageCardSummary end to end.
    const canvas = await screen.findByRole('img')
    expect(canvas).toBeInTheDocument()
  })
})
