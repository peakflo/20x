import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { UsageParallelismResponse, UsageSummary } from '@shared/usage'

const parallelism = vi.fn()
const summaryMock = vi.fn()

vi.mock('../api/client', () => ({
  api: {
    usage: {
      parallelism: (...args: unknown[]) => parallelism(...args),
      summary: (...args: unknown[]) => summaryMock(...args)
    }
  }
}))

vi.mock('../api/websocket', () => ({ onEvent: vi.fn(() => () => undefined) }))

import { UsageHeroSection } from './UsageHeroSection'

const aggregate = {
  inputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 500_000,
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
  topTasks: []
}

function response(overrides: Partial<UsageParallelismResponse['parallelism']> = {}): UsageParallelismResponse {
  return {
    periodDays: 30,
    periodStartMs: 0,
    periodEndMs: 1,
    tasksShipped: 9,
    countingFromMs: null,
    parallelism: {
      periodStartMs: 0,
      periodEndMs: 1,
      hasData: true,
      totalRunMs: 6 * 60 * 60 * 1000,
      wallMs: 5 * 60 * 60 * 1000,
      screenTimeMs: 2 * 60 * 60 * 1000,
      multiplier: 3,
      peak: { count: 4, atMs: Date.now(), day: '2026-01-01' },
      peakDayLanes: [{ sessionId: 's1', taskId: 't1', agentId: 'a1', provider: 'claude-code', harnessInstanceId: null, segments: [{ startFrac: 0, endFrac: 1 }] }],
      perDay: [],
      ...overrides
    }
  }
}

beforeEach(() => {
  cleanup()
  parallelism.mockReset().mockResolvedValue(response())
  summaryMock.mockReset().mockResolvedValue(summary)
  HTMLCanvasElement.prototype.toBlob = vi.fn(function (this: HTMLCanvasElement, cb: BlobCallback) {
    cb(new Blob(['stub'], { type: 'image/png' }))
  })
})

describe('UsageHeroSection (mobile, read-only)', () => {
  it('renders the hero card from the REST payload with a real multiplier in the aria-label', async () => {
    render(<UsageHeroSection />)
    const canvas = await screen.findByRole('img')
    expect(canvas.getAttribute('aria-label')).toContain('3 agents in parallel on average')
    await waitFor(() => expect(parallelism).toHaveBeenCalledWith(30, expect.any(Number)))
  })

  it('shows the empty state (not a Share button) when there is no agent-run data', async () => {
    parallelism.mockResolvedValue(response({ hasData: false, totalRunMs: 0, multiplier: null, peak: null, peakDayLanes: [] }))
    render(<UsageHeroSection />)
    expect(await screen.findByText(/Run a few agents at once/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument()
  })

  it('still renders the real canvas and Share button when agent data exists but the multiplier is not ready yet', async () => {
    parallelism.mockResolvedValue(response({ hasData: true, totalRunMs: 5000, multiplier: null, screenTimeMs: 0 }))
    render(<UsageHeroSection />)
    expect(screen.queryByText(/Run a few agents at once/)).not.toBeInTheDocument()
    const canvas = await screen.findByRole('img')
    expect(canvas.getAttribute('aria-label')).toContain('Multiplier still gathering evidence.')
    expect(screen.getByRole('button', { name: /share/i })).toBeInTheDocument()
  })

  it('offers no shape/colour/name options (read-only — just a native share action)', async () => {
    render(<UsageHeroSection />)
    await screen.findByRole('img')
    expect(screen.queryByText('Shape')).not.toBeInTheDocument()
    expect(screen.queryByText('Colour')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/name on the card/i)).not.toBeInTheDocument()
  })

  it('uses navigator.share with the PNG file when the Web Share API can share files', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const canShare = vi.fn(() => true)
    Object.defineProperty(navigator, 'share', { value: share, configurable: true })
    Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true })

    render(<UsageHeroSection />)
    const shareButton = await screen.findByRole('button', { name: /share/i })
    shareButton.click()

    await waitFor(() => expect(share).toHaveBeenCalled())
    const call = share.mock.calls[0][0] as { files: File[] }
    expect(call.files[0]).toBeInstanceOf(File)
    expect(call.files[0].type).toBe('image/png')
  })

  it('falls back to opening the image for long-press save when the Web Share API is unavailable', async () => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true })
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true })
    const openSpy = vi.fn()
    vi.stubGlobal('open', openSpy)
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:stub') })

    render(<UsageHeroSection />)
    const shareButton = await screen.findByRole('button', { name: /share/i })
    shareButton.click()

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('blob:stub', '_blank'))
  })
})
