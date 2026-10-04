/**
 * Subscription usage tracking — types shared by the main process, the desktop
 * renderer, and the mobile web app.
 *
 * Two independent signals are tracked:
 *
 * 1. **Plan limits** — how much of each subscription window (Claude Pro/Max
 *    5-hour / weekly, Codex ChatGPT-plan primary / secondary) is used and when
 *    it resets. Reported by the provider runtime itself; never estimated.
 * 2. **Token usage** — tokens (and, when the provider reports it, estimated
 *    USD cost) consumed by each agent turn, attributed to task / agent / model.
 *
 * Cost figures are provider-reported *API-equivalent estimates*. They are not
 * a subscription bill: subscription plans bill separately.
 */

export type UsageProvider = 'claude-code' | 'codex'

export const USAGE_PROVIDERS: readonly UsageProvider[] = ['claude-code', 'codex'] as const

export const USAGE_PROVIDER_LABELS: Record<UsageProvider, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex'
}

export function isUsageProvider(value: unknown): value is UsageProvider {
  return value === 'claude-code' || value === 'codex'
}

// ── Plan limits ─────────────────────────────────────────────

export type UsageWindowKind = 'session' | 'weekly' | 'monthly' | 'other'

export interface UsageLimitWindow {
  /** Stable per provider, e.g. `five_hour`, `seven_day`, `primary`. */
  id: string
  kind: UsageWindowKind
  label: string
  /** 0–100. */
  usedPercent: number
  /** ISO-8601 time the window resets, when the provider reports it. */
  resetsAt?: string | null
  windowDurationMins?: number | null
}

export interface ProviderUsageLimits {
  provider: UsageProvider
  /** ISO-8601 time of the last successful read or update. */
  checkedAt: string
  /** e.g. `pro`, `max`, `plus`, `team` — when reported. */
  planType?: string | null
  windows: UsageLimitWindow[]
  /** True when the provider reported that a limit is currently blocking requests. */
  limitReached?: boolean
  /** Banked rate-limit reset credits, when the provider reports them (Codex). */
  resetCreditsAvailable?: number | null
  /**
   * Set when limits cannot be shown: `unsupported` for API-key / third-party
   * auth where plan limits do not apply, `probe_failed` when the last read
   * failed (previous windows are kept so the UI can still show them).
   */
  unavailable?: { reason: 'unsupported' | 'probe_failed'; message: string } | null
}

/** A partial update streamed during a turn. Windows are upserted by id. */
export interface ProviderUsageLimitsUpdate {
  windows: UsageLimitWindow[]
  planType?: string | null
  limitReached?: boolean
  resetCreditsAvailable?: number | null
}

export interface UsageLimitsRefreshResult {
  limits: ProviderUsageLimits[]
  /** Providers that were actually probed by this call (others were throttled or not configured). */
  refreshed: UsageProvider[]
}

/**
 * Upsert `update` into `previous`. Windows missing from the update are kept;
 * a window update that omits `resetsAt` / `windowDurationMins` keeps the
 * previously known values. Returns `previous` unchanged (same reference) when
 * nothing changed, so callers can skip persistence and broadcasts.
 */
export function mergeUsageLimits(
  provider: UsageProvider,
  previous: ProviderUsageLimits | null | undefined,
  update: ProviderUsageLimitsUpdate,
  checkedAt: string
): ProviderUsageLimits {
  const windows = [...(previous?.windows ?? [])]
  let changed = !previous

  for (const incoming of update.windows) {
    const index = windows.findIndex((w) => w.id === incoming.id)
    if (index === -1) {
      windows.push(incoming)
      changed = true
      continue
    }
    const current = windows[index]
    const merged: UsageLimitWindow = {
      ...current,
      ...incoming,
      resetsAt: incoming.resetsAt ?? current.resetsAt ?? null,
      windowDurationMins: incoming.windowDurationMins ?? current.windowDurationMins ?? null
    }
    if (
      merged.usedPercent !== current.usedPercent ||
      merged.resetsAt !== current.resetsAt ||
      merged.label !== current.label ||
      merged.kind !== current.kind ||
      merged.windowDurationMins !== current.windowDurationMins
    ) {
      windows[index] = merged
      changed = true
    }
  }

  const planType = update.planType !== undefined && update.planType !== null
    ? update.planType
    : previous?.planType ?? null
  const limitReached = update.limitReached ?? previous?.limitReached ?? false
  const resetCreditsAvailable = update.resetCreditsAvailable !== undefined
    ? update.resetCreditsAvailable
    : previous?.resetCreditsAvailable ?? null

  if (
    !changed &&
    previous &&
    planType === (previous.planType ?? null) &&
    limitReached === (previous.limitReached ?? false) &&
    resetCreditsAvailable === (previous.resetCreditsAvailable ?? null) &&
    !previous.unavailable
  ) {
    return previous
  }

  return {
    provider,
    checkedAt,
    planType,
    windows: sortUsageWindows(windows),
    limitReached,
    resetCreditsAvailable,
    unavailable: null
  }
}

const WINDOW_KIND_ORDER: Record<UsageWindowKind, number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3
}

export function sortUsageWindows(windows: UsageLimitWindow[]): UsageLimitWindow[] {
  return [...windows].sort((a, b) => {
    const kind = WINDOW_KIND_ORDER[a.kind] - WINDOW_KIND_ORDER[b.kind]
    if (kind !== 0) return kind
    return a.id.localeCompare(b.id)
  })
}

/**
 * A window whose reset time has passed has rolled over even if no fresh
 * reading arrived yet; show it as unused rather than as a stale high number.
 */
export function effectiveUsedPercent(window: UsageLimitWindow, nowMs = Date.now()): number {
  if (window.resetsAt) {
    const resetMs = Date.parse(window.resetsAt)
    if (Number.isFinite(resetMs) && resetMs <= nowMs) return 0
  }
  return clampPercent(window.usedPercent)
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

// ── Token usage ─────────────────────────────────────────────

export interface TokenCounts {
  /** Input tokens not served from cache. */
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Output tokens, including reasoning/thinking tokens. */
  outputTokens: number
  /** Reasoning/thinking tokens (already counted inside outputTokens). */
  reasoningTokens: number
}

export const ZERO_TOKEN_COUNTS: TokenCounts = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0
}

/** Tokens processed: input + cache read + cache write + output (reasoning is inside output). */
export function totalTokens(counts: TokenCounts): number {
  return counts.inputTokens + counts.cacheReadTokens + counts.cacheWriteTokens + counts.outputTokens
}

/**
 * - `reported`: the provider runtime reported the cost (e.g. Claude Code).
 * - `unavailable`: the provider does not report cost (e.g. Codex).
 */
export type UsageCostSource = 'reported' | 'unavailable'

export interface TokenUsageRecord extends TokenCounts {
  id: string
  taskId: string | null
  agentId: string | null
  provider: UsageProvider
  model: string
  /** Provider session / thread id the usage was observed on. */
  sessionId: string | null
  costUsd: number | null
  costSource: UsageCostSource
  /** Unix ms. */
  createdAt: number
}

export interface UsageSummaryQuery {
  /** Unix ms lower bound (inclusive). Defaults to 7 days ago. */
  sinceMs?: number
  /** Unix ms upper bound (exclusive). Defaults to now. */
  untilMs?: number
  /**
   * Minutes east of UTC for day bucketing (e.g. `-new Date().getTimezoneOffset()`).
   * Defaults to the main process' local offset.
   */
  utcOffsetMinutes?: number
  taskId?: string
}

export interface UsageAggregate extends TokenCounts {
  /** Sum of reported cost. Null when no record in the group reported cost. */
  costUsd: number | null
  /** Number of usage records (one per model per completed turn). */
  records: number
  /** Records whose cost was not reported. */
  unpricedRecords: number
}

export interface UsageModelRow extends UsageAggregate {
  provider: UsageProvider
  model: string
}

export interface UsageDayRow extends UsageAggregate {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
}

export interface UsageTaskRow extends UsageAggregate {
  taskId: string
  title: string | null
}

export interface UsageSummary {
  sinceMs: number
  untilMs: number
  totals: UsageAggregate
  byProvider: Array<UsageAggregate & { provider: UsageProvider }>
  byModel: UsageModelRow[]
  byDay: UsageDayRow[]
  topTasks: UsageTaskRow[]
}

// ── Event channels (IPC + mobile WebSocket) ─────────────────

/** Payload: `ProviderUsageLimits`. */
export const USAGE_LIMITS_UPDATED_CHANNEL = 'usage:limits-updated'
/** Payload: `TokenUsageRecord[]` recorded for one turn. */
export const USAGE_RECORDED_CHANNEL = 'usage:recorded'

// ── Formatting helpers (renderer + mobile) ──────────────────

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`
  return String(Math.round(value))
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value > 0 && value < 0.01) return '<$0.01'
  return `$${value.toFixed(2)}`
}

/** "in 2h 14m", "in 3d 4h", "now" — relative to `nowMs`. */
export function formatResetIn(resetsAt: string | null | undefined, nowMs = Date.now()): string | null {
  if (!resetsAt) return null
  const resetMs = Date.parse(resetsAt)
  if (!Number.isFinite(resetMs)) return null
  const diff = resetMs - nowMs
  if (diff <= 0) return 'now'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `in ${days}d ${hours % 24}h`
}

export type UsageLimitLevel = 'normal' | 'warning' | 'critical'

/** Status level for a plan-limit window: warning from 75% used, critical from 90%. */
export function usageLimitLevel(usedPercent: number): UsageLimitLevel {
  if (usedPercent >= 90) return 'critical'
  if (usedPercent >= 75) return 'warning'
  return 'normal'
}

export type UsagePeriod = '24h' | '7d' | '30d'

export const USAGE_PERIOD_MS: Record<UsagePeriod, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
}

export function usageSummaryQueryForPeriod(period: UsagePeriod, nowMs = Date.now()): UsageSummaryQuery {
  return {
    sinceMs: nowMs - USAGE_PERIOD_MS[period],
    untilMs: nowMs + 1,
    utcOffsetMinutes: -new Date(nowMs).getTimezoneOffset()
  }
}
