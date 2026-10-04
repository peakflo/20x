/**
 * Pure normalizers that turn provider-specific usage payloads into the shared
 * shapes in `src/shared/usage.ts`. Kept free of Electron / DB imports so they
 * can be unit-tested in isolation.
 *
 * Inputs are typed loosely (`unknown` + guards): these payloads come from
 * external runtimes (Claude Agent SDK stream, `codex app-server` JSON-RPC)
 * whose shapes evolve independently of this app.
 */

import type {
  ProviderUsageLimits,
  ProviderUsageLimitsUpdate,
  TokenCounts,
  UsageLimitWindow,
  UsageWindowKind
} from '../../shared/usage'
import { clampPercent, sortUsageWindows } from '../../shared/usage'

// ── Cumulative token totals ─────────────────────────────────

/**
 * Running totals for one usage bucket of a provider session. Both providers
 * report *cumulative* figures (Claude: `modelUsage` per model for the query;
 * Codex: `tokenUsage.total` for the thread), so per-turn usage is computed as
 * the difference against the last persisted totals for the same bucket.
 */
export interface UsageTotals extends TokenCounts {
  /** Cumulative reported cost in USD, when the provider reports it. */
  costUsd: number | null
}

/** One bucket of cumulative usage: Claude = one model, Codex = the whole thread. */
export interface UsageBucket {
  /** Stable key within the provider session (model id for Claude, `thread` for Codex). */
  key: string
  /** Model the bucket's usage is attributed to. */
  model: string
  totals: UsageTotals
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

const TOKEN_FIELDS: Array<keyof TokenCounts> = [
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens'
]

export function isZeroUsage(totals: TokenCounts): boolean {
  return TOKEN_FIELDS.every((field) => !totals[field])
}

/** No tokens and no positive cost — nothing worth recording. */
export function isEmptyUsage(totals: UsageTotals): boolean {
  return isZeroUsage(totals) && !(totals.costUsd !== null && totals.costUsd > 0)
}

/**
 * Claude Agent SDK `result.modelUsage`: per-model totals for every model call
 * of the query pipeline (main loop, Task subagents, compaction, ...). These are
 * cumulative across turns of a streaming-input session, and a resumed session
 * continues from the totals its transcript saved.
 *
 * `inputTokens` excludes cache reads/writes; `thinkingTokens` is already
 * counted inside `outputTokens`.
 */
export function normalizeClaudeModelUsage(modelUsage: unknown): UsageBucket[] {
  if (!isObject(modelUsage)) return []
  const buckets: UsageBucket[] = []
  for (const [model, raw] of Object.entries(modelUsage)) {
    if (!isObject(raw) || !model) continue
    const outputTokens = num(raw.outputTokens)
    buckets.push({
      key: model,
      model,
      totals: {
        inputTokens: num(raw.inputTokens),
        cacheReadTokens: num(raw.cacheReadInputTokens),
        cacheWriteTokens: num(raw.cacheCreationInputTokens),
        outputTokens,
        reasoningTokens: Math.min(num(raw.thinkingTokens), outputTokens),
        costUsd: optionalNumber(raw.costUSD)
      }
    })
  }
  return buckets
}

/**
 * Codex app-server `thread/tokenUsage/updated` → one cumulative bucket for the
 * thread. Codex `inputTokens` *includes* cached input (and cache writes when
 * reported), so uncached input is derived. `reasoningOutputTokens` is part of
 * `outputTokens`.
 */
export function normalizeCodexThreadTokenUsage(params: unknown, model: string): {
  bucket: UsageBucket
  contextWindow: number | null
  turnId: string | null
} | null {
  if (!isObject(params) || !isObject(params.tokenUsage)) return null
  const tokenUsage = params.tokenUsage
  const total = isObject(tokenUsage.total) ? tokenUsage.total : null
  if (!total) return null

  const input = num(total.inputTokens)
  const cached = num(total.cachedInputTokens)
  const cacheWrite = num(total.cacheWriteInputTokens)
  const output = num(total.outputTokens)
  return {
    bucket: {
      key: 'thread',
      model,
      totals: {
        inputTokens: Math.max(0, input - cached - cacheWrite),
        cacheReadTokens: cached,
        cacheWriteTokens: cacheWrite,
        outputTokens: output,
        reasoningTokens: Math.min(num(total.reasoningOutputTokens), output),
        costUsd: null
      }
    },
    contextWindow: optionalNumber(tokenUsage.modelContextWindow),
    turnId: nonEmptyString(params.turnId)
  }
}

/**
 * Per-turn usage = current cumulative totals − previous cumulative totals.
 *
 * If any counter went *down*, the provider's running total restarted (a
 * resumed session without saved totals, a `/clear`, a new app-server thread
 * view, ...). In that case the current totals are the usage since the restart.
 */
export function computeUsageDelta(
  previous: UsageTotals | null | undefined,
  current: UsageTotals
): { delta: UsageTotals; reset: boolean } {
  if (!previous) return { delta: { ...current }, reset: false }

  const decreased =
    TOKEN_FIELDS.some((field) => current[field] < previous[field]) ||
    (current.costUsd !== null && previous.costUsd !== null && current.costUsd < previous.costUsd - 1e-9)

  if (decreased) return { delta: { ...current }, reset: true }

  const delta: UsageTotals = {
    inputTokens: current.inputTokens - previous.inputTokens,
    cacheReadTokens: current.cacheReadTokens - previous.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens - previous.cacheWriteTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningTokens: current.reasoningTokens - previous.reasoningTokens,
    costUsd:
      current.costUsd === null
        ? null
        : Math.max(0, current.costUsd - (previous.costUsd ?? 0))
  }
  return { delta, reset: false }
}

// ── Plan limits: shared helpers ─────────────────────────────

const SESSION_MINS = 5 * 60
const WEEK_MINS = 7 * 24 * 60
const MONTH_MINS = 30 * 24 * 60

function isoFromEpochSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  // Defensive: accept epoch milliseconds too.
  const ms = value > 1e12 ? value : value * 1000
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isoFromString(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function kindForDuration(mins: number | null | undefined): UsageWindowKind {
  if (!mins || !Number.isFinite(mins)) return 'other'
  if (mins <= 24 * 60) return 'session'
  if (mins <= 8 * 24 * 60) return 'weekly'
  if (mins >= 27 * 24 * 60) return 'monthly'
  return 'other'
}

function labelForDuration(mins: number | null | undefined): string {
  if (!mins || !Number.isFinite(mins)) return 'Usage'
  if (mins < 60) return `${mins}-minute`
  if (mins <= 24 * 60 && mins % 60 === 0) return `${mins / 60}-hour`
  if (mins === WEEK_MINS) return 'Weekly'
  if (mins >= 27 * 24 * 60 && mins <= 31 * 24 * 60) return 'Monthly'
  return `${Math.round(mins / (24 * 60))}-day`
}

// ── Plan limits: Claude ─────────────────────────────────────

const CLAUDE_WINDOWS: Record<string, { kind: UsageWindowKind; label: string; windowDurationMins: number }> = {
  five_hour: { kind: 'session', label: '5-hour', windowDurationMins: SESSION_MINS },
  seven_day: { kind: 'weekly', label: 'Weekly', windowDurationMins: WEEK_MINS },
  seven_day_opus: { kind: 'weekly', label: 'Weekly · Opus', windowDurationMins: WEEK_MINS },
  seven_day_sonnet: { kind: 'weekly', label: 'Weekly · Sonnet', windowDurationMins: WEEK_MINS }
}

function claudeWindow(id: string, usedPercent: number, resetsAt: string | null): UsageLimitWindow | null {
  const meta = CLAUDE_WINDOWS[id]
  if (!meta) return null
  return { id, ...meta, usedPercent: clampPercent(usedPercent), resetsAt }
}

/**
 * Claude Agent SDK `rate_limit_event.rate_limit_info`. Utilization on the
 * streamed event is a 0–1 fraction. Event types without a stable window
 * (overage buckets) are ignored rather than guessed.
 */
export function claudeRateLimitInfoToUpdate(info: unknown): ProviderUsageLimitsUpdate | null {
  if (!isObject(info)) return null
  const type = nonEmptyString(info.rateLimitType)
  const limitReached = info.status === 'rejected'
  if (!type || typeof info.utilization !== 'number' || !Number.isFinite(info.utilization)) {
    return limitReached ? { windows: [], limitReached } : null
  }
  const window = claudeWindow(type, info.utilization * 100, isoFromEpochSeconds(info.resetsAt))
  if (!window) return limitReached ? { windows: [], limitReached } : null
  return { windows: [window], limitReached }
}

/**
 * Claude Agent SDK `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`
 * response. Percentages here are already 0–100. `rate_limits_available` is
 * false for API-key, Bedrock, Vertex and other non-subscription auth.
 */
export function claudeUsageResponseToLimits(response: unknown, checkedAt: string): ProviderUsageLimits {
  const base: ProviderUsageLimits = { provider: 'claude-code', checkedAt, windows: [] }
  if (!isObject(response)) {
    return { ...base, unavailable: { reason: 'probe_failed', message: 'Claude Code returned no usage data' } }
  }
  const planType = nonEmptyString(response.subscription_type)
  if (response.rate_limits_available !== true || !isObject(response.rate_limits)) {
    return {
      ...base,
      planType,
      unavailable: {
        reason: 'unsupported',
        message: 'Plan limits are only reported for Claude subscription (Pro/Max/Team) logins.'
      }
    }
  }

  const limits = response.rate_limits
  const windows: UsageLimitWindow[] = []
  for (const id of Object.keys(CLAUDE_WINDOWS)) {
    const raw = limits[id]
    if (!isObject(raw) || typeof raw.utilization !== 'number') continue
    const window = claudeWindow(id, raw.utilization, isoFromString(raw.resets_at))
    if (window) windows.push(window)
  }

  if (Array.isArray(limits.model_scoped)) {
    for (const raw of limits.model_scoped) {
      if (!isObject(raw) || typeof raw.utilization !== 'number') continue
      const name = nonEmptyString(raw.display_name)
      if (!name) continue
      windows.push({
        id: `seven_day_scoped:${name.toLowerCase()}`,
        kind: 'weekly',
        label: `Weekly · ${name}`,
        usedPercent: clampPercent(raw.utilization),
        resetsAt: isoFromString(raw.resets_at),
        windowDurationMins: WEEK_MINS
      })
    }
  }

  return { ...base, planType, windows: sortUsageWindows(windows), unavailable: null }
}

// ── Plan limits: Codex ──────────────────────────────────────

/**
 * Picks the main `codex` bucket from a rate-limit read/update. Model-specific
 * buckets must not overwrite the main allowance; older CLIs omit `limitId`.
 */
function pickCodexSnapshot(source: Record<string, unknown>): Record<string, unknown> | null {
  if (isObject(source.rateLimitsByLimitId) && isObject(source.rateLimitsByLimitId.codex)) {
    return source.rateLimitsByLimitId.codex
  }
  if (isObject(source.rateLimits)) {
    const limitId = nonEmptyString(source.rateLimits.limitId)
    if (!limitId || limitId === 'codex') return source.rateLimits
  }
  return null
}

function codexSnapshotToWindows(snapshot: Record<string, unknown>): UsageLimitWindow[] {
  const planType = nonEmptyString(snapshot.planType)
  const isMonthlyPlan = planType === 'free' || planType === 'go'
  const positions: Array<[string, unknown, number]> = [
    ['primary', snapshot.primary, isMonthlyPlan ? MONTH_MINS : SESSION_MINS],
    ['secondary', snapshot.secondary, WEEK_MINS]
  ]
  const windows: UsageLimitWindow[] = []
  for (const [id, raw, fallbackMins] of positions) {
    if (!isObject(raw) || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) continue
    const windowDurationMins = typeof raw.windowDurationMins === 'number' && raw.windowDurationMins > 0
      ? raw.windowDurationMins
      : fallbackMins
    windows.push({
      id,
      kind: kindForDuration(windowDurationMins),
      label: labelForDuration(windowDurationMins),
      usedPercent: clampPercent(raw.usedPercent),
      resetsAt: isoFromEpochSeconds(raw.resetsAt),
      windowDurationMins
    })
  }
  return windows
}

/** `account/rateLimits/read` response → full limits snapshot. */
export function codexRateLimitsResponseToLimits(response: unknown, checkedAt: string): ProviderUsageLimits {
  const base: ProviderUsageLimits = { provider: 'codex', checkedAt, windows: [] }
  if (!isObject(response)) {
    return { ...base, unavailable: { reason: 'probe_failed', message: 'Codex returned no rate-limit data' } }
  }
  const snapshot = pickCodexSnapshot(response)
  const resetCredits = isObject(response.rateLimitResetCredits)
    ? optionalNumber(response.rateLimitResetCredits.availableCount)
    : null
  if (!snapshot) {
    return {
      ...base,
      resetCreditsAvailable: resetCredits,
      unavailable: { reason: 'unsupported', message: 'Codex did not report plan limits for this login.' }
    }
  }
  const windows = codexSnapshotToWindows(snapshot)
  return {
    ...base,
    planType: nonEmptyString(snapshot.planType),
    windows: sortUsageWindows(windows),
    limitReached: !!nonEmptyString(snapshot.rateLimitReachedType),
    resetCreditsAvailable: resetCredits,
    unavailable: windows.length === 0
      ? { reason: 'unsupported', message: 'Codex did not report plan limits for this login.' }
      : null
  }
}

/**
 * `account/rateLimits/updated` notification → sparse update. Nullable fields
 * that are missing in a rolling update must not clear previously known values.
 */
export function codexRateLimitsUpdatedToUpdate(params: unknown): ProviderUsageLimitsUpdate | null {
  if (!isObject(params) || !isObject(params.rateLimits)) return null
  const snapshot = params.rateLimits
  const limitId = nonEmptyString(snapshot.limitId)
  if (limitId && limitId !== 'codex') return null
  const windows = codexSnapshotToWindows(snapshot)
  const planType = nonEmptyString(snapshot.planType)
  const update: ProviderUsageLimitsUpdate = { windows }
  if (planType) update.planType = planType
  if ('rateLimitReachedType' in snapshot) update.limitReached = !!nonEmptyString(snapshot.rateLimitReachedType)
  return windows.length > 0 || update.planType || update.limitReached !== undefined ? update : null
}

// ── OpenCode ────────────────────────────────────────────────

/** A completed OpenCode assistant message as a discrete usage item. */
export interface OpenCodeMessageUsage {
  /** `${sessionID}:${messageID}` — unique per message. */
  sourceKey: string
  sessionId: string
  model: string
  usage: UsageTotals
  /** Unix ms the message was created. */
  createdAt: number | null
}

/**
 * OpenCode `AssistantMessage` (from `message.updated` events or
 * `session.messages()`). `tokens` / `cost` belong to that one message and are
 * final once `time.completed` (or `finish`) is set. `tokens.input` excludes
 * cache reads/writes; `reasoning` is reported separately from `output`.
 *
 * OpenCode reports `cost: 0` for models without a known price — including
 * subscription-backed models — so 0 means "unknown", not free.
 */
export function normalizeOpenCodeAssistantMessage(info: unknown): OpenCodeMessageUsage | null {
  if (!isObject(info) || info.role !== 'assistant') return null
  const id = nonEmptyString(info.id)
  const sessionId = nonEmptyString(info.sessionID)
  if (!id || !sessionId || !isObject(info.tokens)) return null
  const time = isObject(info.time) ? info.time : {}
  const completed = typeof time.completed === 'number' || nonEmptyString(info.finish) !== null
  if (!completed) return null

  const tokens = info.tokens
  const cache = isObject(tokens.cache) ? tokens.cache : {}
  const reasoning = num(tokens.reasoning)
  const providerId = nonEmptyString(info.providerID)
  const modelId = nonEmptyString(info.modelID)
  const cost = typeof info.cost === 'number' && Number.isFinite(info.cost) && info.cost > 0 ? info.cost : null
  return {
    sourceKey: `${sessionId}:${id}`,
    sessionId,
    model: modelId ? (providerId ? `${providerId}/${modelId}` : modelId) : 'unknown',
    usage: {
      inputTokens: num(tokens.input),
      cacheReadTokens: num(cache.read),
      cacheWriteTokens: num(cache.write),
      outputTokens: num(tokens.output) + reasoning,
      reasoningTokens: reasoning,
      costUsd: cost
    },
    createdAt: typeof time.created === 'number' ? time.created : null
  }
}

/**
 * OpenCode Go `GET https://opencode.ai/zen/go/v1/usage` response:
 * `{ usage: { rolling|weekly|monthly: { percent: 0–100, resetsAt: ISO } } }`.
 */
export function openCodeGoUsageToLimits(response: unknown, checkedAt: string): ProviderUsageLimits {
  const base: ProviderUsageLimits = { provider: 'opencode', checkedAt, planType: 'go', windows: [] }
  const usage = isObject(response) && isObject(response.usage) ? response.usage : null
  if (!usage) {
    return { ...base, unavailable: { reason: 'probe_failed', message: 'OpenCode Go returned no usage data' } }
  }
  const definitions: Array<[string, string, UsageWindowKind, string, number | null]> = [
    ['rolling', 'go_rolling', 'session', '5-hour', SESSION_MINS],
    ['weekly', 'go_weekly', 'weekly', 'Weekly', WEEK_MINS],
    ['monthly', 'go_monthly', 'monthly', 'Monthly', null]
  ]
  const windows: UsageLimitWindow[] = []
  for (const [field, id, kind, label, windowDurationMins] of definitions) {
    const raw = usage[field]
    if (!isObject(raw) || typeof raw.percent !== 'number' || !Number.isFinite(raw.percent)) continue
    windows.push({
      id,
      kind,
      label,
      usedPercent: clampPercent(raw.percent),
      resetsAt: isoFromString(raw.resetsAt) ?? isoFromEpochSeconds(raw.resetsAt),
      windowDurationMins
    })
  }
  return {
    ...base,
    windows,
    unavailable: windows.length === 0
      ? { reason: 'unsupported', message: 'OpenCode Go did not report any usage windows.' }
      : null
  }
}

// ── Pi ──────────────────────────────────────────────────────

/**
 * Pi RPC `get_session_stats` response data → one cumulative bucket for the
 * session. Totals cover every entry of the session file (assistant messages,
 * compaction and branch summaries). Pi `input` already excludes cached tokens;
 * stats carry no reasoning split. A `cost` of 0 with tokens means unknown
 * (some provider paths do not price usage).
 */
export function normalizePiSessionStats(data: unknown, model: string): UsageBucket | null {
  if (!isObject(data) || !isObject(data.tokens)) return null
  const tokens = data.tokens
  const cost = typeof data.cost === 'number' && Number.isFinite(data.cost) && data.cost > 0 ? data.cost : null
  return {
    key: 'session',
    model: model || 'unknown',
    totals: {
      inputTokens: num(tokens.input),
      cacheReadTokens: num(tokens.cacheRead),
      cacheWriteTokens: num(tokens.cacheWrite),
      outputTokens: num(tokens.output),
      reasoningTokens: 0,
      costUsd: cost
    }
  }
}

// ── Cursor (ACP) ────────────────────────────────────────────

/**
 * ACP `session/prompt` response `usage` (UNSTABLE in the protocol). The shipped
 * schema documents every field as a session total ("across all turns"), so it
 * is treated as cumulative; the tracker's delta logic also recovers if an
 * agent restarts its counters. `inputTokens` is taken as uncached input.
 * `costUsd` comes from the latest `usage_update.cost` (cumulative session cost).
 */
export function normalizeAcpPromptUsage(
  usage: unknown,
  model: string,
  cumulativeCostUsd: number | null
): UsageBucket | null {
  if (!isObject(usage)) return null
  const outputTokens = num(usage.outputTokens)
  const bucket: UsageBucket = {
    key: 'session',
    model: model || 'unknown',
    totals: {
      inputTokens: num(usage.inputTokens),
      cacheReadTokens: num(usage.cachedReadTokens),
      cacheWriteTokens: num(usage.cachedWriteTokens),
      outputTokens,
      reasoningTokens: Math.min(num(usage.thoughtTokens), outputTokens),
      costUsd: cumulativeCostUsd
    }
  }
  return isZeroUsage(bucket.totals) && !(cumulativeCostUsd && cumulativeCostUsd > 0) ? null : bucket
}

/** ACP `usage_update.cost` → USD amount, or null when absent / not USD. */
export function acpUsageUpdateCostUsd(update: unknown): number | null {
  if (!isObject(update) || !isObject(update.cost)) return null
  const amount = update.cost.amount
  const currency = typeof update.cost.currency === 'string' ? update.cost.currency.trim().toUpperCase() : ''
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null
  return currency === 'USD' ? amount : null
}

/**
 * Cursor `aiserver.v1.DashboardService/GetCurrentPeriodUsage` response:
 * `{ billingCycleEnd?: epoch-ms (string|number), planUsage?: { totalPercentUsed?, autoPercentUsed?, apiPercentUsed? } }`.
 */
export function cursorPeriodUsageToLimits(response: unknown, checkedAt: string): ProviderUsageLimits {
  const base: ProviderUsageLimits = { provider: 'cursor', checkedAt, windows: [] }
  if (!isObject(response)) {
    return { ...base, unavailable: { reason: 'probe_failed', message: 'Cursor returned no usage data' } }
  }
  const planUsage = isObject(response.planUsage) ? response.planUsage : null
  const cycleEnd = Number(response.billingCycleEnd)
  const resetsAt = Number.isFinite(cycleEnd) && cycleEnd > 0 ? new Date(cycleEnd).toISOString() : null
  const definitions: Array<[string, string, string]> = [
    ['totalPercentUsed', 'total', 'Monthly · Overall'],
    ['autoPercentUsed', 'auto', 'Monthly · Cursor models'],
    ['apiPercentUsed', 'api', 'Monthly · Other models']
  ]
  const windows: UsageLimitWindow[] = []
  for (const [field, id, label] of planUsage ? definitions : []) {
    const value = planUsage![field]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    windows.push({ id, kind: 'monthly', label, usedPercent: clampPercent(value), resetsAt, windowDurationMins: null })
  }
  return {
    ...base,
    windows,
    unavailable: windows.length === 0
      ? { reason: 'unsupported', message: 'Cursor did not report plan usage for this login.' }
      : null
  }
}
