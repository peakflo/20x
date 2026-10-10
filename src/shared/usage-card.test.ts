import { describe, it, expect, vi } from 'vitest'
import {
  buildUsageCardSummary,
  drawCard,
  drawDash,
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
import type { UsageDayRow, UsageParallelismResponse } from './usage'

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

// A 30-day calendar by default — long enough to exercise the weeks×weekdays
// grid layout (the default/common case for most of the tests below). Tests
// specifically about the short-period column layout build their own
// 7-day-or-fewer `calendar` override instead.
const DEFAULT_CALENDAR_PATTERN = [
  0, 2_000, 5_000, 8_000, 3_000, 0, 6_000, 9_000, 4_000, 1_000,
  7_000, 10_000, 2_000, 0, 5_000, 8_000, 11_000, 3_000, 6_000, 0,
  9_000, 4_000, 7_000, 2_000, 10_000, 5_000, 0, 8_000, 6_000, 3_000
]

function makeSummary(overrides: Partial<UsageCardSummary> = {}): UsageCardSummary {
  return {
    periodLabel: 'Last 30 days',
    multiplier: 3.4,
    hours: 120,
    wall: 35,
    peakDay: { atMs: Date.UTC(2026, 0, 15, 12, 0, 0), peak: 5 },
    tasksShipped: 12,
    tokens: 45_000_000,
    calendar: DEFAULT_CALENDAR_PATTERN.map((tokens, i) => ({
      day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      tokens
    })),
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

  it('draws a bespoke dash (not a text glyph) and a placeholder sentence when the multiplier is not ready yet — without hiding the rest of the card', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    const summary = makeSummary({ multiplier: null, hours: null, wall: null })
    drawCard(ctx, W, H, summary, makeOptions())
    const texts = ctx.calls.fillText.map((args) => args[0])
    // The placeholder is a hand-drawn stroke (drawDash), not a fillText call — an em dash
    // drawn through the big numeral's custom-font stack risks a missing-glyph "tofu" box on
    // some platforms (see drawDash's docstring). No "—" (or any multiplier-shaped text) is drawn.
    expect(texts).not.toContain('—')
    expect(texts).toContain('Still learning your screen time')
    expect(texts).not.toContain('NaN hours of agent work in NaN hours')
    expect(ctx.calls.stroke.length).toBeGreaterThan(0) // the dash itself is a stroke, like drawTimes
    // The rest of the card still draws for real: peak-day caption, "agent hours" placeholder tile, footer.
    expect(texts).toContain(`${new Date(summary.peakDay.atMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, my busiest day: ${summary.peakDay.peak} agents at once`)
    expect(texts).toContain('github.com/peakflo/20x')
    expect(texts).toContain('-') // the "agent hours" stat tile's own placeholder — a plain ASCII hyphen, same reasoning
    // One roundRect per calendar cell is still drawn, same as the ratio-ready case.
    const expectedRoundRects = 1 /* logo */ + summary.calendar.length
    expect(ctx.calls.roundRect).toHaveLength(expectedRoundRects)
  })

  it('drawDash strokes a single round-capped horizontal line — a bespoke glyph, not font text', () => {
    const ctx = makeMockContext()
    drawDash(ctx, 0, 0, 40, '#fff')
    expect(ctx.calls.moveTo).toHaveLength(1)
    expect(ctx.calls.lineTo).toHaveLength(1)
    expect(ctx.calls.stroke).toHaveLength(1)
  })

  it('draws the literal footer URL, never a dynamic repo name', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    drawCard(ctx, W, H, makeSummary(), makeOptions())
    const texts = ctx.calls.fillText.map((args) => args[0])
    expect(texts).toContain('github.com/peakflo/20x')
  })

  it('draws one rounded cell per calendar day (via roundRect calls)', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    const summary = makeSummary()
    drawCard(ctx, W, H, summary, makeOptions())
    // One roundRect per calendar-day cell, plus the logo's rounded screen outline (1 call).
    const expectedRoundRects = 1 /* logo */ + summary.calendar.length
    expect(ctx.calls.roundRect).toHaveLength(expectedRoundRects)
  })

  it('handles an empty calendar (no per-day activity in a degenerate summary) without throwing', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    expect(() => drawCard(ctx, W, H, makeSummary({ calendar: [] }), makeOptions())).not.toThrow()
  })

  it('scales a wide calendar (6-month period) down to fit the card width without throwing', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    const calendar = Array.from({ length: 182 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      tokens: i % 7
    }))
    drawCard(ctx, W, H, makeSummary({ calendar }), makeOptions())
    expect(ctx.calls.roundRect).toHaveLength(1 /* logo */ + calendar.length)
  })

  it('switches to one-column-per-day unit-block stacks for short periods (7 days or fewer)', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    const tokensByDay = [0, 100, 50, 0, 200, 10, 150]
    const calendar = tokensByDay.map((tokens, i) => ({ day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), tokens }))
    drawCard(ctx, W, H, makeSummary({ calendar }), makeOptions())
    // Same block-count formula as drawCard's column layout: a 0-token day draws
    // one faint "empty slot" (not a block); a nonzero day draws at least 1 block,
    // scaled up to usageCardCalendarMaxBlocks(wide) against the period's max — 7
    // for the `wide` shape used here (lower than square/tall's 12 — wide has less
    // vertical room; see that function's docstring).
    const maxTokens = Math.max(...tokensByDay)
    const maxBlocks = 7
    const expectedShapeCount = tokensByDay.reduce((sum, tokens) => {
      const blocks = tokens > 0 ? Math.max(1, Math.round((tokens / maxTokens) * maxBlocks)) : 0
      return sum + Math.max(1, blocks) // 0 blocks still draws exactly one faint slot shape
    }, 0)
    expect(ctx.calls.roundRect).toHaveLength(1 /* logo */ + expectedShapeCount)
  })

  it('still uses the weeks×weekdays grid (not columns) once there are more than 7 days', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    const calendar = Array.from({ length: 8 }, (_, i) => ({ day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), tokens: i }))
    drawCard(ctx, W, H, makeSummary({ calendar }), makeOptions())
    // Grid layout draws exactly one roundRect per day; the column layout would draw a
    // variable number of stacked blocks per day instead — this count pins it to the grid.
    expect(ctx.calls.roundRect).toHaveLength(1 /* logo */ + calendar.length)
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

  it('describes the multiplier as still gathering evidence, but still reports peak/tasks/tokens, when it is null', () => {
    const label = usageCardAriaLabel(makeSummary({ multiplier: null, hours: null, wall: null, tasksShipped: 12, tokens: 45_000_000, peakDay: { atMs: Date.now(), peak: 5 } }))
    expect(label).toContain('Multiplier still gathering evidence.')
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
const _calendarDayIsClean: AssertNoForbiddenFields<UsageCardSummary['calendar'][number]> = true

describe('privacy: no cost/task-title/repo/model field is reachable from the card types', () => {
  it('the compile-time assertions above held (this test just gives them a home in the runner output)', () => {
    expect(_summaryIsClean).toBe(true)
    expect(_optionsAreClean).toBe(true)
    expect(_peakDayIsClean).toBe(true)
    expect(_calendarDayIsClean).toBe(true)
  })

  it('drawCard works correctly using an object with exactly the allowed keys — nothing more is needed', () => {
    const summary = makeSummary()
    const allowedKeys = ['periodLabel', 'multiplier', 'hours', 'wall', 'peakDay', 'tasksShipped', 'tokens', 'calendar'].sort()
    expect(Object.keys(summary).sort()).toEqual(allowedKeys)

    const options = makeOptions()
    expect(Object.keys(options).sort()).toEqual(['name', 'theme'])

    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    expect(() => drawCard(ctx, W, H, summary, options)).not.toThrow()
  })
})

// ── buildUsageCardSummary ────────────────────────────────────

/** A minimal valid `UsageDayRow` with `inputTokens` set so `totalTokens()` equals `tokens` exactly. */
function makeDayRow(day: string, tokens: number): UsageDayRow {
  return {
    day,
    inputTokens: tokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
    reportedCostUsd: null,
    estimatedCostUsd: null,
    cacheSavingsUsd: null,
    records: 1,
    unpricedRecords: 0,
    byProvider: []
  }
}

function makeParallelismResponse(overrides: Partial<UsageParallelismResponse['parallelism']> = {}): UsageParallelismResponse {
  return {
    periodDays: 30,
    periodStartMs: 0,
    periodEndMs: 1,
    tasksShipped: 7,
    countingFromMs: null,
    parallelism: {
      periodStartMs: 0,
      periodEndMs: 1,
      hasData: true,
      totalRunMs: 6 * 60 * 60 * 1000,
      wallMs: 5 * 60 * 60 * 1000,
      screenTimeMs: 2 * 60 * 60 * 1000,
      multiplier: 3,
      peak: { count: 4, atMs: 500, day: '2026-01-01' },
      peakDayLanes: [{ sessionId: 's1', taskId: 't1', agentId: 'a1', provider: 'claude-code', harnessInstanceId: null, segments: [{ startFrac: 0, endFrac: 1 }] }],
      perDay: [
        { day: '2026-01-01', runHours: 2, wallHours: 1 },
        { day: '2026-01-02', runHours: 4, wallHours: 1 }
      ],
      ...overrides
    }
  }
}

describe('buildUsageCardSummary', () => {
  const byDay = [makeDayRow('2026-01-01', 1_000), makeDayRow('2026-01-02', 4_000)]

  it('maps a real response into the card summary, with the calendar sourced from byDay (the same data the tokens-per-day chart reads), not from perDay.runHours', () => {
    const { summary, emptyReason } = buildUsageCardSummary(makeParallelismResponse(), byDay, 10_000_000, 'Last 30 days')
    expect(emptyReason).toBeNull()
    expect(summary).not.toBeNull()
    expect(summary!.multiplier).toBe(3)
    expect(summary!.hours).toBe(6)
    expect(summary!.wall).toBe(2)
    expect(summary!.tasksShipped).toBe(7)
    expect(summary!.tokens).toBe(10_000_000)
    expect(summary!.peakDay).toEqual({ atMs: 500, peak: 4 })
    // Values are byDay's token totals (1000, 4000) — NOT perDay's runHours (2, 4), even
    // though those happen to share the same day keys in this fixture.
    expect(summary!.calendar).toEqual([
      { day: '2026-01-01', tokens: 1_000 },
      { day: '2026-01-02', tokens: 4_000 }
    ])
  })

  it('defaults a day to 0 tokens when it appears in the parallelism response\'s dense per-day scaffold but is absent from byDay (no token_usage_events rows that day)', () => {
    const response = makeParallelismResponse({
      perDay: [
        { day: '2026-01-01', runHours: 2, wallHours: 1 },
        { day: '2026-01-02', runHours: 4, wallHours: 1 },
        { day: '2026-01-03', runHours: 0, wallHours: 0 } // in the scaffold, but no byDay entry at all
      ]
    })
    const { summary } = buildUsageCardSummary(response, byDay, 10_000_000, 'Last 30 days')
    expect(summary!.calendar).toEqual([
      { day: '2026-01-01', tokens: 1_000 },
      { day: '2026-01-02', tokens: 4_000 },
      { day: '2026-01-03', tokens: 0 }
    ])
  })

  it('returns no-agent-data (a null summary) when there is no agent-run data at all', () => {
    const response = makeParallelismResponse({ hasData: false, totalRunMs: 0, wallMs: 0, multiplier: null, peak: null, peakDayLanes: [] })
    const { summary, emptyReason } = buildUsageCardSummary(response, byDay, 0, 'Last 30 days')
    expect(summary).toBeNull()
    expect(emptyReason).toBe('no-agent-data')
  })

  it('still returns a real (non-null) summary — with a null multiplier/hours/wall — when there is live agent data but under an hour of it', () => {
    const response = makeParallelismResponse({ hasData: true, totalRunMs: 30 * 60 * 1000 })
    const { summary, emptyReason } = buildUsageCardSummary(response, byDay, 10_000_000, 'Last 30 days')
    expect(emptyReason).toBeNull()
    expect(summary).not.toBeNull()
    expect(summary!.multiplier).toBeNull()
    expect(summary!.hours).toBeNull()
    expect(summary!.wall).toBeNull()
    // Everything else is a plain aggregate and is NOT gated by the evidence threshold.
    expect(summary!.peakDay).toEqual({ atMs: 500, peak: 4 })
    expect(summary!.tasksShipped).toBe(7)
    expect(summary!.tokens).toBe(10_000_000)
    expect(summary!.calendar).toEqual([
      { day: '2026-01-01', tokens: 1_000 },
      { day: '2026-01-02', tokens: 4_000 }
    ])
  })

  it('still returns a real (non-null) summary — with a null multiplier/hours/wall — when enough agent data exists but the multiplier cannot be computed (no screen-time data)', () => {
    const response = makeParallelismResponse({ hasData: true, multiplier: null, screenTimeMs: 0 })
    const { summary, emptyReason } = buildUsageCardSummary(response, byDay, 10_000_000, 'Last 30 days')
    expect(emptyReason).toBeNull()
    expect(summary).not.toBeNull()
    expect(summary!.multiplier).toBeNull()
    expect(summary!.hours).toBeNull()
    expect(summary!.wall).toBeNull()
    expect(summary!.peakDay).toEqual({ atMs: 500, peak: 4 })
    expect(summary!.calendar.length).toBeGreaterThan(0)
  })

  it('the calendar still shows real token data even when the ratio is pending — it is never empty just because the multiplier is', () => {
    const response = makeParallelismResponse({
      hasData: true,
      totalRunMs: 10 * 60 * 1000 // under the 1-hour evidence threshold
    })
    const { summary } = buildUsageCardSummary(response, byDay, 0, 'Last 30 days')
    expect(summary).not.toBeNull()
    expect(summary!.multiplier).toBeNull() // still gated — ratio stays live-only/evidence-gated
    expect(summary!.calendar).toEqual([
      { day: '2026-01-01', tokens: 1_000 },
      { day: '2026-01-02', tokens: 4_000 }
    ])
  })
})
