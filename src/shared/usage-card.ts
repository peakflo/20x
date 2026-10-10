/**
 * The "my multiplier" share card — one canvas-drawing module shared by the
 * desktop hero card, the Share dialog's export, and the mobile hero.
 *
 * This started as a faithful, line-for-line port of the approved mock
 * (usage-page-mock-shareable-20x-card/index.html — `drawLogo`, `drawTimes`,
 * `fitText`, `drawCard`, `renderToCanvas`, `THEMES`, `SHAPES`, `ROUND`/`SANS`),
 * with every mock data field that came from the mock's seeded random
 * generator replaced by a field on `UsageCardSummary` fed by the real
 * `ParallelismSummary` (src/main/usage/usage-parallelism.ts).
 *
 * One deliberate departure from the mock, from direct user review of the
 * live page: the mock's "peak day as lanes" block (one row per agent
 * session, bars per run, on the single busiest day) tested as confusing —
 * a real user couldn't tell what it was showing. It's replaced with a
 * GitHub-style activity calendar: one cell per calendar day in the period,
 * colour intensity by that day's agent hours. See `buildCalendarGrid` /
 * the "calendar heatmap" section of `drawCard`.
 *
 * ── Privacy, enforced by construction ───────────────────────
 * `UsageCardSummary` and `UsageCardOptions` are the ONLY way to get data into
 * `drawCard`. Neither type has a cost field, a task title, a repo name, or a
 * model name — this file does not import anything that has one either — so
 * nothing of the kind can reach the drawn (shareable) image, structurally,
 * not just by caller discipline. See usage-card.test.ts for a compile-time
 * check that enforces this.
 */

import { formatMultiplier, type UsageParallelismResponse } from './usage'

// ── Data contract ────────────────────────────────────────────

/**
 * One calendar day's live agent-hours, for the GitHub-style activity
 * calendar. `day` is a `YYYY-MM-DD` local-calendar-day key (see
 * `ParallelismDayRow.day` in shared/usage.ts) — no session, task, or agent
 * identity travels with it, just a date and an hour figure.
 */
export interface UsageCardCalendarDay {
  day: string
  /** Live (non-backfilled) agent run-hours that calendar day. */
  hours: number
}

export interface UsageCardPeakDay {
  /** Any epoch ms timestamp that falls on the peak calendar day (used only to format the date label). */
  atMs: number
  /** Max simultaneous agents running that day. */
  peak: number
}

/**
 * Everything `drawCard` is allowed to draw. Deliberately flat and narrow:
 * every field here is either already a safe aggregate (a count, an hour
 * figure, a multiplier) or pre-formatted text the caller chose (the period
 * label, the name). There is no cost field, task title, repo name, or model
 * name on this type, and none reachable from any field on it.
 */
export interface UsageCardSummary {
  /** e.g. "Last 30 days" or "Last 6 months" — see `usagePeriodLabel`. */
  periodLabel: string
  /**
   * Raw multiplier: agent run hours ÷ the user's own screen time in the app
   * (NOT agent wall-clock time — see usage-parallelism.ts's ParallelismSummary
   * for why). Callers only build this once there IS data — "no data yet" is a
   * UI-level empty state, handled before calling `drawCard`.
   */
  multiplier: number
  /** Total agent run time in the period, in hours. The multiplier's numerator. */
  hours: number
  /** The user's own screen time in the app in the period, in hours — how long 20x was actually on screen. The multiplier's denominator ("N hours of agent work in M hours"). */
  wall: number
  peakDay: UsageCardPeakDay
  /** Tasks that reached completed in the period. */
  tasksShipped: number
  /** Total tokens processed in the period — a count, never a cost. */
  tokens: number
  /** One entry per calendar day in the period, live agent-hours only — drawn as a GitHub-style activity calendar. */
  calendar: UsageCardCalendarDay[]
}

export type UsageCardShape = 'wide' | 'square' | 'tall'
export type UsageCardTheme = 'azure' | 'ink' | 'paper'

export interface UsageCardOptions {
  theme: UsageCardTheme
  /** Shown as "<name>, <period label>". Empty string omits the name. */
  name: string
}

// ── Theme / shape tokens (verbatim from the mock) ───────────

interface UsageCardThemeTokens {
  bg: string
  bg2: string
  ink: string
  soft: string
  faint: string
  cell: [number, number, number]
  rule: string
}

export const USAGE_CARD_THEMES: Record<UsageCardTheme, UsageCardThemeTokens> = {
  azure: { bg: '#1e96eb', bg2: '#1787d9', ink: '#ffffff', soft: 'rgba(255,255,255,.78)', faint: 'rgba(255,255,255,.2)', cell: [255, 255, 255], rule: 'rgba(255,255,255,.28)' },
  ink: { bg: '#111315', bg2: '#16191c', ink: '#f2f4f5', soft: 'rgba(242,244,245,.66)', faint: 'rgba(255,255,255,.09)', cell: [30, 150, 235], rule: 'rgba(255,255,255,.14)' },
  paper: { bg: '#f3f1ec', bg2: '#ebe8e1', ink: '#101418', soft: 'rgba(16,20,24,.62)', faint: 'rgba(16,20,24,.08)', cell: [15, 111, 184], rule: 'rgba(16,20,24,.16)' }
}

export const USAGE_CARD_SHAPES: Record<UsageCardShape, [number, number]> = {
  wide: [1200, 630],
  square: [1080, 1080],
  tall: [1080, 1350]
}

/**
 * Rounded-face display stack for the big numerals (matches the mock). Falls
 * back through the OS rounded system faces to the app's own bundled Inter —
 * no network font, no new dependency.
 */
export const USAGE_CARD_ROUND_FONT = '"SF Pro Rounded", ui-rounded, "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
/** Body/label stack — the app's bundled Inter, same fallback chain as the mock. */
export const USAGE_CARD_SANS_FONT = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'

// ── Text helpers ─────────────────────────────────────────────

/** "Last 30 days" / "Last 6 months" — ports the mock's `periodLabel(n)`. */
export function usagePeriodLabel(days: 7 | 30 | 90 | 182): string {
  return days === 182 ? 'Last 6 months' : `Last ${days} days`
}

function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US')
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Formats the tokens stat using the app's existing token-count formatter
 * (shared/usage.ts's `formatTokenCount`) rather than re-deriving the mock's
 * own `fmtTok` — one token format across the whole app. This means a count
 * at the billion scale prints with one decimal ("1.3B") instead of the
 * mock's two ("1.28B"); see the PR description for the full visual diff
 * against the mock's reference renders.
 */
function fmtTokens(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`
  return String(Math.round(value))
}

/** The card's own `aria-label`/alt text — ports the mock's `renderHero` aria-label line. */
export function usageCardAriaLabel(summary: UsageCardSummary): string {
  return `${summary.periodLabel}: ${Math.round(summary.multiplier)} agents in parallel on average. `
    + `${fmtInt(summary.hours)} hours of agent work in ${fmtInt(summary.wall)} hours. `
    + `Peak ${summary.peakDay.peak} agents at once, ${summary.tasksShipped} tasks shipped, ${fmtTokens(summary.tokens)} tokens.`
}

// ── Drawing primitives (verbatim port) ───────────────────────

/** A minimal structural subset of CanvasRenderingContext2D — lets tests supply a lightweight mock instead of a real canvas. */
export type UsageCardContext2D = Pick<
  CanvasRenderingContext2D,
  | 'save' | 'restore' | 'translate' | 'scale' | 'setTransform'
  | 'beginPath' | 'moveTo' | 'lineTo' | 'roundRect' | 'fill' | 'stroke'
  | 'fillRect' | 'fillText' | 'measureText' | 'createLinearGradient'
  | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineCap' | 'font' | 'textAlign' | 'textBaseline'
>

/** 20x mark: a rounded screen with two crossed "eyes". Source viewBox 92 72 216 181. */
export function drawLogo(ctx: UsageCardContext2D, x: number, y: number, h: number, color: string): void {
  const s = h / 181
  ctx.save()
  ctx.translate(x - 92 * s, y - 72 * s)
  ctx.scale(s, s)
  ctx.strokeStyle = color
  ctx.lineWidth = 18
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.roundRect(104, 84, 192, 157, 34)
  ctx.stroke()
  for (const [a, b] of [[146, 180], [220, 254]] as const) {
    ctx.beginPath()
    ctx.moveTo(a, 136); ctx.lineTo(b, 170)
    ctx.moveTo(b, 136); ctx.lineTo(a, 170)
    ctx.stroke()
  }
  ctx.restore()
}

/** The multiplier "×" sign, drawn with the same round-capped strokes as the logo's eyes. */
export function drawTimes(ctx: UsageCardContext2D, x: number, y: number, size: number, color: string): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = size * 0.2
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x, y); ctx.lineTo(x + size, y + size)
  ctx.moveTo(x + size, y); ctx.lineTo(x, y + size)
  ctx.stroke()
  ctx.restore()
}

/** Shrinks `size` until `text` fits `maxWidth` (floor 10px), returning the size used. */
export function fitText(ctx: UsageCardContext2D, text: string, maxWidth: number, size: number, weight: number, family: string): number {
  let s = size
  do {
    ctx.font = `${weight} ${s}px ${family}`
    s -= 1
  } while (ctx.measureText(text).width > maxWidth && s > 10)
  return s + 1
}

// ── Activity calendar (GitHub-style contribution grid) ──────

/** One placed cell in the calendar grid: `col` = week index (0 = earliest week), `row` = weekday (0 = Sunday .. 6 = Saturday). */
interface UsageCardCalendarCell {
  col: number
  row: number
  hours: number
}

/**
 * Lays `calendar` (one entry per calendar day, in chronological order) out
 * into a GitHub-style grid: columns are weeks, rows are the 7 weekdays
 * (Sunday on top), filled top-to-bottom within a column then left-to-right
 * across columns — exactly how github.com's own contribution graph reads.
 * The first day's weekday determines how far down its column it lands, so
 * every later day's cell is anchored to its true weekday, not just "the
 * Nth day since the period started".
 *
 * `day` is parsed as a UTC midnight timestamp purely to recover its
 * weekday — these are already resolved local-calendar-day keys (see
 * `ParallelismDayRow.day`), so this is just date arithmetic, not a
 * timezone conversion.
 */
function buildCalendarGrid(calendar: UsageCardCalendarDay[]): { cols: number; cells: UsageCardCalendarCell[] } {
  if (calendar.length === 0) return { cols: 0, cells: [] }
  const firstWeekday = new Date(`${calendar[0].day}T00:00:00Z`).getUTCDay() // 0 = Sun .. 6 = Sat
  const cells: UsageCardCalendarCell[] = calendar.map((d, i) => {
    const offset = i + firstWeekday
    return { col: Math.floor(offset / 7), row: offset % 7, hours: d.hours }
  })
  const cols = Math.max(...cells.map((c) => c.col)) + 1
  return { cols, cells }
}

/**
 * GitHub's own 5-level bucketing (0 = none, 1..4 = increasing activity),
 * scaled relative to the busiest day in the period rather than to a fixed
 * hour count — so a quiet week and a packed one each use the full range.
 * A 0-hour day is always level 0, drawn in the theme's `faint` token so it
 * reads as "clearly empty" rather than "the lightest shade of present".
 */
function calendarLevel(hours: number, maxHours: number): 0 | 1 | 2 | 3 | 4 {
  if (hours <= 0 || maxHours <= 0) return 0
  const frac = hours / maxHours
  if (frac > 0.75) return 4
  if (frac > 0.5) return 3
  if (frac > 0.25) return 2
  return 1
}

const USAGE_CARD_CALENDAR_LEVEL_OPACITY = [0, 0.28, 0.48, 0.7, 0.94] as const

// ── The card ──────────────────────────────────────────────────

/**
 * Draws the full card: header (logo + wordmark + "<name>, <period>"), the
 * giant multiplier, the "N hours of agent work in M hours" sentence, the 4
 * stats (layout differs by shape), the activity calendar with its caption,
 * and the footer. One function for the on-screen hero and the exported
 * image — call it via `renderToCanvas`.
 */
export function drawCard(ctx: UsageCardContext2D, W: number, H: number, summary: UsageCardSummary, opts: UsageCardOptions): void {
  const t = USAGE_CARD_THEMES[opts.theme] ?? USAGE_CARD_THEMES.azure
  const wide = W / H > 1.4
  const pad = wide ? 60 : 72

  ctx.fillStyle = t.bg
  ctx.fillRect(0, 0, W, H)
  // A single soft diagonal band, so the field is not flat in a feed.
  const g = ctx.createLinearGradient(0, 0, W, H)
  g.addColorStop(0, 'rgba(255,255,255,0)')
  g.addColorStop(0.55, 'rgba(255,255,255,0)')
  g.addColorStop(1, opts.theme === 'paper' ? 'rgba(15,111,184,.10)' : 'rgba(0,0,0,.16)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)

  // Header: mark, wordmark, period
  const logoH = wide ? 40 : 52
  drawLogo(ctx, pad, pad, logoH, t.ink)
  ctx.fillStyle = t.ink
  ctx.textBaseline = 'middle'
  ctx.font = `700 ${wide ? 28 : 36}px ${USAGE_CARD_ROUND_FONT}`
  ctx.textAlign = 'left'
  ctx.fillText('20x', pad + logoH * 1.19 + 14, pad + logoH / 2 + 1)
  ctx.font = `500 ${wide ? 20 : 26}px ${USAGE_CARD_SANS_FONT}`
  ctx.textAlign = 'right'
  ctx.fillStyle = t.soft
  const who = (opts.name || '').trim()
  ctx.fillText((who ? who + ', ' : '') + summary.periodLabel.toLowerCase(), W - pad, pad + logoH / 2 + 1)

  // The multiplier. formatMultiplier returns the bare number ("15", "3.4")
  // for everything under 1000x, with the "×" drawn separately below as its
  // own round-capped glyph (drawTimes) — except the capped ">1000×" string,
  // which already has its own "×" baked in (so an absurd multiplier reads as
  // "this is a cap", not as a round number). That case skips drawTimes
  // entirely and shrinks to fit instead of assuming a single-number width.
  const mult = formatMultiplier(summary.multiplier)
  const isCapped = mult.endsWith('×')
  const numSize = wide ? 228 : (H > W ? 400 : 310)
  const numTop = wide ? pad + logoH + 26 : pad + logoH + (H > W ? 56 : 30)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = t.ink
  const baseline = numTop + numSize * 0.78
  if (isCapped) {
    const maxNumeralWidth = (wide ? 760 : W) - pad * 2 - (wide ? 40 : 0)
    const fitSize = fitText(ctx, mult, maxNumeralWidth, numSize, 800, USAGE_CARD_ROUND_FONT)
    ctx.font = `800 ${fitSize}px ${USAGE_CARD_ROUND_FONT}`
    ctx.fillText(mult, pad - fitSize * 0.03, numTop + fitSize * 0.78)
  } else {
    ctx.font = `800 ${numSize}px ${USAGE_CARD_ROUND_FONT}`
    ctx.fillText(mult, pad - numSize * 0.03, baseline)
    const numW = ctx.measureText(mult).width
    const xSize = numSize * 0.36
    drawTimes(ctx, pad + numW + numSize * 0.06, baseline - xSize - numSize * 0.03, xSize, t.ink)
  }

  // The sentence under it
  const leftW = wide ? 640 : W - pad * 2
  const line1 = `${fmtInt(summary.hours)} hours of agent work in ${fmtInt(summary.wall)} hours`
  const s1 = fitText(ctx, line1, leftW, wide ? 30 : 40, 600, USAGE_CARD_SANS_FONT)
  ctx.fillStyle = t.ink
  ctx.font = `600 ${s1}px ${USAGE_CARD_SANS_FONT}`
  const sentenceY = baseline + (wide ? 50 : 72)
  ctx.fillText(line1, pad, sentenceY)

  // Stats
  const stats: Array<[string, string]> = [
    [String(summary.peakDay.peak), 'agents at peak'],
    [fmtInt(summary.hours), 'agent hours'],
    [fmtInt(summary.tasksShipped), 'tasks shipped'],
    [fmtTokens(summary.tokens), 'tokens']
  ]
  if (wide) {
    const sx = 760
    const top = pad + logoH + 46
    const rowH = (H - top - pad - 8) / 4
    ctx.fillStyle = t.rule
    ctx.fillRect(sx - 40, top - 4, 2, rowH * 4 - 12)
    stats.forEach(([v, l], i) => {
      const y = top + i * rowH
      ctx.fillStyle = t.ink
      ctx.font = `700 46px ${USAGE_CARD_ROUND_FONT}`
      ctx.textBaseline = 'top'
      ctx.fillText(v, sx, y)
      ctx.fillStyle = t.soft
      ctx.font = `500 19px ${USAGE_CARD_SANS_FONT}`
      ctx.fillText(l, sx, y + 54)
    })
  } else {
    const tall = H > W
    const cols = tall ? 2 : 4 // square: one row of four
    const top = sentenceY + (tall ? 70 : 52)
    const colW = (W - pad * 2) / cols
    const rowH = 142
    stats.forEach(([v, l], i) => {
      const x = pad + (i % cols) * colW
      const y = top + Math.floor(i / cols) * rowH
      ctx.fillStyle = t.ink
      ctx.font = `700 ${tall ? 68 : 50}px ${USAGE_CARD_ROUND_FONT}`
      ctx.textBaseline = 'top'
      ctx.fillText(v, x, y)
      ctx.fillStyle = t.soft
      ctx.font = `500 ${tall ? 26 : 22}px ${USAGE_CARD_SANS_FONT}`
      ctx.fillText(l, x, y + (tall ? 80 : 60))
    })
  }

  // The activity calendar: a GitHub-style contribution grid, one cell per
  // calendar day, colour intensity by that day's live agent-hours relative
  // to the period's busiest day. Replaces the mock's "peak day as lanes"
  // block in the same footprint — see the module docstring for why.
  const availW = wide ? 600 : W - pad * 2
  const { cols, cells } = buildCalendarGrid(summary.calendar)
  const maxHours = cells.reduce((m, c) => Math.max(m, c.hours), 0)
  let cellSize = wide ? 13 : 15
  let gap = wide ? 3 : 4
  if (cols > 0) {
    const naturalW = cols * cellSize + (cols - 1) * gap
    if (naturalW > availW) {
      const shrink = availW / naturalW
      cellSize *= shrink
      gap *= shrink
    }
  }
  const gridH = 7 * cellSize + 6 * gap
  const gy = H - pad - gridH - (wide ? 0 : 44)
  const [r0, g0, b0] = t.cell
  const radius = Math.max(1.5, cellSize * 0.22)
  cells.forEach(({ col, row, hours }) => {
    const x = pad + col * (cellSize + gap)
    const y = gy + row * (cellSize + gap)
    const level = calendarLevel(hours, maxHours)
    ctx.fillStyle = level === 0 ? t.faint : `rgba(${r0},${g0},${b0},${USAGE_CARD_CALENDAR_LEVEL_OPACITY[level]})`
    ctx.beginPath()
    ctx.roundRect(x, y, cellSize, cellSize, radius)
    ctx.fill()
  })
  ctx.fillStyle = t.soft
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.font = `500 ${wide ? 16 : 22}px ${USAGE_CARD_SANS_FONT}`
  ctx.fillText(`${fmtDate(summary.peakDay.atMs)}, my busiest day: ${summary.peakDay.peak} agents at once`, pad, gy - (wide ? 12 : 16))

  // Footer — the literal repo URL, same as the mock, not a dynamically resolved one.
  ctx.textAlign = 'right'
  ctx.fillStyle = t.soft
  ctx.font = `500 ${wide ? 17 : 22}px ${USAGE_CARD_SANS_FONT}`
  ctx.fillText('github.com/peakflo/20x', W - pad, H - pad + (wide ? 2 : 4))
  ctx.textAlign = 'left'
}

/**
 * The one entry point both the on-screen hero and the PNG export call.
 * Sizes the canvas to `shape` at `scale` (desktop hero: `Math.min(2,
 * devicePixelRatio)`; export: exactly 1) and draws into it.
 */
export function renderToCanvas(canvas: HTMLCanvasElement, shape: UsageCardShape, summary: UsageCardSummary, opts: UsageCardOptions, scale: number): void {
  const [W, H] = USAGE_CARD_SHAPES[shape]
  canvas.width = W * scale
  canvas.height = H * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  drawCard(ctx, W, H, summary, opts)
}

// ── Wiring the backend response into the card's narrow type ─────
//
// Pure and shared by the desktop hero/Share dialog and the mobile hero, so
// both read the "ratio not computable yet" case the same way instead of
// each inventing its own notion of "empty".

/** Why `buildUsageCardSummary` returned null — lets callers phrase the empty state precisely instead of a single generic "no data" message. */
export type UsageCardEmptyReason =
  /** No agent-run interval in the period at all. */
  | 'no-agent-data'
  /**
   * There's some live (non-backfilled) agent-run time recorded, but not yet
   * an hour of it — not enough evidence to show a real multiplier. This is
   * expected for every real user in roughly the first hour after this
   * feature ships (or after a fresh install): the ratio only reflects
   * live-observed data, never a backfilled estimate, so there's a brief
   * honest "still gathering evidence" window before the real number can
   * appear.
   */
  | 'not-enough-evidence-yet'
  /** Enough live agent-run time exists, but there's no screen-time data to divide by yet (e.g. focus tracking only just started, or every agent run happened while the app was never focused). */
  | 'no-screen-time-data'

export interface UsageCardBuildResult {
  summary: UsageCardSummary | null
  /** Set whenever `summary` is null. */
  emptyReason: UsageCardEmptyReason | null
}

/**
 * Minimum live (non-backfilled) total agent run time, in ms, before the
 * card will show a real multiplier. Below this, a ratio is technically
 * computable but not a meaningful one — a few minutes of live agent work
 * against a few minutes of screen time can produce a wild number either
 * way. `totalRunMs` already excludes backfilled rows (see
 * `AgentManager.getUsageParallelismSummary`), so this is strictly "live
 * evidence", never padded by best-effort history.
 */
const MIN_EVIDENCE_RUN_MS = 60 * 60 * 1000 // 1 hour

/**
 * Maps the backend's `UsageParallelismResponse` (+ the token count, which
 * comes from the existing token-usage summary, not this response) into the
 * narrow `UsageCardSummary` the card is allowed to draw. Returns a null
 * `summary` when the multiplier isn't computable, or isn't backed by enough
 * live evidence yet — `drawCard` always needs a real, meaningful number for
 * the headline, so every "not yet" case is handled by the caller (an
 * empty-state UI) instead of being drawn.
 */
export function buildUsageCardSummary(response: UsageParallelismResponse, tokens: number, periodLabel: string): UsageCardBuildResult {
  const p = response.parallelism
  if (!p.hasData) {
    return { summary: null, emptyReason: 'no-agent-data' }
  }
  if (p.totalRunMs < MIN_EVIDENCE_RUN_MS) {
    return { summary: null, emptyReason: 'not-enough-evidence-yet' }
  }
  if (p.multiplier === null || !p.peak) {
    return { summary: null, emptyReason: 'no-screen-time-data' }
  }
  return {
    summary: {
      periodLabel,
      multiplier: p.multiplier,
      hours: p.totalRunMs / (60 * 60 * 1000),
      wall: p.screenTimeMs / (60 * 60 * 1000),
      peakDay: { atMs: p.peak.atMs, peak: p.peak.count },
      tasksShipped: response.tasksShipped,
      tokens,
      calendar: p.perDay.map((d) => ({ day: d.day, hours: d.runHours }))
    },
    emptyReason: null
  }
}
