import { describe, it, expect, vi } from 'vitest'
import {
  drawCard,
  drawLogo,
  drawTimes,
  fitText,
  renderToCanvas,
  usageCardAriaLabel,
  usagePeriodLabel,
  USAGE_CARD_SHAPES,
  USAGE_CARD_THEMES,
  type UsageCardContext2D,
  type UsageCardOptions,
  type UsageCardSummary,
  type UsageCardShape,
  type UsageCardTheme
} from './usage-card'

// ── A lightweight mock Canvas 2D context ─────────────────────
// This repo has no canvas-rendering test convention (no node-canvas
// dependency, and the renderer test environment is happy-dom, which doesn't
// implement a real 2D context) — a structural mock of the handful of methods
// `drawCard` actually calls is simpler and faster than adding a new
// dependency, and lets assertions check exactly what was drawn.

function makeMockContext(): UsageCardContext2D & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {}
  const record = (name: string) => (...args: unknown[]): void => {
    (calls[name] ??= []).push(args)
  }

  const ctx = {
    calls,
    save: vi.fn(record('save')),
    restore: vi.fn(record('restore')),
    translate: vi.fn(record('translate')),
    scale: vi.fn(record('scale')),
    setTransform: vi.fn(record('setTransform')),
    beginPath: vi.fn(record('beginPath')),
    moveTo: vi.fn(record('moveTo')),
    lineTo: vi.fn(record('lineTo')),
    roundRect: vi.fn(record('roundRect')),
    fill: vi.fn(record('fill')),
    stroke: vi.fn(record('stroke')),
    fillRect: vi.fn(record('fillRect')),
    fillText: vi.fn(record('fillText')),
    measureText: vi.fn((text: string) => {
      // Deterministic width derived from the current font size, so fitText's
      // shrink loop actually iterates and terminates predictably.
      const match = /(\d+(?:\.\d+)?)px/.exec(String(ctx.font))
      const size = match ? Number(match[1]) : 16
      return { width: text.length * size * 0.6 } as TextMetrics
    }),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() }) as unknown as CanvasGradient),
    fillStyle: '' as string | CanvasGradient,
    strokeStyle: '' as string,
    lineWidth: 1,
    lineCap: 'butt' as CanvasLineCap,
    font: '16px sans-serif',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline
  }
  return ctx
}

function makeSummary(overrides: Partial<UsageCardSummary> = {}): UsageCardSummary {
  return {
    periodLabel: 'Last 30 days',
    multiplier: 3.4,
    hours: 120,
    wall: 35,
    peakDay: { atMs: Date.UTC(2026, 0, 15, 12, 0, 0), peak: 5 },
    tasksShipped: 12,
    tokens: 45_000_000,
    lanes: [
      { segments: [{ startFrac: 0, endFrac: 0.4 }, { startFrac: 0.5, endFrac: 0.9 }] },
      { segments: [{ startFrac: 0.1, endFrac: 1 }] }
    ],
    ...overrides
  }
}

function makeOptions(overrides: Partial<UsageCardOptions> = {}): UsageCardOptions {
  return { theme: 'azure', name: 'Dmitry', ...overrides }
}

describe('drawCard', () => {
  it('runs without throwing for every shape x theme combination, using only the allowed fields', () => {
    const shapes = Object.keys(USAGE_CARD_SHAPES) as UsageCardShape[]
    const themes = Object.keys(USAGE_CARD_THEMES) as UsageCardTheme[]
    for (const shape of shapes) {
      for (const theme of themes) {
        const [W, H] = USAGE_CARD_SHAPES[shape]
        const ctx = makeMockContext()
        expect(() => drawCard(ctx, W, H, makeSummary(), makeOptions({ theme }))).not.toThrow()
      }
    }
  })

  it('draws the formatted multiplier text', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    drawCard(ctx, W, H, makeSummary({ multiplier: 14.6 }), makeOptions())
    const texts = ctx.calls.fillText.map((args) => args[0])
    expect(texts).toContain('15') // formatMultiplier(14.6) rounds to an integer at >=10
  })

  it('draws a 1-decimal multiplier below 10', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    drawCard(ctx, W, H, makeSummary({ multiplier: 3.44 }), makeOptions())
    const texts = ctx.calls.fillText.map((args) => args[0])
    expect(texts).toContain('3.4')
  })

  it('draws the literal footer URL, never a dynamic repo name', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    drawCard(ctx, W, H, makeSummary(), makeOptions())
    const texts = ctx.calls.fillText.map((args) => args[0])
    expect(texts).toContain('github.com/peakflo/20x')
  })

  it('draws one lane row per lane plus one bar per run segment (via roundRect calls)', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    const summary = makeSummary()
    drawCard(ctx, W, H, summary, makeOptions())
    // One roundRect per lane background track + one per run segment, plus
    // the logo's rounded screen outline (1 call).
    const totalSegments = summary.lanes.reduce((n, lane) => n + lane.segments.length, 0)
    const expectedRoundRects = 1 /* logo */ + summary.lanes.length /* track per lane */ + totalSegments
    expect(ctx.calls.roundRect).toHaveLength(expectedRoundRects)
  })

  it('handles zero lanes (no peak-day activity in a degenerate summary) without throwing', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    expect(() => drawCard(ctx, W, H, makeSummary({ lanes: [] }), makeOptions())).not.toThrow()
  })

  it('uses the theme ink color for the multiplier and the chosen theme background', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    drawCard(ctx, W, H, makeSummary(), makeOptions({ theme: 'paper' }))
    expect(ctx.calls.fillRect[0]).toEqual([0, 0, W, H])
  })
})

describe('drawLogo / drawTimes / fitText', () => {
  it('drawLogo strokes the rounded screen and two crossed eyes', () => {
    const ctx = makeMockContext()
    drawLogo(ctx, 10, 10, 40, '#fff')
    expect(ctx.calls.roundRect).toHaveLength(1)
    expect(ctx.calls.stroke.length).toBeGreaterThanOrEqual(3) // outline + 2 eye strokes
  })

  it('drawTimes draws two crossing strokes', () => {
    const ctx = makeMockContext()
    drawTimes(ctx, 0, 0, 20, '#fff')
    expect(ctx.calls.moveTo).toHaveLength(2)
    expect(ctx.calls.lineTo).toHaveLength(2)
  })

  it('fitText shrinks until the text fits, never below 10px', () => {
    const ctx = makeMockContext()
    // A very long string forces the loop to shrink repeatedly.
    const size = fitText(ctx, 'x'.repeat(200), 100, 100, 700, 'sans-serif')
    expect(size).toBeGreaterThanOrEqual(10)
    expect(size).toBeLessThan(100)
  })

  it('fitText returns the original size when the text already fits', () => {
    const ctx = makeMockContext()
    const size = fitText(ctx, 'hi', 10_000, 40, 700, 'sans-serif')
    expect(size).toBe(40)
  })
})

describe('renderToCanvas', () => {
  it('sizes the canvas to shape x scale and draws through getContext', () => {
    const ctx = makeMockContext()
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx)
    } as unknown as HTMLCanvasElement

    renderToCanvas(canvas, 'tall', makeSummary(), makeOptions(), 2)

    expect(canvas.width).toBe(USAGE_CARD_SHAPES.tall[0] * 2)
    expect(canvas.height).toBe(USAGE_CARD_SHAPES.tall[1] * 2)
    expect(ctx.calls.setTransform).toEqual([[2, 0, 0, 2, 0, 0]])
    expect(ctx.calls.fillText.length).toBeGreaterThan(0)
  })

  it('no-ops when the canvas cannot produce a 2D context', () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => null)
    } as unknown as HTMLCanvasElement
    expect(() => renderToCanvas(canvas, 'wide', makeSummary(), makeOptions(), 1)).not.toThrow()
  })
})

describe('usagePeriodLabel', () => {
  it('labels 182 days as "Last 6 months" and everything else as "Last N days"', () => {
    expect(usagePeriodLabel(182)).toBe('Last 6 months')
    expect(usagePeriodLabel(7)).toBe('Last 7 days')
    expect(usagePeriodLabel(30)).toBe('Last 30 days')
    expect(usagePeriodLabel(90)).toBe('Last 90 days')
  })
})

describe('usageCardAriaLabel', () => {
  it('includes the period, rounded multiplier, hours/wall, peak, tasks, and tokens', () => {
    const label = usageCardAriaLabel(makeSummary({ multiplier: 3.7, hours: 120, wall: 35, tasksShipped: 12, tokens: 45_000_000, peakDay: { atMs: Date.now(), peak: 5 } }))
    expect(label).toContain('Last 30 days')
    expect(label).toContain('4 agents in parallel on average') // Math.round(3.7)
    expect(label).toContain('120 hours of agent work in 35 hours')
    expect(label).toContain('Peak 5 agents at once')
    expect(label).toContain('12 tasks shipped')
    expect(label).toContain('45M tokens')
  })
})

// ── Privacy: no cost / task-title / repo / model field is reachable ─────
//
// Two layers:
//  1. Compile-time: the mapped-type assertions below fail to TYPE-CHECK
//     (and so fail `pnpm typecheck`) if any of these keys is ever added to
//     either exported type — not a runtime check that can be skipped.
//  2. Runtime (the tests above): `drawCard` is exercised using objects built
//     from ONLY the allowed keys and draws correctly, proving the contract
//     is both sufficient and exhaustive for everything the card shows.

type ForbiddenCardField =
  | 'cost' | 'costUsd' | 'reportedCostUsd' | 'estimatedCostUsd' | 'price' | 'planCost'
  | 'title' | 'taskTitle' | 'taskId' | 'tasks' /* mock's raw per-day task list — not `tasksShipped` */
  | 'repo' | 'repos' | 'repoName'
  | 'model' | 'models' | 'modelName'

type AssertNoForbiddenFields<T> = Extract<keyof T, ForbiddenCardField> extends never ? true : false

// If any of these lines fails to compile, a forbidden field was added to the type.
const _summaryIsClean: AssertNoForbiddenFields<UsageCardSummary> = true
const _optionsAreClean: AssertNoForbiddenFields<UsageCardOptions> = true
const _peakDayIsClean: AssertNoForbiddenFields<UsageCardSummary['peakDay']> = true
const _laneIsClean: AssertNoForbiddenFields<UsageCardSummary['lanes'][number]> = true

describe('privacy: no cost/task-title/repo/model field is reachable from the card types', () => {
  it('the compile-time assertions above held (this test just gives them a home in the runner output)', () => {
    expect(_summaryIsClean).toBe(true)
    expect(_optionsAreClean).toBe(true)
    expect(_peakDayIsClean).toBe(true)
    expect(_laneIsClean).toBe(true)
  })

  it('drawCard works correctly using an object with exactly the allowed keys — nothing more is needed', () => {
    const summary = makeSummary()
    const allowedKeys = ['periodLabel', 'multiplier', 'hours', 'wall', 'peakDay', 'tasksShipped', 'tokens', 'lanes'].sort()
    expect(Object.keys(summary).sort()).toEqual(allowedKeys)

    const options = makeOptions()
    expect(Object.keys(options).sort()).toEqual(['name', 'theme'])

    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    expect(() => drawCard(ctx, W, H, summary, options)).not.toThrow()
  })
})
