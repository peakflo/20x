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
    render(<UsageHeroCard data={null} loading tokens={0} periodLabel="Last 30 days" name="" onOpenShare={() => {}} />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('shows the "run a few agents" empty state when there is no agent-run data at all', async () => {
    render(<UsageHeroCard data={response({})} loading={false} tokens={0} periodLabel="Last 30 days" name="" onOpenShare={() => {}} />)
    expect(await screen.findByText(/Run a few agents at once/)).toBeInTheDocument()
  })

  it('shows a distinct "still learning your screen time" message when agent data exists but screen time does not', async () => {
    render(
      <UsageHeroCard
        data={response({ hasData: true, totalRunMs: 5000, peak: { count: 2, atMs: 10, day: '2026-01-01' } })}
        loading={false}
        tokens={0}
        periodLabel="Last 30 days"
        name=""
        onOpenShare={() => {}}
      />
    )
    expect(await screen.findByText(/Still learning your screen time/)).toBeInTheDocument()
  })

  it('mentions the counting-from date in the plain "no data" empty state when known', async () => {
    const data = response({})
    data.countingFromMs = Date.UTC(2026, 0, 1)
    render(<UsageHeroCard data={data} loading={false} tokens={0} periodLabel="Last 30 days" name="" onOpenShare={() => {}} />)
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
    render(<UsageHeroCard data={data} loading={false} tokens={1_000_000} periodLabel="Last 30 days" name="Dmitry" onOpenShare={onOpenShare} />)
    const canvas = await screen.findByRole('img')
    expect(canvas.getAttribute('aria-label')).toContain('3 agents in parallel on average')
    canvas.click()
    expect(onOpenShare).toHaveBeenCalled()
  })
})
