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

/** Every coding-agent harness 20x runs. Ids match `coding_agent` on agent configs. */
export type UsageProvider = 'claude-code' | 'codex' | 'opencode' | 'cursor' | 'pi' | 'acp'

export const USAGE_PROVIDERS: readonly UsageProvider[] = ['claude-code', 'codex', 'opencode', 'cursor', 'pi', 'acp'] as const

export const USAGE_PROVIDER_LABELS: Record<UsageProvider, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'Pi',
  acp: 'ACP agent'
}

export function isUsageProvider(value: unknown): value is UsageProvider {
  return typeof value === 'string' && (USAGE_PROVIDERS as readonly string[]).includes(value)
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
  /**
   * Harness instance the limits belong to (one subscription login). Defaults to
   * the implicit default instance of the provider when absent.
   */
  instanceId?: string
  /** Label shown in the usage bar and settings, e.g. "Codex · Work". */
  instanceLabel?: string
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
  /**
   * A user action that would make limits available (e.g. allowing Keychain
   * access for the Cursor CLI login). Rendered as a button where supported.
   */
  action?: { id: string; label: string } | null
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
  /** Harness instance ids that were actually probed by this call (others were throttled or not configured). */
  refreshed: string[]
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
    unavailable: null,
    action: null
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
 * - `reported`: the provider runtime reported the cost (Claude Code, OpenCode, Pi, Cursor when sent).
 * - `unavailable`: the provider does not report cost (e.g. Codex).
 */
export type UsageCostSource = 'reported' | 'unavailable'

/**
 * Cost source of an *aggregated* row (query-time, after pricing), shown to the
 * user as a marker next to the amount:
 *
 * - `reported`: every contributing record had a (trustworthy) provider-reported cost.
 * - `estimated`: some or all of the cost was computed from the public rate table.
 * - `custom`: a user-set price for this model was used (overrides reported and estimated).
 * - `unpriced`: no reported cost and no known rate — the amount is unknown.
 */
export type UsageCostEstimateSource = 'reported' | 'estimated' | 'custom' | 'unpriced'

/**
 * A user-set price for a model the public rate table does not know, or whose
 * published rate the user wants to override. Rates are USD per million tokens
 * for readability; `0` means free. Cache rates default to the input rate when
 * left blank (`undefined`), matching the public rate table's own fallback.
 */
export interface CustomModelPrice {
  /** Normalised model id (lowercase, no provider prefix) this price applies to. */
  model: string
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok?: number | null
  cacheWritePerMTok?: number | null
}

export interface TokenUsageRecord extends TokenCounts {
  id: string
  taskId: string | null
  agentId: string | null
  provider: UsageProvider
  model: string
  /** Provider session / thread id the usage was observed on. */
  sessionId: string | null
  /** Harness instance that produced the usage. Null for rows recorded before instances existed. */
  instanceId?: string | null
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
  /**
   * Total cost: reported + estimated (from the public rate table or a custom
   * price). Null only when nothing in the group is priced at all.
   */
  costUsd: number | null
  /** Portion of `costUsd` the provider itself reported. Null when nothing was reported. */
  reportedCostUsd: number | null
  /** Portion of `costUsd` computed from a public rate or a custom price. Null when nothing was estimated. */
  estimatedCostUsd: number | null
  /** Number of usage records (one per model per completed turn). */
  records: number
  /** Records with neither a reported cost nor a known rate — the true "unknown price" count. */
  unpricedRecords: number
  /**
   * Estimated USD saved by cache reads vs. paying the input rate for the same
   * tokens: `cacheReadTokens × (inputRate − cacheReadRate)`. Null when no rate
   * (public or custom) was known for any contributing model.
   */
  cacheSavingsUsd: number | null
}

export interface UsageModelRow extends UsageAggregate {
  provider: UsageProvider
  model: string
  /** Where this row's `costUsd` came from. Drives the "estimated" / "custom" / "No price" UI markers. */
  costSource: UsageCostEstimateSource
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
/** Payload: `CustomModelPrice[]` — fires after a custom price is set or reset. */
export const USAGE_MODEL_PRICES_UPDATED_CHANNEL = 'usage:modelPricesUpdated'

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

/** Tooltip text for the small marker shown next to an estimated/custom cost. Null for `reported`/`unpriced` (no marker). */
export function costSourceTooltip(source: UsageCostEstimateSource): string | null {
  if (source === 'estimated') return 'Estimated from public API rates'
  if (source === 'custom') return 'Custom price'
  return null
}

/** Short hint shown next to "Est. cost": absent once everything is priced, "partial" only while something is truly unpriced. */
export function usageCostHint(aggregate: Pick<UsageAggregate, 'records' | 'unpricedRecords'>): string | undefined {
  if (aggregate.records === 0) return undefined
  if (aggregate.unpricedRecords === aggregate.records) return 'not reported'
  if (aggregate.unpricedRecords > 0) return 'partial — some models have no known price'
  return 'API-equivalent estimate — not your subscription bill'
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

/** Above this share of a window used, usage is shown in yellow. */
export const USAGE_WARNING_PERCENT = 75
/** Above this share of a window used, usage is shown in red. */
export const USAGE_CRITICAL_PERCENT = 90

/** Status level for a usage meter: yellow above 75% used, red above 90%. */
export function usageLimitLevel(usedPercent: number): UsageLimitLevel {
  if (usedPercent > USAGE_CRITICAL_PERCENT) return 'critical'
  if (usedPercent > USAGE_WARNING_PERCENT) return 'warning'
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
