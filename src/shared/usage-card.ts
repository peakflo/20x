/**
 * The "my multiplier" share card — one canvas-drawing module shared by the
 * desktop hero card, the Share dialog's export, and the mobile hero.
 *
 * This is a faithful, line-for-line port of the approved mock
 * (usage-page-mock-shareable-20x-card/index.html — `drawLogo`, `drawTimes`,
 * `fitText`, `drawCard`, `renderToCanvas`, `THEMES`, `SHAPES`, `ROUND`/`SANS`),
 * with exactly one kind of change: every mock data field that came from the
 * mock's seeded random generator is replaced by a field on `UsageCardSummary`
 * fed by the real `ParallelismSummary` (src/main/usage/usage-parallelism.ts).
 * The mock's `laneRuns(day)` synthetic generator is dropped entirely — the
 * real `peakDayLanes` the query engine already computes is used as-is.
 *
 * ── Privacy, enforced by construction ───────────────────────
 * `UsageCardSummary` and `UsageCardOptions` are the ONLY way to get data into
 * `drawCard`. Neither type has a cost field, a task title, a repo name, or a
 * model name — this file does not import anything that has one either — so
 * nothing of the kind can reach the drawn (shareable) image, structurally,
 * not just by caller discipline. See usage-card.test.ts for a compile-time
 * check that enforces this.
 */

import { formatMultiplier } from './usage'

// ── Data contract ────────────────────────────────────────────

export interface UsageCardPeakDaySegment {
  /** Fraction (0..1) of the peak day's active window where this run starts. */
  startFrac: number
  /** Fraction (0..1) of the peak day's active window where this run ends. */
  endFrac: number
}

/**
 * One agent session's run segments on the peak day, already clipped to that
 * day and normalized to the day's active window. No session, task, or agent
 * identity travels with it — the card has no use for it and must never carry
 * it into a shared image.
 */
export interface UsageCardLane {
  segments: UsageCardPeakDaySegment[]
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
  /** Every session's run segments on the peak day (the "multiplier, drawn" lanes block). */
  lanes: UsageCardLane[]
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

// ── The card ──────────────────────────────────────────────────

/**
 * Draws the full card: header (logo + wordmark + "<name>, <period>"), the
 * giant multiplier, the "N hours of agent work in M hours" sentence, the 4
 * stats (layout differs by shape), the peak-day lanes with its caption, and
 * the footer. One function for the on-screen hero and the exported image —
 * call it via `renderToCanvas`.
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

  // The multiplier
  const mult = formatMultiplier(summary.multiplier)
  const numSize = wide ? 228 : (H > W ? 400 : 310)
  const numTop = wide ? pad + logoH + 26 : pad + logoH + (H > W ? 56 : 30)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = t.ink
  ctx.font = `800 ${numSize}px ${USAGE_CARD_ROUND_FONT}`
  const baseline = numTop + numSize * 0.78
  ctx.fillText(mult, pad - numSize * 0.03, baseline)
  const numW = ctx.measureText(mult).width
  const xSize = numSize * 0.36
  drawTimes(ctx, pad + numW + numSize * 0.06, baseline - xSize - numSize * 0.03, xSize, t.ink)

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

  // The peak day as lanes: one row per agent, one bar per run. This is the multiplier, drawn.
  const lanes = summary.lanes
  const availW = wide ? 600 : W - pad * 2
  const rows = lanes.length
  const lanesH = wide ? 158 : (H > W ? 262 : 236)
  const gap = wide ? 2.5 : 4
  const rowH = rows > 0 ? (lanesH - gap * (rows - 1)) / rows : 0
  const gy = H - pad - lanesH - (wide ? 0 : 44)
  const [r0, g0, b0] = t.cell
  lanes.forEach((lane, i) => {
    const y = gy + i * (rowH + gap)
    ctx.fillStyle = `rgba(${r0},${g0},${b0},0.12)`
    ctx.beginPath()
    ctx.roundRect(pad, y, availW, rowH, rowH / 2)
    ctx.fill()
    lane.segments.forEach(({ startFrac, endFrac }) => {
      ctx.fillStyle = `rgba(${r0},${g0},${b0},${opts.theme === 'azure' ? 0.95 : 0.9})`
      ctx.beginPath()
      ctx.roundRect(pad + startFrac * availW, y, Math.max(rowH, (endFrac - startFrac) * availW), rowH, rowH / 2)
      ctx.fill()
    })
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
