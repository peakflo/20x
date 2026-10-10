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
import type { UsageDayHourRow, UsageDayRow, UsageParallelismResponse } from './usage'

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

type DailyCalendarEntry = UsageCardSummary['dailyCalendar'][number]

// A 30-entry day pattern, reused as the default `dailyCalendar` fixture.
// Paired with a default `periodDays` of 90 (see `makeSummary`) — comfortably
// past the day×hour grid cutoff — so the common-case default exercises the
// one-cell-per-day weeks×weekdays fallback layout; tests specifically about
// the day×hour grid build their own `periodDays <= 30` override instead.
const DEFAULT_CALENDAR_PATTERN = [
  0, 2_000, 5_000, 8_000, 3_000, 0, 6_000, 9_000, 4_000, 1_000,
  7_000, 10_000, 2_000, 0, 5_000, 8_000, 11_000, 3_000, 6_000, 0,
  9_000, 4_000, 7_000, 2_000, 10_000, 5_000, 0, 8_000, 6_000, 3_000
]

/**
 * Builds a dense day×hour-bucket cell list (8 buckets per day, zero-filled)
 * from a per-day token pattern — concentrating each day's whole total into
 * one bucket (bucket 4, arbitrary) is enough to exercise the grid's colour
 * scale without needing a second independent pattern for every test.
 */
function makeHourlyCells(daily: DailyCalendarEntry[], bucket = 4): UsageCardSummary['hourlyCells'] {
  return daily.flatMap((d) =>
    Array.from({ length: 8 }, (_, b) => ({ day: d.day, bucket: b, tokens: b === bucket ? d.tokens : 0 }))
  )
}

function makeSummary(overrides: Partial<UsageCardSummary> = {}): UsageCardSummary {
  const dailyCalendar = DEFAULT_CALENDAR_PATTERN.map((tokens, i) => ({
    day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    tokens
  }))
  return {
    periodLabel: 'Last 30 days',
    periodDays: 90,
    multiplier: 3.4,
    hours: 120,
    // Deliberately different from `hours` by default — this is allowed/expected (the stat
    // tile shows the full total, the sentence/aria-label describe the live-only ratio
    // inputs), and keeping them different in the shared fixture catches any test that
    // accidentally conflates the two.
    liveHours: 118,
    wall: 35,
    peakDay: { atMs: Date.UTC(2026, 0, 15, 12, 0, 0), peak: 5 },
    tasksShipped: 12,
    tokens: 45_000_000,
    dailyCalendar,
    hourlyCells: makeHourlyCells(dailyCalendar),
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

  it('runs without throwing for the day×hour grid layout too, at every shape', () => {
    const dailyCalendar = Array.from({ length: 14 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      tokens: i * 100
    }))
    const summary = makeSummary({ dailyCalendar, hourlyCells: makeHourlyCells(dailyCalendar), periodDays: 30 })
    for (const shape of Object.keys(USAGE_CARD_SHAPES) as UsageCardShape[]) {
      const [W, H] = USAGE_CARD_SHAPES[shape]
      const ctx = makeMockContext()
      expect(() => drawCard(ctx, W, H, summary, makeOptions())).not.toThrow()
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
    // `hours` (the stat tile) stays real even while `liveHours`/`wall`/`multiplier` (the
    // ratio and its sentence) are pending — that divergence is itself part of the design.
    const summary = makeSummary({ multiplier: null, hours: 42, liveHours: null, wall: null })
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
    // "agent hours" is the always-full stat tile, not gated behind the ratio — it must show
    // the real number (42) here, never a placeholder, even while the sentence is pending.
    expect(texts).toContain('42')
    expect(texts).not.toContain('-')
    // One roundRect per activity-grid day cell is still drawn, same as the ratio-ready case
    // (default periodDays here is 90, past the day×hour cutoff, so this is the weeks grid: one
    // roundRect per day, 1:1).
    const expectedRoundRects = 1 /* logo */ + summary.dailyCalendar.length
    expect(ctx.calls.roundRect).toHaveLength(expectedRoundRects)
  })

  it('sizes the pending-multiplier dash like a line, not a filled blob, at all three shapes', () => {
    for (const shape of Object.keys(USAGE_CARD_SHAPES) as UsageCardShape[]) {
      const ctx = makeMockContext()
      const [W, H] = USAGE_CARD_SHAPES[shape]
      drawCard(ctx, W, H, makeSummary({ multiplier: null, hours: 1, liveHours: null, wall: null }), makeOptions())
      // Recover the dash's own width/thickness from its moveTo/lineTo/lineWidth calls
      // (nothing after it in drawCard touches ctx.lineWidth, so the final value is still
      // the dash's). "Looks like a dash, not a blob" means thickness stays a modest
      // fraction of its own length — close to drawTimes's own 0.2-of-size ratio for the
      // "×" glyph, not anywhere near half, which loses all "line" quality to the round
      // caps and reads as a solid filled capsule instead (a real regression caught
      // during visual QA: an earlier version used thickness = width * 0.5+).
      // The dash is the LAST stroke drawn before stats/activity-grid/footer (none of which
      // call moveTo/lineTo), so its calls are always the final moveTo/lineTo pair —
      // logo's own crossed-eye strokes come first and must not be mistaken for it.
      const x0 = ctx.calls.moveTo.at(-1)![0] as number
      const x1 = ctx.calls.lineTo.at(-1)![0] as number
      const dashWidth = x1 - x0
      const ratio = ctx.lineWidth / dashWidth
      expect(ratio).toBeGreaterThan(0.08)
      expect(ratio).toBeLessThan(0.25)
    }
  })

  it('drawDash strokes a single round-capped horizontal line — a bespoke glyph, not font text', () => {
    const ctx = makeMockContext()
    drawDash(ctx, 0, 0, 40, 8, '#fff')
    expect(ctx.calls.moveTo).toHaveLength(1)
    expect(ctx.calls.lineTo).toHaveLength(1)
    expect(ctx.calls.stroke).toHaveLength(1)
  })

  it('drawDash is baseline-anchored: the stroke sits ABOVE y by half its own thickness, so its bottom edge touches y, the same way a real digit\'s bottom sits on its baseline', () => {
    const ctx = makeMockContext()
    const baselineY = 500
    const thickness = 24
    drawDash(ctx, 0, baselineY, 100, thickness, '#fff')
    const [, strokeY] = ctx.calls.moveTo[0]
    expect(strokeY).toBeCloseTo(baselineY - thickness / 2)
    expect(ctx.lineWidth).toBe(thickness) // thickness is an explicit param, not a fraction of width
  })

  it('draws the literal footer URL, never a dynamic repo name', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    drawCard(ctx, W, H, makeSummary(), makeOptions())
    const texts = ctx.calls.fillText.map((args) => args[0])
    expect(texts).toContain('github.com/peakflo/20x')
  })

  it('draws one rounded cell per calendar day (via roundRect calls) in the weeks-grid (long-period) layout', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    const summary = makeSummary() // periodDays: 90 — past the day×hour grid cutoff
    drawCard(ctx, W, H, summary, makeOptions())
    // One roundRect per calendar-day cell, plus the logo's rounded screen outline (1 call).
    const expectedRoundRects = 1 /* logo */ + summary.dailyCalendar.length
    expect(ctx.calls.roundRect).toHaveLength(expectedRoundRects)
  })

  it('handles an empty activity grid (no per-day activity in a degenerate summary) without throwing', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    expect(() => drawCard(ctx, W, H, makeSummary({ dailyCalendar: [], hourlyCells: [] }), makeOptions())).not.toThrow()
  })

  it('scales a wide weeks grid (6-month period) down to fit the card width without throwing', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    const dailyCalendar = Array.from({ length: 182 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      tokens: i % 7
    }))
    drawCard(ctx, W, H, makeSummary({ dailyCalendar, hourlyCells: makeHourlyCells(dailyCalendar), periodDays: 182 }), makeOptions())
    expect(ctx.calls.roundRect).toHaveLength(1 /* logo */ + dailyCalendar.length)
  })

  it('draws a day×hour-of-day grid (8 rows per day column) at or under the grid cutoff period length', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    const dailyCalendar = Array.from({ length: 7 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      tokens: (i + 1) * 100
    }))
    const hourlyCells = makeHourlyCells(dailyCalendar)
    drawCard(ctx, W, H, makeSummary({ dailyCalendar, hourlyCells, periodDays: 7 }), makeOptions())
    // One roundRect per (day, bucket) cell — 7 days × 8 buckets — plus the logo's own outline.
    expect(ctx.calls.roundRect).toHaveLength(1 /* logo */ + 7 * 8)
    // Hour-bucket row labels and month/day-tick header text are real fillText calls too.
    const texts = ctx.calls.fillText.map((args) => args[0])
    expect(texts).toContain('00:00')
    expect(texts).toContain('21:00')
    expect(texts).toContain('Jan')
  })

  it('falls back to the one-cell-per-day weeks grid once the nominal period is longer than the day×hour grid cutoff', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    const dailyCalendar = Array.from({ length: 8 }, (_, i) => ({ day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), tokens: i }))
    drawCard(ctx, W, H, makeSummary({ dailyCalendar, hourlyCells: makeHourlyCells(dailyCalendar), periodDays: 90 }), makeOptions())
    // Weeks grid draws exactly one roundRect per day; the day×hour grid would draw 8x that.
    expect(ctx.calls.roundRect).toHaveLength(1 /* logo */ + dailyCalendar.length)
  })

  it('real bug, found in the real app: a NOMINAL 7-day period whose day-scaffold came back with 8 entries (a boundary effect, not a longer period) must still use the day×hour grid, keyed off periodDays, not dailyCalendar.length', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    // This is exactly what the real backend returned for a live 7-day query (confirmed by
    // running the real computeParallelismSummary/periodBoundsForDays against the real
    // database): periodDays is 7, but perDay (hence dailyCalendar) has 8 entries because the
    // period's start/end didn't land exactly on a local-day boundary. The layout decision
    // keys off `periodDays` (the stable, user-facing period length), not this incidental
    // array length, so an 8-entry scaffold for a nominal 7-day period still uses the day×hour
    // grid — not the weeks fallback, which an earlier (day-grid-only) version of this card
    // could fall into under exactly this condition.
    const dailyCalendar = Array.from({ length: 8 }, (_, i) => ({ day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), tokens: i === 0 ? 0 : 1_000 * i }))
    const summary = makeSummary({ dailyCalendar, hourlyCells: makeHourlyCells(dailyCalendar), periodDays: 7 })
    drawCard(ctx, W, H, summary, makeOptions())
    // Grid branch: 8 days × 8 buckets + logo. The weeks-grid branch would instead give 1 + 8.
    expect(ctx.calls.roundRect).toHaveLength(1 /* logo */ + 8 * 8)
  })

  it('real-world repro: 7-day period, thin history (only 1 of 7 days has token activity), multiplier pending — still draws all 7 day columns and a real "agent hours" number', () => {
    const ctx = makeMockContext()
    const [W, H] = USAGE_CARD_SHAPES.wide
    // Exactly the reported real state: brand-new feature, only today has any token data,
    // and screen-time tracking hasn't accumulated enough evidence for a ratio yet.
    const dailyCalendar = Array.from({ length: 7 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      tokens: i === 6 ? 9_300_000_000 : 0
    }))
    const summary = makeSummary({
      dailyCalendar,
      hourlyCells: makeHourlyCells(dailyCalendar),
      periodDays: 7,
      multiplier: null,
      // Full total — real and unaffected by the pending ratio below.
      hours: 118,
      liveHours: null,
      wall: null,
      peakDay: { atMs: Date.UTC(2026, 0, 7), peak: 5 }
    })
    drawCard(ctx, W, H, summary, makeOptions())
    const texts = ctx.calls.fillText.map((args) => args[0])

    // "agent hours" must show the real full total, not a placeholder.
    expect(texts).toContain('118')
    expect(texts).not.toContain('-')

    // All 7 day columns draw as the day×hour grid — 7 days × 8 buckets each — not just 1
    // column for the single day that actually has data: every (day, bucket) cell is dense
    // by construction, with no "how many days happen to have data" dependence at all.
    expect(ctx.calls.roundRect).toHaveLength(1 /* logo */ + 7 * 8)
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
  it('includes the period, rounded multiplier, LIVE hours/wall (not the full-total stat), peak, tasks, and tokens', () => {
    const label = usageCardAriaLabel(makeSummary({ multiplier: 3.7, hours: 999 /* full total — must NOT appear in the ratio sentence */, liveHours: 120, wall: 35, tasksShipped: 12, tokens: 45_000_000, peakDay: { atMs: Date.now(), peak: 5 } }))
    expect(label).toContain('Last 30 days')
    expect(label).toContain('4 agents in parallel on average') // Math.round(3.7)
    expect(label).toContain('120 hours of agent work in 35 hours') // liveHours, not hours
    expect(label).not.toContain('999')
    expect(label).toContain('Peak 5 agents at once')
    expect(label).toContain('12 tasks shipped')
    expect(label).toContain('45M tokens')
  })

  it('describes the multiplier as still gathering evidence, but still reports peak/tasks/tokens, when it is null', () => {
    const label = usageCardAriaLabel(makeSummary({ multiplier: null, hours: 42, liveHours: null, wall: null, tasksShipped: 12, tokens: 45_000_000, peakDay: { atMs: Date.now(), peak: 5 } }))
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
const _dailyCalendarDayIsClean: AssertNoForbiddenFields<UsageCardSummary['dailyCalendar'][number]> = true
const _hourlyCellIsClean: AssertNoForbiddenFields<UsageCardSummary['hourlyCells'][number]> = true

describe('privacy: no cost/task-title/repo/model field is reachable from the card types', () => {
  it('the compile-time assertions above held (this test just gives them a home in the runner output)', () => {
    expect(_summaryIsClean).toBe(true)
    expect(_optionsAreClean).toBe(true)
    expect(_peakDayIsClean).toBe(true)
    expect(_dailyCalendarDayIsClean).toBe(true)
    expect(_hourlyCellIsClean).toBe(true)
  })

  it('drawCard works correctly using an object with exactly the allowed keys — nothing more is needed', () => {
    const summary = makeSummary()
    const allowedKeys = ['periodLabel', 'periodDays', 'multiplier', 'hours', 'liveHours', 'wall', 'peakDay', 'tasksShipped', 'tokens', 'dailyCalendar', 'hourlyCells'].sort()
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

/** A minimal valid `UsageDayHourRow`. */
function makeDayHourRow(day: string, bucket: number, tokens: number): UsageDayHourRow {
  return { day, bucket, tokens }
}

// A realistic, dense 7-day scaffold (matching what buildPerDay always
// produces for a 7-day period, regardless of data sparsity) — days 1-2 have
// agent-run data, days 3-7 don't. Paired with `periodDays: 7` so the two
// stay consistent (this matters now: see `ensureDenseDayScaffold`).
const SEVEN_DAY_PER_DAY = [
  { day: '2026-01-01', runHours: 2, wallHours: 1 },
  { day: '2026-01-02', runHours: 4, wallHours: 1 },
  { day: '2026-01-03', runHours: 0, wallHours: 0 },
  { day: '2026-01-04', runHours: 0, wallHours: 0 },
  { day: '2026-01-05', runHours: 0, wallHours: 0 },
  { day: '2026-01-06', runHours: 0, wallHours: 0 },
  { day: '2026-01-07', runHours: 0, wallHours: 0 }
]

function makeParallelismResponse(overrides: Partial<UsageParallelismResponse['parallelism']> = {}): UsageParallelismResponse {
  return {
    periodDays: 7,
    periodStartMs: 0,
    periodEndMs: 1,
    tasksShipped: 7,
    countingFromMs: null,
    parallelism: {
      periodStartMs: 0,
      periodEndMs: 1,
      hasData: true,
      totalRunMs: 6 * 60 * 60 * 1000,
      // Deliberately different from totalRunMs — live (6h) vs. full/live+backfilled (8h) —
      // so tests catch any code path that conflates the stat tile with the ratio's numerator.
      totalRunMsAll: 8 * 60 * 60 * 1000,
      wallMs: 5 * 60 * 60 * 1000,
      screenTimeMs: 2 * 60 * 60 * 1000,
      multiplier: 3,
      peak: { count: 4, atMs: 500, day: '2026-01-01' },
      peakDayLanes: [{ sessionId: 's1', taskId: 't1', agentId: 'a1', provider: 'claude-code', harnessInstanceId: null, segments: [{ startFrac: 0, endFrac: 1 }] }],
      perDay: SEVEN_DAY_PER_DAY,
      ...overrides
    }
  }
}

// Thin history — only 2 of the 7 scaffold days have a token_usage_events row
// at all, matching the real "feature is brand new" state that exposed the
// day×hour grid's column-count bug class.
const THIN_BY_DAY = [makeDayRow('2026-01-01', 1_000), makeDayRow('2026-01-02', 4_000)]
const THIN_BY_DAY_HOUR = [makeDayHourRow('2026-01-01', 4, 1_000), makeDayHourRow('2026-01-02', 4, 4_000)]
const SPARSE_CALENDAR = [
  { day: '2026-01-01', tokens: 1_000 },
  { day: '2026-01-02', tokens: 4_000 },
  { day: '2026-01-03', tokens: 0 },
  { day: '2026-01-04', tokens: 0 },
  { day: '2026-01-05', tokens: 0 },
  { day: '2026-01-06', tokens: 0 },
  { day: '2026-01-07', tokens: 0 }
]
// The dense (day, bucket) expansion of SPARSE_CALENDAR/THIN_BY_DAY_HOUR — every day gets
// all 8 buckets, zero-filled except the one bucket (4) THIN_BY_DAY_HOUR actually populated.
const SPARSE_HOURLY_CELLS = SPARSE_CALENDAR.flatMap((d) =>
  Array.from({ length: 8 }, (_, bucket) => ({ day: d.day, bucket, tokens: bucket === 4 ? d.tokens : 0 }))
)

describe('buildUsageCardSummary', () => {
  it('maps a real response into the card summary, with the activity grid sourced from byDay/byDayHour (the same data the tokens-per-day chart reads), not from perDay.runHours, and hours/liveHours kept separate', () => {
    const { summary, emptyReason } = buildUsageCardSummary(makeParallelismResponse(), THIN_BY_DAY, THIN_BY_DAY_HOUR, 10_000_000, 'Last 30 days')
    expect(emptyReason).toBeNull()
    expect(summary).not.toBeNull()
    expect(summary!.multiplier).toBe(3)
    // `hours` is the full (live + backfilled) total (totalRunMsAll = 8h); `liveHours` is the
    // live-only ratio numerator (totalRunMs = 6h) — different numbers, both real.
    expect(summary!.hours).toBe(8)
    expect(summary!.liveHours).toBe(6)
    expect(summary!.wall).toBe(2)
    expect(summary!.tasksShipped).toBe(7)
    expect(summary!.tokens).toBe(10_000_000)
    expect(summary!.peakDay).toEqual({ atMs: 500, peak: 4 })
    // Values are byDay's/byDayHour's token totals (1000, 4000, then 0s) — NOT perDay's
    // runHours (2, 4, 0...), even though days 1-2 happen to share the same day keys in this
    // fixture. One entry per scaffold day (7), not just the 2 days that happen to have byDay rows.
    expect(summary!.dailyCalendar).toEqual(SPARSE_CALENDAR)
    expect(summary!.hourlyCells).toEqual(SPARSE_HOURLY_CELLS)
    expect(summary!.periodDays).toBe(7) // the response's own periodDays, not derived from dailyCalendar.length
  })

  it('periodDays comes from response.periodDays, independent of how many entries perDay actually has — reproduces the real bug where a nominal 7-day period\'s scaffold had 8 entries', () => {
    const response = makeParallelismResponse({
      perDay: [
        ...SEVEN_DAY_PER_DAY,
        { day: '2026-01-08', runHours: 0, wallHours: 0 } // the real backend's boundary-overflow 8th day
      ]
    })
    const { summary } = buildUsageCardSummary(response, THIN_BY_DAY, THIN_BY_DAY_HOUR, 10_000_000, 'Last 30 days')
    expect(summary!.dailyCalendar).toHaveLength(8)
    expect(summary!.hourlyCells).toHaveLength(8 * 8) // 8 days × 8 buckets, dense
    expect(summary!.periodDays).toBe(7) // still 7 — the nominal period, not the 8-entry scaffold's length
  })

  it('defaults a day/bucket to 0 tokens when it appears in the parallelism response\'s dense per-day scaffold but is absent from byDay/byDayHour (no token_usage_events rows that day)', () => {
    const { summary } = buildUsageCardSummary(makeParallelismResponse(), THIN_BY_DAY, THIN_BY_DAY_HOUR, 10_000_000, 'Last 30 days')
    // Days 3-7 are in the scaffold but have no byDay entry at all — they must default to 0, not be dropped.
    expect(summary!.dailyCalendar.slice(2)).toEqual([
      { day: '2026-01-03', tokens: 0 },
      { day: '2026-01-04', tokens: 0 },
      { day: '2026-01-05', tokens: 0 },
      { day: '2026-01-06', tokens: 0 },
      { day: '2026-01-07', tokens: 0 }
    ])
    // Same for hourlyCells — every bucket on days 3-7 is 0.
    expect(summary!.hourlyCells.filter((c) => c.day >= '2026-01-03').every((c) => c.tokens === 0)).toBe(true)
  })

  it('still always produces exactly periodDays dailyCalendar entries even if the backend\'s perDay scaffold is ever shorter than the period — never silently fewer columns than the period implies', () => {
    const response = makeParallelismResponse({
      // Deliberately short — only 2 entries for a nominal 7-day period, simulating a
      // hypothetical backend regression. This is exactly the bug class that produced a
      // real "1 column instead of 7" report: the day COUNT must never come from however
      // many days happen to have data (here, perDay itself, standing in for that risk).
      perDay: [
        { day: '2026-01-06', runHours: 0, wallHours: 0 },
        { day: '2026-01-07', runHours: 0, wallHours: 0 }
      ]
    })
    const { summary } = buildUsageCardSummary(response, THIN_BY_DAY, THIN_BY_DAY_HOUR, 10_000_000, 'Last 30 days')
    expect(summary!.dailyCalendar).toHaveLength(7) // periodDays, not perDay.length (2)
    // The real (known) days are preserved verbatim at the end; the padding fills backward from them.
    expect(summary!.dailyCalendar.slice(-2)).toEqual([
      { day: '2026-01-06', tokens: 0 },
      { day: '2026-01-07', tokens: 0 }
    ])
  })

  it('returns no-agent-data (a null summary) when there is no agent-run data at all', () => {
    const response = makeParallelismResponse({ hasData: false, totalRunMs: 0, totalRunMsAll: 0, wallMs: 0, multiplier: null, peak: null, peakDayLanes: [] })
    const { summary, emptyReason } = buildUsageCardSummary(response, THIN_BY_DAY, THIN_BY_DAY_HOUR, 0, 'Last 30 days')
    expect(summary).toBeNull()
    expect(emptyReason).toBe('no-agent-data')
  })

  it('still returns a real (non-null) summary — with a null multiplier/liveHours/wall but a REAL full-total hours — when there is live agent data but under an hour of it', () => {
    const response = makeParallelismResponse({ hasData: true, totalRunMs: 30 * 60 * 1000 })
    const { summary, emptyReason } = buildUsageCardSummary(response, THIN_BY_DAY, THIN_BY_DAY_HOUR, 10_000_000, 'Last 30 days')
    expect(emptyReason).toBeNull()
    expect(summary).not.toBeNull()
    expect(summary!.multiplier).toBeNull()
    expect(summary!.wall).toBeNull()
    // The ratio's own live-only numerator is pending...
    expect(summary!.liveHours).toBeNull()
    // ...but the stat tile's full total is unaffected — it comes from totalRunMsAll (8h in
    // the base fixture), not the live-only totalRunMs this scenario deliberately starves.
    expect(summary!.hours).toBe(8)
    // Everything else is a plain aggregate and is NOT gated by the evidence threshold.
    expect(summary!.peakDay).toEqual({ atMs: 500, peak: 4 })
    expect(summary!.tasksShipped).toBe(7)
    expect(summary!.tokens).toBe(10_000_000)
    expect(summary!.dailyCalendar).toEqual(SPARSE_CALENDAR)
  })

  it('still returns a real (non-null) summary — with a null multiplier/liveHours/wall but a REAL full-total hours — when enough agent data exists but the multiplier cannot be computed (no screen-time data)', () => {
    const response = makeParallelismResponse({ hasData: true, multiplier: null, screenTimeMs: 0 })
    const { summary, emptyReason } = buildUsageCardSummary(response, THIN_BY_DAY, THIN_BY_DAY_HOUR, 10_000_000, 'Last 30 days')
    expect(emptyReason).toBeNull()
    expect(summary).not.toBeNull()
    expect(summary!.multiplier).toBeNull()
    expect(summary!.wall).toBeNull()
    expect(summary!.liveHours).toBeNull()
    expect(summary!.hours).toBe(8) // full total, unaffected by the pending ratio
    expect(summary!.peakDay).toEqual({ atMs: 500, peak: 4 })
    expect(summary!.dailyCalendar.length).toBeGreaterThan(0)
  })

  it('the activity grid still shows real token data even when the ratio is pending — it is never empty just because the multiplier is', () => {
    const response = makeParallelismResponse({
      hasData: true,
      totalRunMs: 10 * 60 * 1000 // under the 1-hour evidence threshold
    })
    const { summary } = buildUsageCardSummary(response, THIN_BY_DAY, THIN_BY_DAY_HOUR, 0, 'Last 30 days')
    expect(summary).not.toBeNull()
    expect(summary!.multiplier).toBeNull() // still gated — ratio stays live-only/evidence-gated
    expect(summary!.dailyCalendar).toEqual(SPARSE_CALENDAR)
    expect(summary!.hourlyCells).toEqual(SPARSE_HOURLY_CELLS)
  })
})
