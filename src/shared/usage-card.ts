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
 * colour intensity by that day's token volume. See `buildCalendarGrid` /
 * the "calendar" section of `drawCard`.
 *
 * The calendar's per-day value is each day's total TOKEN count — the exact
 * same `summary.byDay` the Token usage tab's own tokens-per-day chart
 * reads, via `totalTokens()` (shared/usage.ts), not a second data source.
 * It used to read the agent-run-intervals pipeline's per-day run hours
 * instead; that pipeline's backfill is newer and less proven, and a real
 * user's calendar came out almost empty while the token chart right below
 * it (fed by the long-running token_usage_events pipeline) showed rich
 * historical data for the same days. Using the same source the chart
 * already trusts sidesteps that gap entirely. The day-by-day SCAFFOLD
 * (which calendar dates exist, in order) still comes from
 * `ParallelismSummary.perDay` — that part is just date bookkeeping, dense
 * by construction, and unaffected by which pipeline is "proven"; only the
 * per-day VALUE looked up for each date switched source. See
 * `buildUsageCardSummary`.
 *
 * At 7 days or fewer the weeks×weekdays grid reads as 1-2 sparse columns,
 * so short periods switch to a different layout in the same footprint: one
 * column per day, each an isotype-style stack of unit blocks sized to that
 * day's share of the period's busiest day — see the "short period: one
 * column per day" branch in `drawCard`.
 *
 * ── Ratio vs. aggregate, two different gates ─────────────────
 * The multiplier (the big number + "N hours of agent work in M hours")
 * draws from LIVE (non-backfilled) data only, and only once there's at
 * least an hour of it — a ratio from a few minutes of noisy data is worse
 * than no ratio. Everything else on the card — the activity calendar, peak
 * day/concurrency, tasks shipped, tokens — is a plain aggregate, not a
 * ratio, and draws from ALL data (live + backfilled) with no minimum. So
 * `drawCard` always draws the full card (real calendar, real peak day, real
 * stats) whenever there's any agent-run data at all; only the multiplier
 * digit and its sentence fall back to a placeholder when the ratio isn't
 * ready. See `UsageCardSummary.multiplier` and `buildUsageCardSummary`.
 *
 * ── Privacy, enforced by construction ───────────────────────
 * `UsageCardSummary` and `UsageCardOptions` are the ONLY way to get data into
 * `drawCard`. Neither type has a cost field, a task title, a repo name, or a
 * model name — this file does not import anything that has one either — so
 * nothing of the kind can reach the drawn (shareable) image, structurally,
 * not just by caller discipline. See usage-card.test.ts for a compile-time
 * check that enforces this.
 */

import { formatMultiplier, totalTokens, type UsageDayRow, type UsageParallelismResponse } from './usage'

// ── Data contract ────────────────────────────────────────────

/**
 * One calendar day's total token volume, for the activity calendar. `day`
 * is a `YYYY-MM-DD` local-calendar-day key (see `ParallelismDayRow.day` in
 * shared/usage.ts, which supplies the dense date scaffold — see the module
 * docstring) — no session, task, or agent identity travels with it, just a
 * date and a token count.
 *
 * Sourced from the same `summary.byDay` (+ `totalTokens()`) the tokens-per-
 * day chart reads, so the calendar and the chart always agree on which
 * days were busy. Includes the full period's token history — token
 * accounting has no "live vs. backfilled" distinction the way agent-run
 * intervals do, so unlike the multiplier/hours/wall trio below there is no
 * live-only filtering question here.
 */
export interface UsageCardCalendarDay {
  day: string
  tokens: number
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
   * for why), computed from LIVE (non-backfilled) data only, and only once
   * there's at least an hour of it — see `buildUsageCardSummary`. Null means
   * the ratio isn't ready yet (not enough live evidence, or no screen-time
   * data to divide by); `drawCard` still draws the full card in that case —
   * calendar, peak day, tasks, tokens are all real — just with a "—"
   * placeholder in the number's place and a placeholder sentence instead of
   * hiding the whole card behind a text-only empty state. That text-only
   * empty state is reserved for when there's no agent-run data at all (see
   * `UsageCardEmptyReason`).
   */
  multiplier: number | null
  /**
   * Live total agent run time in the period, in hours. Unlike `multiplier`/
   * `wall`, this is NOT gated behind the ratio's evidence threshold — it's
   * a plain sum (the multiplier's numerator on its own, same bucket as
   * `tasksShipped`/`tokens`), always real whenever there's any agent-run
   * data. Only the full "N hours of agent work in M hours" SENTENCE (which
   * needs `wall` too) and the multiplier digit go into the pending state.
   */
  hours: number
  /** The user's own screen time in the app in the period, in hours — how long 20x was actually on screen. The multiplier's denominator ("N hours of agent work in M hours"). Null when the ratio isn't ready (exactly when `multiplier` is null) — this is what actually gates the sentence, not `hours`. */
  wall: number | null
  /**
   * Peak concurrency + which day, computed from ALL agent-run data (live
   * and backfilled) — not gated by the multiplier's live-evidence
   * threshold. This is a count, not a ratio: backfilled historical activity
   * is legitimate context for "my busiest day ever", not something to hide.
   */
  peakDay: UsageCardPeakDay
  /** Tasks that reached completed in the period. */
  tasksShipped: number
  /** Total tokens processed in the period — a count, never a cost. */
  tokens: number
  /** One entry per calendar day in the period, each day's total token volume — drawn as the activity calendar. See `UsageCardCalendarDay`. */
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
  const ratio = summary.multiplier !== null && summary.wall !== null
    ? `${Math.round(summary.multiplier)} agents in parallel on average. ${fmtInt(summary.hours)} hours of agent work in ${fmtInt(summary.wall)} hours. `
    : 'Multiplier still gathering evidence. '
  return `${summary.periodLabel}: ${ratio}`
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

/**
 * The multiplier's "not ready yet" placeholder — a single round-capped
 * horizontal stroke, in the same bespoke style as `drawTimes`/the logo's
 * eyes, where the number would otherwise go. Deliberately NOT a text glyph
 * (e.g. an em dash drawn via `fillText`): the big numeral's font stack
 * leads with a system rounded face that isn't guaranteed to carry every
 * punctuation glyph in every weight on every platform, and a missing glyph
 * renders as a "tofu" box instead of a dash. A hand-drawn stroke has no
 * such dependency.
 *
 * `y` is the NUMERAL BASELINE (same meaning as `ctx.fillText(mult, x,
 * baseline)` at the real-number call site) — the stroke's bottom edge sits
 * at `y`, matching where a real digit's visual mass sits relative to its
 * own baseline.
 *
 * `thickness` is an explicit, separate parameter from `width` (not a fixed
 * fraction of it) specifically so the call site can make this chunky
 * enough to occupy a comparable vertical footprint to the real numeral it
 * replaces — a thin stroke sized like an underline still reads as "a small
 * disconnected mark floating in a mostly-empty number-sized box", even
 * once its bottom edge is correctly baseline-anchored (an earlier version
 * learned this the hard way: baseline-anchoring alone fixed the gap to the
 * sentence below but left most of the numeral's usual height empty above
 * it, which still read as broken).
 */
export function drawDash(ctx: UsageCardContext2D, x: number, y: number, width: number, thickness: number, color: string): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = thickness
  ctx.lineCap = 'round'
  const cy = y - thickness / 2
  ctx.beginPath()
  ctx.moveTo(x, cy); ctx.lineTo(x + width, cy)
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

// ── Activity calendar — two layouts sharing one data source ──
//
// `summary.calendar` (per-day token totals) feeds BOTH layouts below. Which
// one draws is purely a function of how many days are in the period — see
// `drawCard`'s "activity calendar" section for the switch.

/** One placed cell in the long-period grid: `col` = week index (0 = earliest week), `row` = weekday (0 = Sunday .. 6 = Saturday). */
interface UsageCardCalendarCell {
  col: number
  row: number
  tokens: number
}

/**
 * Lays `calendar` (one entry per calendar day, in chronological order) out
 * into a GitHub-style grid: columns are weeks, rows are the 7 weekdays
 * (Sunday on top), filled top-to-bottom within a column then left-to-right
 * across columns — exactly how github.com's own contribution graph reads.
 * The first day's weekday determines how far down its column it lands, so
 * every later day's cell is anchored to its true weekday, not just "the
 * Nth day since the period started". Used for longer periods (30+ days) —
 * see `USAGE_CARD_CALENDAR_COLUMN_LAYOUT_MAX_DAYS`.
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
    return { col: Math.floor(offset / 7), row: offset % 7, tokens: d.tokens }
  })
  const cols = Math.max(...cells.map((c) => c.col)) + 1
  return { cols, cells }
}

/**
 * GitHub's own 5-level bucketing (0 = none, 1..4 = increasing activity),
 * scaled relative to the busiest day in the period rather than to a fixed
 * token count — so a quiet week and a packed one each use the full range.
 * A 0-token day is always level 0, drawn in the theme's `faint` token so it
 * reads as "clearly empty" rather than "the lightest shade of present".
 * Grid layout only — the short-period column layout encodes level as block
 * COUNT instead (see `drawCard`), not opacity.
 */
function calendarLevel(tokens: number, maxTokens: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || maxTokens <= 0) return 0
  const frac = tokens / maxTokens
  if (frac > 0.75) return 4
  if (frac > 0.5) return 3
  if (frac > 0.25) return 2
  return 1
}

const USAGE_CARD_CALENDAR_LEVEL_OPACITY = [0, 0.28, 0.48, 0.7, 0.94] as const

/** At or below this many days, the calendar switches from the weeks×weekdays grid to one column per day — the grid reads as 1-2 sparse columns otherwise. */
const USAGE_CARD_CALENDAR_COLUMN_LAYOUT_MAX_DAYS = 7
/**
 * Tallest a single day's unit-block stack can get in the column layout —
 * the busiest day in the period, scaled to this. Lower for `wide`: that
 * shape has the calendar sitting directly under the headline sentence with
 * no stats block above it to push it down first (square/tall both have
 * the 4-stat block in between, leaving far more vertical room), so a tall
 * stack there collides with the sentence. 7 blocks at `wide`'s block
 * height reproduces the exact footprint the old 7-row weeks grid always
 * used — a size already proven to fit.
 */
function usageCardCalendarMaxBlocks(wide: boolean): number {
  return wide ? 7 : 12
}

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
  const numSize = wide ? 228 : (H > W ? 400 : 310)
  const numTop = wide ? pad + logoH + 26 : pad + logoH + (H > W ? 56 : 30)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = t.ink
  const baseline = numTop + numSize * 0.78
  if (summary.multiplier === null) {
    // Ratio not ready yet (not enough live evidence, or no screen-time
    // data) — a bespoke dash, not a font glyph (see drawDash), where the
    // number would otherwise go, sized and baseline-anchored like the real
    // numeral it replaces so the sentence/caption/calendar below sit at
    // their normal distances either way. The rest of the card (calendar/
    // peak/tasks/tokens) still draws normally around it.
    drawDash(ctx, pad, baseline, numSize * 0.9, numSize * 0.5, t.ink)
  } else {
    const mult = formatMultiplier(summary.multiplier)
    const isCapped = mult.endsWith('×')
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
  }

  // The sentence under it — needs BOTH hours and wall, so `wall === null`
  // alone (not `hours`, which is always real) is what gates the placeholder.
  const leftW = wide ? 640 : W - pad * 2
  const line1 = summary.wall !== null
    ? `${fmtInt(summary.hours)} hours of agent work in ${fmtInt(summary.wall)} hours`
    : 'Still learning your screen time'
  const s1 = fitText(ctx, line1, leftW, wide ? 30 : 40, 600, USAGE_CARD_SANS_FONT)
  ctx.fillStyle = t.ink
  ctx.font = `600 ${s1}px ${USAGE_CARD_SANS_FONT}`
  const sentenceY = baseline + (wide ? 50 : 72)
  ctx.fillText(line1, pad, sentenceY)

  // Stats — "agent hours" is always a real number (see UsageCardSummary.hours's
  // doc comment): it's a plain sum, not gated behind the ratio like the
  // sentence above it is.
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

  // The activity calendar — one of two layouts, same data (summary.calendar,
  // each day's token total), same footprint. Replaces the mock's "peak day
  // as lanes" block — see the module docstring for the full history.
  const availW = wide ? 600 : W - pad * 2
  const [r0, g0, b0] = t.cell
  let gy: number
  if (summary.calendar.length > 0 && summary.calendar.length <= USAGE_CARD_CALENDAR_COLUMN_LAYOUT_MAX_DAYS) {
    // Short period: a weeks×weekdays grid would be 1-2 sparse columns, so
    // instead draw one column per day, each an isotype-style stack of unit
    // blocks — the day's share of the period's busiest day, in block COUNT
    // (not opacity, unlike the grid below: a stack of identical solid
    // blocks is the clearer "quantity" signal when there are only a
    // handful of columns to fill the same width). A day with no tokens
    // still gets one faint "slot" block at the baseline — same "clearly
    // empty, not absent" language the grid uses for its own 0-level cells
    // — so every column reads as present even when quiet.
    const dayCount = summary.calendar.length
    const blockH = wide ? 13 : 15
    const blockGapY = wide ? 3 : 4
    const colGap = wide ? 10 : 14
    const maxBlocks = usageCardCalendarMaxBlocks(wide)
    const colW = (availW - (dayCount - 1) * colGap) / dayCount
    const stackH = maxBlocks * blockH + (maxBlocks - 1) * blockGapY
    gy = H - pad - stackH - (wide ? 0 : 44)
    const radius = Math.max(1.5, blockH * 0.22)
    const maxTokens = summary.calendar.reduce((m, d) => Math.max(m, d.tokens), 0)
    const floorY = gy + stackH - blockH
    summary.calendar.forEach((d, i) => {
      const x = pad + i * (colW + colGap)
      const blocks = maxTokens > 0 && d.tokens > 0 ? Math.max(1, Math.round((d.tokens / maxTokens) * maxBlocks)) : 0
      if (blocks === 0) {
        ctx.fillStyle = t.faint
        ctx.beginPath()
        ctx.roundRect(x, floorY, colW, blockH, radius)
        ctx.fill()
        return
      }
      ctx.fillStyle = `rgba(${r0},${g0},${b0},${opts.theme === 'azure' ? 0.95 : 0.9})`
      for (let b = 0; b < blocks; b++) {
        const y = floorY - b * (blockH + blockGapY)
        ctx.beginPath()
        ctx.roundRect(x, y, colW, blockH, radius)
        ctx.fill()
      }
    })
  } else {
    // Longer period: the GitHub-style contribution grid, colour intensity
    // by that day's token volume relative to the period's busiest day.
    const { cols, cells } = buildCalendarGrid(summary.calendar)
    const maxTokens = cells.reduce((m, c) => Math.max(m, c.tokens), 0)
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
    gy = H - pad - gridH - (wide ? 0 : 44)
    const radius = Math.max(1.5, cellSize * 0.22)
    cells.forEach(({ col, row, tokens }) => {
      const x = pad + col * (cellSize + gap)
      const y = gy + row * (cellSize + gap)
      const level = calendarLevel(tokens, maxTokens)
      ctx.fillStyle = level === 0 ? t.faint : `rgba(${r0},${g0},${b0},${USAGE_CARD_CALENDAR_LEVEL_OPACITY[level]})`
      ctx.beginPath()
      ctx.roundRect(x, y, cellSize, cellSize, radius)
      ctx.fill()
    })
  }
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

/**
 * Why `buildUsageCardSummary` returned a null `summary` — there is now only
 * one such reason. Everything that used to be a separate "not ready yet"
 * empty state (not enough live evidence, no screen-time data) is instead a
 * null `multiplier`/`hours`/`wall` on an otherwise fully-populated
 * `UsageCardSummary` — the card still draws (calendar, peak day, tasks,
 * tokens all real), just with a placeholder where the ratio goes. A true
 * empty state — no canvas at all — is reserved for when there's nothing
 * whatsoever to draw.
 */
export type UsageCardEmptyReason =
  /** No agent-run interval in the period at all (live or backfilled) — there is nothing to draw. */
  | 'no-agent-data'

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
 * way. `response.parallelism.totalRunMs` is already live-only (see
 * `AgentManager.getUsageParallelismSummary`), so this is strictly "live
 * evidence", never padded by best-effort history.
 */
const MIN_EVIDENCE_RUN_MS = 60 * 60 * 1000 // 1 hour

/**
 * Maps the backend's `UsageParallelismResponse` + the token-usage summary's
 * `byDay` (same array `TokensPerDayChart` renders — see the module
 * docstring for why the calendar reads this instead of the parallelism
 * response's own `perDay`) into the narrow `UsageCardSummary` the card is
 * allowed to draw.
 *
 * Returns a null `summary` only when there's no agent-run data at all (live
 * or backfilled) — `hasData`/`peak` come from the backend's full (not
 * live-only-filtered) sweep, so a user with only pre-release backfilled
 * history still gets a real card, not the text-only empty state.
 *
 * Otherwise always returns a summary. `multiplier`/`hours`/`wall` are null
 * within it when the ratio isn't ready — not enough live evidence yet
 * (`totalRunMs < MIN_EVIDENCE_RUN_MS`), or no screen-time data to divide by
 * (`multiplier === null` from the backend, e.g. focus tracking only just
 * started) — `drawCard` renders a placeholder for just that region. Every
 * other field (`calendar`, `peakDay`, `tasksShipped`, `tokens`) is a plain
 * aggregate, not a ratio, and is always populated whenever there's any
 * underlying data, live or backfilled.
 */
/**
 * `perDay` should always have exactly one entry per calendar day in the
 * period (see usage-parallelism.ts's `buildPerDay` — its day-enumeration
 * loop is period-bounds-driven, not data-driven, so it stays dense even
 * when every day is empty). This is a defensive backstop in case it's ever
 * shorter than the period actually is: the column layout's day COUNT must
 * never silently shrink to however many days happen to have data (that's
 * exactly the bug this guards against — a GitHub-style calendar with 1
 * column instead of 7 reads as broken, not "quiet period"). Extends
 * backward from the first known day, in the same day-key format `perDay`
 * already uses, using plain UTC-midnight date arithmetic — consistent with
 * how `buildCalendarGrid` already treats these keys (see its own comment:
 * resolved local-calendar-day keys are safe to parse as UTC midnight for
 * pure date arithmetic, since that's not a timezone conversion).
 */
function ensureDenseDayScaffold(perDay: Array<{ day: string }>, expectedDays: number): Array<{ day: string }> {
  if (perDay.length >= expectedDays || perDay.length === 0) return perDay
  const missing = expectedDays - perDay.length
  const anchorMs = Date.parse(`${perDay[0].day}T00:00:00Z`)
  const prefix = Array.from({ length: missing }, (_, i) => ({
    day: new Date(anchorMs - (missing - i) * 86_400_000).toISOString().slice(0, 10)
  }))
  return [...prefix, ...perDay]
}

export function buildUsageCardSummary(response: UsageParallelismResponse, byDay: UsageDayRow[], tokens: number, periodLabel: string): UsageCardBuildResult {
  const p = response.parallelism
  if (!p.hasData || !p.peak) {
    return { summary: null, emptyReason: 'no-agent-data' }
  }
  const ratioReady = p.totalRunMs >= MIN_EVIDENCE_RUN_MS && p.multiplier !== null
  // `perDay` supplies the dense, correctly-bucketed date SCAFFOLD (it
  // always has one entry per calendar day in the period, by construction —
  // see usage-parallelism.ts's buildPerDay); `byDay` is sparse (only days
  // with at least one recorded token_usage_events row appear in it at
  // all), so it supplies VALUES looked up per date, defaulting to 0 for a
  // day with no token activity. This keeps the calendar's weekday-grid
  // math correct (it depends on a dense, gap-free day sequence) while
  // still sourcing every value from the same place the tokens-per-day
  // chart does.
  const tokensByDay = new Map(byDay.map((d) => [d.day, totalTokens(d)]))
  const dayScaffold = ensureDenseDayScaffold(p.perDay, response.periodDays)
  return {
    summary: {
      periodLabel,
      multiplier: ratioReady ? p.multiplier : null,
      // Always real — a plain sum, not gated behind ratioReady. See the field's own doc comment.
      hours: p.totalRunMs / (60 * 60 * 1000),
      wall: ratioReady ? p.screenTimeMs / (60 * 60 * 1000) : null,
      peakDay: { atMs: p.peak.atMs, peak: p.peak.count },
      tasksShipped: response.tasksShipped,
      tokens,
      calendar: dayScaffold.map((d) => ({ day: d.day, tokens: tokensByDay.get(d.day) ?? 0 }))
    },
    emptyReason: null
  }
}
