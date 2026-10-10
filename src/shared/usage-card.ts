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
 * a real user couldn't tell what it was showing. It has gone through
 * several replacements since. A GitHub-style day-per-cell CALENDAR, then a
 * single row of 24 hour-of-day buckets, both misread the actual request —
 * a real user's own reference screenshot clarified it's a **day × hour-of-
 * day GRID**: one column per calendar day, 8 rows (3-hour buckets:
 * 00:00, 03:00, ... 21:00), both axes meaningful at once, columns grouped
 * under month labels with day-of-month ticks, cells coloured GitHub-
 * intensity-style. See the "day×hour activity grid" section of `drawCard`
 * and `UsageCardDayHourCell`.
 *
 * That grid only reads cleanly at a moderate number of columns — the
 * user's own reference spanned ~27 days and still looked fine, but 90 or
 * 182 columns × 8 rows would be illegibly dense. So there are actually TWO
 * layouts sharing one footprint, chosen purely by the nominal period length
 * (`summary.periodDays`, 7/30/90/182 — see `USAGE_CARD_DAY_HOUR_GRID_MAX_DAYS`):
 * at 7 or 30 days, the day×hour grid; at 90 or 182, a simpler one-cell-per-
 * day GitHub weeks×weekdays grid (the very first design this card had,
 * revived here as the long-period fallback — see `buildCalendarGrid`).
 * Both read the same underlying per-day token scaffold (`dailyCalendar`);
 * the day×hour grid additionally needs `hourlyCells`, a genuinely more
 * granular data source with no day-grid equivalent.
 *
 * Every cell's value (in both layouts) is a TOKEN count — the same token
 * pipeline (`token_usage_events`) the Token usage tab's own tokens-per-day
 * chart reads, via `byDay`/`byDayHour` (see usage-store.ts). `byDayHour`
 * buckets by (local calendar day, local hour-of-day / 3) — `byDay` alone
 * has no intra-day resolution, so this is a genuinely separate query, not
 * derived from the daily totals. See `buildUsageCardSummary`.
 *
 * ── Ratio vs. aggregate, two different gates ─────────────────
 * The multiplier (the big number) and the "N hours of agent work in M
 * hours" SENTENCE draw from LIVE (non-backfilled) data only, and only once
 * there's at least an hour of it — a ratio from a few minutes of noisy data
 * is worse than no ratio. Everything else on the card — the activity grid,
 * peak day/concurrency, tasks shipped, tokens, and the "agent hours" STAT
 * TILE itself — is a plain aggregate, not a ratio, and draws from ALL data
 * (live + backfilled) with no minimum, same as `tasksShipped` and `tokens`.
 * This is why `UsageCardSummary` carries two separate hours fields: `hours`
 * (always the full total, for the stat tile) and `liveHours` (live-only,
 * null exactly when the ratio isn't ready, for the sentence). They're
 * deliberately allowed to show different numbers — they answer different
 * questions ("how much agent work have I ever done" vs. "what's feeding the
 * live ratio right now") — see `UsageCardSummary.hours` and `.liveHours`.
 * So `drawCard` always draws the full card (real activity grid, real peak
 * day, real stats including a real "agent hours" tile) whenever there's any
 * agent-run data at all; only the multiplier digit and its sentence fall
 * back to a placeholder when the ratio isn't ready. See
 * `UsageCardSummary.multiplier` and `buildUsageCardSummary`.
 *
 * ── Privacy, enforced by construction ───────────────────────
 * `UsageCardSummary` and `UsageCardOptions` are the ONLY way to get data into
 * `drawCard`. Neither type has a cost field, a task title, a repo name, or a
 * model name — this file does not import anything that has one either — so
 * nothing of the kind can reach the drawn (shareable) image, structurally,
 * not just by caller discipline. See usage-card.test.ts for a compile-time
 * check that enforces this.
 */

import { formatMultiplier, totalTokens, type ParallelismPeriodDays, type UsageDayHourRow, type UsageDayRow, type UsageParallelismResponse } from './usage'

// ── Data contract ────────────────────────────────────────────

/**
 * One calendar day's total token volume — the activity grid's day AXIS
 * (both layouts share this). `day` is a `YYYY-MM-DD` local-calendar-day key
 * (see `ParallelismDayRow.day` in shared/usage.ts, which supplies the dense
 * date scaffold — see the module docstring) — no session, task, or agent
 * identity travels with it, just a date and a token count.
 *
 * Sourced from the same `summary.byDay` (+ `totalTokens()`) the tokens-per-
 * day chart reads, so the grid and the chart always agree on which days
 * were busy. Includes the full period's token history — token accounting
 * has no "live vs. backfilled" distinction the way agent-run intervals do,
 * so unlike the multiplier/hours/wall trio below there is no live-only
 * filtering question here.
 */
export interface UsageCardCalendarDay {
  day: string
  tokens: number
}

/**
 * One (day, 3-hour-of-day bucket) cell's token total — the day×hour grid's
 * finer data source, with no equivalent in `UsageCardCalendarDay` (a day
 * total alone can't tell you WHEN during that day the activity happened).
 * `bucket` is 0-7 (0 = 00:00-03:00 local .. 7 = 21:00-24:00 local) — see
 * `UsageDayHourRow` in shared/usage.ts, which this is built from 1:1 (dense:
 * one entry per (day in `dailyCalendar`) × (bucket 0-7), zero-filled, so
 * `drawCard` never needs to handle a missing cell).
 */
export interface UsageCardDayHourCell {
  day: string
  bucket: number
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
   * Total agent run time EVER recorded in the period, in hours — LIVE +
   * backfilled, the full honest total. This is the "agent hours" STAT TILE
   * number, and is NEVER gated: it's a plain sum, same bucket as
   * `tasksShipped`/`tokens`, always real whenever there's any agent-run
   * data at all. Deliberately separate from `liveHours` below — showing
   * "0" here next to real `tasksShipped`/`tokens` totals looked broken, not
   * conservative, to a real user. It is fine and expected for this number
   * to differ from `liveHours`: they answer different questions ("how much
   * agent work have I ever done" vs. "what's feeding the live ratio right
   * now").
   */
  hours: number
  /**
   * Live (non-backfilled) total agent run time in the period, in hours —
   * the multiplier's own numerator, described by the "N hours of agent
   * work in M hours" SENTENCE (and the aria-label's equivalent text), never
   * the stat tile. Null exactly when the ratio isn't ready (same gate as
   * `multiplier`/`wall`) — not enough live evidence yet, or no screen-time
   * data to divide by.
   */
  liveHours: number | null
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
  /** One entry per calendar day in the period, each day's total token volume — the activity grid's day axis, in both layouts. See `UsageCardCalendarDay`. */
  dailyCalendar: UsageCardCalendarDay[]
  /**
   * Dense: one entry per (day in `dailyCalendar`) × (bucket 0-7). Only
   * meaningful/used at `periodDays <= USAGE_CARD_DAY_HOUR_GRID_MAX_DAYS`
   * (the day×hour grid layout) — built unconditionally anyway since it's
   * cheap even at the longest period (182 days × 8 = 1,456 entries) and
   * keeps `buildUsageCardSummary` simple. See `UsageCardDayHourCell`.
   */
  hourlyCells: UsageCardDayHourCell[]
  /**
   * The nominal period length (7/30/90/182 — the period tab the user
   * picked), used ONLY to decide which activity-grid layout to draw (the
   * day×hour grid at 7/30 days, the coarser one-cell-per-day weeks grid at
   * 90/182 — see `drawCard` and `USAGE_CARD_DAY_HOUR_GRID_MAX_DAYS`).
   * Deliberately NOT derived from `dailyCalendar.length`: the backend's
   * day-scaffold can legitimately come back with one extra boundary day
   * (e.g. 8 entries for a nominal 7-day period, when the period's
   * start/end don't land exactly on a local-day boundary) without that
   * meaning the period itself is actually longer. Keying the LAYOUT CHOICE
   * off that incidental array length instead of the real period caused a
   * genuine bug in an earlier version of this card's day-grid (an 8-entry
   * calendar for a nominal 7-day period reading as "only one column").
   * `dailyCalendar.length` itself is still the right thing to use for
   * sizing (how many columns to actually draw) — only the layout decision
   * needs the stable `periodDays` instead.
   */
  periodDays: ParallelismPeriodDays
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
  // Describes the RATIO's own inputs, same as the on-card sentence — uses
  // `liveHours`, not the always-full `hours` stat. Both go null together.
  const ratio = summary.multiplier !== null && summary.wall !== null && summary.liveHours !== null
    ? `${Math.round(summary.multiplier)} agents in parallel on average. ${fmtInt(summary.liveHours)} hours of agent work in ${fmtInt(summary.wall)} hours. `
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
 * fraction of it), and matters in BOTH directions: too thin (a hairline)
 * reads as a small disconnected mark floating in a mostly-empty
 * number-sized box; too thick (an earlier version tried `width * 0.5`+,
 * roughly digit-stroke-to-digit-height proportions) loses all "line"
 * quality to the round caps and reads as a solid filled capsule/blob, not
 * a dash — effectively a blank loading-skeleton shape instead of a "—".
 * The call site keeps this in the same ballpark as `drawTimes`'s own
 * `size * 0.2` stroke weight (the "×" stays legible as two crossing lines
 * at that ratio) rather than anywhere near `width`'s own magnitude.
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

// ── Activity grid — two layouts sharing one colour scale ─────
//
// `summary.dailyCalendar` (per-day token totals) supplies the day axis for
// BOTH layouts; `summary.hourlyCells` additionally feeds the day×hour grid.
// Which layout draws is purely a function of the nominal period length —
// see `drawCard`'s "activity grid" section for the switch, and
// `USAGE_CARD_DAY_HOUR_GRID_MAX_DAYS`.

/** One placed cell in the long-period weeks grid: `col` = week index (0 = earliest week), `row` = weekday (0 = Sunday .. 6 = Saturday). */
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
 * Nth day since the period started". Used for longer periods (90/182 days,
 * where a day×hour grid would be too dense to read) — see
 * `USAGE_CARD_DAY_HOUR_GRID_MAX_DAYS`.
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
 * scaled relative to the busiest cell in whatever's being drawn (a day, in
 * the long-period grid; a (day, hour-bucket) cell, in the day×hour grid)
 * rather than to a fixed token count — so a quiet period and a packed one
 * each use the full range. A 0-token cell is always level 0, drawn in the
 * theme's `faint` token so it reads as "clearly empty" rather than "the
 * lightest shade of present". Shared by both activity-grid layouts.
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

/**
 * At or below this nominal period length (`summary.periodDays` — the
 * 7/30/90/182 period tab, NOT `summary.dailyCalendar.length`), the activity
 * grid draws as day×hour-of-day (one column per day, 8 rows of 3-hour
 * buckets); above it, as the coarser one-cell-per-day weeks×weekdays grid.
 * The day×hour grid needs real column width to stay legible — a user's own
 * reference screenshot spanned ~27 days and still read fine, so 30 is
 * where the period tabs naturally land just past that; 90/182 columns ×
 * 8 rows would be illegibly dense, hence the fallback.
 *
 * Compared against `periodDays` (not `dailyCalendar.length`) deliberately:
 * the backend's day-scaffold can legitimately come back with one extra
 * boundary day (e.g. 8 entries for a nominal 7-day period, when the
 * period's start/end don't land exactly on a local-day boundary) without
 * that meaning the period itself is actually longer — keying the LAYOUT
 * CHOICE off that incidental array length instead of the real period
 * caused a real bug in an earlier version of this card.
 */
const USAGE_CARD_DAY_HOUR_GRID_MAX_DAYS = 30

/** 0 → "00:00", 3 → "03:00", ... 21 → "21:00" — the day×hour grid's row labels. */
function fmtBucketLabel(bucket: number): string {
  return `${String(bucket * 3).padStart(2, '0')}:00`
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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
    drawDash(ctx, pad, baseline, numSize * 0.9, numSize * 0.15, t.ink)
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

  // The sentence under it describes the RATIO's own inputs, so it uses
  // `liveHours` (live-only), never the always-full `hours` stat-tile value
  // below — `wall`/`liveHours` go null together (the same evidence gate),
  // so checking either alone is equivalent; `wall` is kept as the check to
  // match the placeholder text's own focus ("screen time").
  const leftW = wide ? 640 : W - pad * 2
  const line1 = summary.wall !== null && summary.liveHours !== null
    ? `${fmtInt(summary.liveHours)} hours of agent work in ${fmtInt(summary.wall)} hours`
    : 'Still learning your screen time'
  const s1 = fitText(ctx, line1, leftW, wide ? 30 : 40, 600, USAGE_CARD_SANS_FONT)
  ctx.fillStyle = t.ink
  ctx.font = `600 ${s1}px ${USAGE_CARD_SANS_FONT}`
  const sentenceY = baseline + (wide ? 50 : 72)
  ctx.fillText(line1, pad, sentenceY)

  // Stats — "agent hours" is always a real, full (live + backfilled) number
  // (see UsageCardSummary.hours's doc comment): it's a plain sum, not gated
  // behind the ratio like the sentence above it (which uses `liveHours`
  // instead). It is expected and fine for this number to differ from
  // whatever live-only figure the sentence shows.
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

  // The activity grid — one of two layouts, same colour scale, same
  // footprint. Replaces the mock's "peak day as lanes" block — see the
  // module docstring for the full history.
  const availW = wide ? 600 : W - pad * 2
  const [r0, g0, b0] = t.cell
  let gy: number
  if (summary.dailyCalendar.length > 0 && summary.periodDays <= USAGE_CARD_DAY_HOUR_GRID_MAX_DAYS) {
    // Short/medium period: a day×hour-of-day grid — one column per day, 8
    // rows (3-hour buckets, 00:00..21:00), both axes meaningful at once.
    // Columns are grouped under month labels, with a day-of-month tick
    // roughly every 7 days, matching a real user's own reference
    // screenshot of this exact shape. Hour-bucket labels run down the left.
    const rows = 8
    const days = summary.dailyCalendar
    const dayCount = days.length
    const hourLabelW = wide ? 50 : 60
    const cellsW = availW - hourLabelW
    const cellGapX = wide ? 2 : 3
    const rawCellW = (cellsW - (dayCount - 1) * cellGapX) / dayCount
    const cellW = Math.min(rawCellW, wide ? 60 : 80)
    const cellH = wide ? 18 : 24
    const rowGapY = wide ? 2 : 3
    const cellsH = rows * cellH + (rows - 1) * rowGapY
    const monthRowH = wide ? 14 : 16
    const dayTickRowH = wide ? 14 : 18
    const headerGap = wide ? 4 : 6
    const headerH = monthRowH + dayTickRowH + headerGap
    gy = H - pad - headerH - cellsH - (wide ? 0 : 44)
    const gridLeft = pad + hourLabelW
    const cellsTop = gy + headerH
    const radius = Math.max(1.5, Math.min(cellW, cellH) * 0.25)

    // Dense lookup: `hourlyCells` already has one entry per (day, bucket)
    // — see UsageCardDayHourCell's doc comment — so this is never missing
    // a key for any (day, bucket) this loop asks for.
    const cellByDayBucket = new Map(summary.hourlyCells.map((c) => [`${c.day}|${c.bucket}`, c.tokens]))
    const maxTokens = summary.hourlyCells.reduce((m, c) => Math.max(m, c.tokens), 0)

    // Month label (drawn once per month, at that month's first visible
    // column) + a day-of-month tick every 7 columns, both above the cells.
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    let lastMonth = -1
    days.forEach((d, i) => {
      const x = gridLeft + i * (cellW + cellGapX)
      const dateMs = Date.parse(`${d.day}T00:00:00Z`)
      const month = new Date(dateMs).getUTCMonth()
      if (month !== lastMonth) {
        ctx.fillStyle = t.soft
        ctx.font = `600 ${wide ? 12 : 14}px ${USAGE_CARD_SANS_FONT}`
        ctx.fillText(MONTH_ABBR[month], x, gy + monthRowH - 2)
        lastMonth = month
      }
      if (i % 7 === 0) {
        ctx.fillStyle = t.soft
        ctx.font = `500 ${wide ? 11 : 13}px ${USAGE_CARD_SANS_FONT}`
        ctx.fillText(String(new Date(dateMs).getUTCDate()), x, gy + monthRowH + dayTickRowH - 2)
      }
    })

    // Hour-bucket labels, left of the grid, one per row, vertically
    // centred on that row.
    for (let b = 0; b < rows; b++) {
      const rowCenterY = cellsTop + b * (cellH + rowGapY) + cellH / 2
      ctx.fillStyle = t.soft
      ctx.font = `500 ${wide ? 10 : 12}px ${USAGE_CARD_SANS_FONT}`
      ctx.textBaseline = 'middle'
      ctx.fillText(fmtBucketLabel(b), pad, rowCenterY)
    }
    ctx.textBaseline = 'alphabetic'

    // The cells themselves — colour intensity by that (day, bucket)'s token
    // volume relative to the busiest cell anywhere in the grid.
    days.forEach((d, i) => {
      const x = gridLeft + i * (cellW + cellGapX)
      for (let b = 0; b < rows; b++) {
        const y = cellsTop + b * (cellH + rowGapY)
        const tokens = cellByDayBucket.get(`${d.day}|${b}`) ?? 0
        const level = calendarLevel(tokens, maxTokens)
        ctx.fillStyle = level === 0 ? t.faint : `rgba(${r0},${g0},${b0},${USAGE_CARD_CALENDAR_LEVEL_OPACITY[level]})`
        ctx.beginPath()
        ctx.roundRect(x, y, cellW, cellH, radius)
        ctx.fill()
      }
    })
  } else {
    // Longer period: the GitHub-style one-cell-per-day contribution grid,
    // colour intensity by that day's token volume relative to the period's
    // busiest day. A day×hour grid would be too many columns to read
    // cleanly at this length — see USAGE_CARD_DAY_HOUR_GRID_MAX_DAYS.
    const { cols, cells } = buildCalendarGrid(summary.dailyCalendar)
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
 * null `multiplier`/`liveHours`/`wall` on an otherwise fully-populated
 * `UsageCardSummary` — the card still draws (activity grid, peak day,
 * tasks, tokens, and a real `hours` stat all real), just with a
 * placeholder where the ratio goes. A true empty state — no canvas at all
 * — is reserved for when there's nothing whatsoever to draw.
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
 * `byDay`/`byDayHour` (same `byDay` array `TokensPerDayChart` renders — see
 * the module docstring for why the activity grid reads these instead of
 * the parallelism response's own `perDay` for VALUES) into the narrow
 * `UsageCardSummary` the card is allowed to draw.
 *
 * Returns a null `summary` only when there's no agent-run data at all (live
 * or backfilled) — `hasData`/`peak` come from the backend's full (not
 * live-only-filtered) sweep, so a user with only pre-release backfilled
 * history still gets a real card, not the text-only empty state.
 *
 * Otherwise always returns a summary. `multiplier`/`liveHours`/`wall` are
 * null within it when the ratio isn't ready — not enough live evidence yet
 * (`totalRunMs < MIN_EVIDENCE_RUN_MS`), or no screen-time data to divide by
 * (`multiplier === null` from the backend, e.g. focus tracking only just
 * started) — `drawCard` renders a placeholder for just that region. Every
 * other field (`hours`, `dailyCalendar`, `hourlyCells`, `peakDay`,
 * `tasksShipped`, `tokens`) is a plain aggregate, not a ratio, and is
 * always populated whenever there's any underlying data, live or
 * backfilled.
 */
/**
 * `perDay` should always have exactly one entry per calendar day in the
 * period (see usage-parallelism.ts's `buildPerDay` — its day-enumeration
 * loop is period-bounds-driven, not data-driven, so it stays dense even
 * when every day is empty). This is a defensive backstop in case it's ever
 * shorter than the period actually is: the activity grid's day COUNT must
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

const MS_PER_HOUR = 60 * 60 * 1000
/** Number of 3-hour buckets in a day — the day×hour grid's row count. */
const HOUR_BUCKETS_PER_DAY = 8

export function buildUsageCardSummary(
  response: UsageParallelismResponse,
  byDay: UsageDayRow[],
  byDayHour: UsageDayHourRow[],
  tokens: number,
  periodLabel: string
): UsageCardBuildResult {
  const p = response.parallelism
  if (!p.hasData || !p.peak) {
    return { summary: null, emptyReason: 'no-agent-data' }
  }
  const ratioReady = p.totalRunMs >= MIN_EVIDENCE_RUN_MS && p.multiplier !== null
  // `perDay` supplies the dense, correctly-bucketed date SCAFFOLD (it
  // always has one entry per calendar day in the period, by construction —
  // see usage-parallelism.ts's buildPerDay); `byDay`/`byDayHour` are sparse
  // (only days/cells with at least one recorded token_usage_events row
  // appear at all), so they supply VALUES looked up per date (and per
  // date+bucket), defaulting to 0 where there's no token activity. This
  // keeps both activity-grid layouts' math correct (they depend on a
  // dense, gap-free day sequence) while still sourcing every value from
  // the same place the tokens-per-day chart does.
  const tokensByDay = new Map(byDay.map((d) => [d.day, totalTokens(d)]))
  const tokensByDayBucket = new Map(byDayHour.map((r) => [`${r.day}|${r.bucket}`, r.tokens]))
  const dayScaffold = ensureDenseDayScaffold(p.perDay, response.periodDays)
  const hourlyCells: UsageCardDayHourCell[] = dayScaffold.flatMap((d) =>
    Array.from({ length: HOUR_BUCKETS_PER_DAY }, (_, bucket) => ({
      day: d.day,
      bucket,
      tokens: tokensByDayBucket.get(`${d.day}|${bucket}`) ?? 0
    }))
  )
  return {
    summary: {
      periodLabel,
      multiplier: ratioReady ? p.multiplier : null,
      // Always the full (live + backfilled) total — a plain sum, never gated. See the field's own doc comment.
      hours: p.totalRunMsAll / MS_PER_HOUR,
      liveHours: ratioReady ? p.totalRunMs / MS_PER_HOUR : null,
      wall: ratioReady ? p.screenTimeMs / MS_PER_HOUR : null,
      peakDay: { atMs: p.peak.atMs, peak: p.peak.count },
      tasksShipped: response.tasksShipped,
      tokens,
      dailyCalendar: dayScaffold.map((d) => ({ day: d.day, tokens: tokensByDay.get(d.day) ?? 0 })),
      hourlyCells,
      periodDays: response.periodDays
    },
    emptyReason: null
  }
}
