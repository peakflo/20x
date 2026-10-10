/**
 * Prices token usage from a public rate table, so every harness — including
 * ones that never report a cost (Codex) or report `0` for subscription
 * logins (Pi, OpenCode) — gets an API-equivalent cost estimate.
 *
 * Kept free of Electron / network / filesystem imports so it can be unit
 * tested in isolation; `usage-pricing-fetch.ts` fetches the live table and
 * `usage-pricing-service.ts` wires fetching, disk caching and the TTL/refresh
 * floor together.
 *
 * Source format: `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
 * — a flat map of model id → cost fields, USD per token. This module never
 * sends that id anywhere; it is only used to look up a price.
 */

import type { CustomModelPrice, UsageCostEstimateSource, UsageProvider } from '../../shared/usage'
import { BUNDLED_RATE_TABLE_RAW } from './usage-pricing-fallback'

// ── Rate table shape ─────────────────────────────────────────

/** USD per token. */
export interface TokenRate {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type SpeedTier = 'standard' | 'fast' | 'ultrafast'

export interface ModelRateEntry {
  standard: TokenRate
  /** `*_priority` rates, or the standard rate × `provider_specific_entry.fast` (Claude). */
  fast?: TokenRate
  /** `*_ultrafast` rates. */
  ultrafast?: TokenRate
}

/** Keyed by the source's own (lowercased) model id — see `normalizeModelId` for how a stored model id is matched against it. */
export type RateTable = Record<string, ModelRateEntry>

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Reads one tier's four rates from `fields` using `suffix` (`''` for
 * standard, `'_priority'` for fast, `'_ultrafast'` for ultrafast). Cache rates
 * missing for this tier fall back to this tier's own input rate — never free
 * by omission. Returns null when the tier's input or output rate is absent
 * (e.g. a model with no published fast tier).
 *
 * Fields matching `*_above_<n>k_tokens*`, `*_flex` and `*_batches` are never
 * read: 20x does not track per-request context length or batch/flex mode, so
 * those tiered/alternate rates would silently misprice requests.
 */
function readTier(fields: Record<string, unknown>, suffix: string): TokenRate | null {
  const input = finiteNonNegative(fields[`input_cost_per_token${suffix}`])
  const output = finiteNonNegative(fields[`output_cost_per_token${suffix}`])
  if (input === null || output === null) return null
  const cacheRead = finiteNonNegative(fields[`cache_read_input_token_cost${suffix}`]) ?? input
  const cacheWrite = finiteNonNegative(fields[`cache_creation_input_token_cost${suffix}`]) ?? input
  return { input, output, cacheRead, cacheWrite }
}

function scaleRate(rate: TokenRate, factor: number): TokenRate {
  return { input: rate.input * factor, output: rate.output * factor, cacheRead: rate.cacheRead * factor, cacheWrite: rate.cacheWrite * factor }
}

/**
 * Parses the litellm-shaped `{ modelId: { input_cost_per_token, ... } }` map
 * into a `RateTable`. Entries without a usable standard input/output rate
 * (image/audio/embedding models, the `sample_spec` schema-documentation
 * entry, ...) are skipped — they are not models 20x prices.
 */
export function parseRateTable(raw: unknown): RateTable {
  const table: RateTable = {}
  if (!isPlainObject(raw)) return table

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'sample_spec' || !isPlainObject(value)) continue
    const standard = readTier(value, '')
    if (!standard) continue

    const fastFromPriority = readTier(value, '_priority')
    const fastMultiplier = isPlainObject(value.provider_specific_entry)
      ? finiteNonNegative(value.provider_specific_entry.fast)
      : null
    const fast = fastFromPriority ?? (fastMultiplier !== null ? scaleRate(standard, fastMultiplier) : undefined)
    const ultrafast = readTier(value, '_ultrafast') ?? undefined

    const entry: ModelRateEntry = { standard }
    if (fast) entry.fast = fast
    if (ultrafast) entry.ultrafast = ultrafast
    table[key.toLowerCase()] = entry
  }
  return table
}

/** Parsed once at module load — see `usage-pricing-fallback.ts`. */
export const BUNDLED_FALLBACK_RATE_TABLE: RateTable = parseRateTable(BUNDLED_RATE_TABLE_RAW)

// ── Model id normalisation + lookup ──────────────────────────

interface NormalizedModelId {
  /** Lowercased id, provider prefix kept, date/variant suffixes stripped. */
  providerQualified: string
  /** `providerQualified` with everything up to and including the last `/` removed. */
  bare: string
}

/**
 * `openai/gpt-5-codex[1m]` → `{ providerQualified: 'openai/gpt-5-codex', bare: 'gpt-5-codex' }`.
 * Strips `[...]` variant markers (context-window tags like `[1m]`) and a
 * trailing `-YYYYMMDD` date suffix (Claude's dated snapshot ids) before
 * splitting on the last `/`.
 */
export function normalizeModelId(model: string): NormalizedModelId {
  let id = (model ?? '').trim().toLowerCase()
  id = id.replace(/\[[^\]]*\]/g, '').trim()
  id = id.replace(/-\d{8}$/, '')
  id = id.replace(/-\d{4}-\d{2}-\d{2}$/, '')
  const slash = id.lastIndexOf('/')
  const bare = slash === -1 ? id : id.slice(slash + 1)
  return { providerQualified: id, bare }
}

function lookupRateEntry(table: RateTable, model: string): ModelRateEntry | null {
  const { providerQualified, bare } = normalizeModelId(model)
  if (!bare) return null
  return table[providerQualified] ?? table[bare] ?? null
}

function rateForTier(entry: ModelRateEntry, tier: SpeedTier): TokenRate {
  if (tier === 'fast') return entry.fast ?? entry.standard
  if (tier === 'ultrafast') return entry.ultrafast ?? entry.standard
  return entry.standard
}

/**
 * Builds a memoised lookup function bound to `table`. 20x does not currently
 * track a request's speed tier, so callers pass `'standard'`; the parameter
 * exists so tier rates (parsed above) are exercised and ready once a signal
 * for it exists.
 */
export function createRateLookup(table: RateTable): (provider: string, model: string, tier?: SpeedTier) => TokenRate | null {
  const memo = new Map<string, ModelRateEntry | null>()
  return (_provider: string, model: string, tier: SpeedTier = 'standard'): TokenRate | null => {
    const memoKey = model.trim().toLowerCase()
    let entry = memo.get(memoKey)
    if (entry === undefined) {
      entry = lookupRateEntry(table, model)
      memo.set(memoKey, entry)
    }
    return entry ? rateForTier(entry, tier) : null
  }
}

// ── Custom prices ────────────────────────────────────────────

/** USD per token, applying the same "cache falls back to input" rule as the public table. `0` means free. */
export function customPriceToRate(price: CustomModelPrice): TokenRate {
  const input = Math.max(0, price.inputPerMTok) / 1_000_000
  const output = Math.max(0, price.outputPerMTok) / 1_000_000
  const cacheRead = (price.cacheReadPerMTok != null ? Math.max(0, price.cacheReadPerMTok) : price.inputPerMTok) / 1_000_000
  const cacheWrite = (price.cacheWritePerMTok != null ? Math.max(0, price.cacheWritePerMTok) : price.inputPerMTok) / 1_000_000
  return { input, output, cacheRead, cacheWrite }
}

export interface ResolvedRate {
  rate: TokenRate
  source: 'custom' | 'estimated'
}

export type RateResolver = (provider: UsageProvider, model: string) => ResolvedRate | null

/**
 * Combines custom prices (checked first — they win over everything) with the
 * public rate table into one resolver for `priceModelGroup`.
 */
export function createRateResolver(customPrices: CustomModelPrice[], table: RateTable): RateResolver {
  const customByModel = new Map<string, TokenRate>()
  for (const price of customPrices) {
    const key = normalizeModelId(price.model).bare
    if (key) customByModel.set(key, customPriceToRate(price))
  }
  const lookup = createRateLookup(table)

  return (provider: UsageProvider, model: string): ResolvedRate | null => {
    const custom = customByModel.get(normalizeModelId(model).bare)
    if (custom) return { rate: custom, source: 'custom' }
    const rate = lookup(provider, model)
    return rate ? { rate, source: 'estimated' } : null
  }
}

// ── Pricing ──────────────────────────────────────────────────

/**
 * One (provider, model) group's token totals, pre-aggregated in SQL —
 * pricing runs per group, never per row. `reported*` covers rows whose
 * provider-reported cost is trustworthy; `unpriced*` covers the rest (no
 * reported cost, or a reported `0` alongside non-zero tokens — Pi/OpenCode
 * report that for subscription logins and it means "not reported", not free).
 */
export interface ModelUsageGroup {
  provider: UsageProvider
  model: string
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  records: number
  reportedCostUsd: number
  reportedRecords: number
  unpricedInputTokens: number
  unpricedCacheReadTokens: number
  unpricedCacheWriteTokens: number
  unpricedOutputTokens: number
  unpricedRecordsRaw: number
}

export interface PricedGroup {
  costUsd: number | null
  reportedCostUsd: number | null
  estimatedCostUsd: number | null
  unpricedRecords: number
  costSource: UsageCostEstimateSource
  cacheSavingsUsd: number | null
  /** Records counted toward `reportedCostUsd` (0 when a custom price overrides reported cost entirely). */
  reportedRecordCount: number
  /** Records counted toward `estimatedCostUsd` (custom-priced records count here too). */
  estimatedRecordCount: number
}

/**
 * Reasoning tokens are never priced separately: every provider already
 * folds them into `outputTokens` (see `src/main/usage/usage-normalize.ts`),
 * so pricing only ever reads `inputTokens` / `cacheReadTokens` /
 * `cacheWriteTokens` / `outputTokens` — `reasoningTokens` is informational.
 */
export function priceModelGroup(group: ModelUsageGroup, resolveRate: RateResolver): PricedGroup {
  const reportedCostUsd = group.reportedRecords > 0 ? group.reportedCostUsd : null
  const resolved = resolveRate(group.provider, group.model)

  if (!resolved) {
    const unpriced = group.unpricedRecordsRaw
    return {
      costUsd: reportedCostUsd,
      reportedCostUsd,
      estimatedCostUsd: null,
      unpricedRecords: unpriced,
      costSource: unpriced === 0 ? 'reported' : group.reportedRecords > 0 ? 'reported' : 'unpriced',
      cacheSavingsUsd: null,
      reportedRecordCount: group.reportedRecords,
      estimatedRecordCount: 0
    }
  }

  const { rate, source } = resolved
  const cacheSavingsUsd = group.cacheReadTokens * (rate.input - rate.cacheRead)

  if (source === 'custom') {
    const totalCost =
      group.inputTokens * rate.input +
      group.cacheReadTokens * rate.cacheRead +
      group.cacheWriteTokens * rate.cacheWrite +
      group.outputTokens * rate.output
    return {
      costUsd: totalCost,
      reportedCostUsd: null,
      estimatedCostUsd: totalCost,
      unpricedRecords: 0,
      costSource: 'custom',
      cacheSavingsUsd,
      reportedRecordCount: 0,
      estimatedRecordCount: group.records
    }
  }

  const hasEstimate = group.unpricedRecordsRaw > 0
  const estimatedPortion = hasEstimate
    ? group.unpricedInputTokens * rate.input +
      group.unpricedCacheReadTokens * rate.cacheRead +
      group.unpricedCacheWriteTokens * rate.cacheWrite +
      group.unpricedOutputTokens * rate.output
    : 0
  return {
    costUsd: (reportedCostUsd ?? 0) + estimatedPortion,
    reportedCostUsd,
    estimatedCostUsd: hasEstimate ? estimatedPortion : null,
    unpricedRecords: 0,
    costSource: hasEstimate ? 'estimated' : 'reported',
    cacheSavingsUsd,
    reportedRecordCount: group.reportedRecords,
    estimatedRecordCount: hasEstimate ? group.unpricedRecordsRaw : 0
  }
}

// ── Re-aggregation (totals / by-day / by-task reduce over priced groups) ────

export interface PricingAccumulator {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  records: number
  unpricedRecords: number
  reportedCostSum: number
  reportedRecordCount: number
  estimatedCostSum: number
  estimatedRecordCount: number
  cacheSavingsSum: number
  hasCacheSavings: boolean
}

export function newPricingAccumulator(): PricingAccumulator {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    records: 0,
    unpricedRecords: 0,
    reportedCostSum: 0,
    reportedRecordCount: 0,
    estimatedCostSum: 0,
    estimatedRecordCount: 0,
    cacheSavingsSum: 0,
    hasCacheSavings: false
  }
}

export function accumulatePricedGroup(acc: PricingAccumulator, group: ModelUsageGroup, priced: PricedGroup): void {
  acc.inputTokens += group.inputTokens
  acc.cacheReadTokens += group.cacheReadTokens
  acc.cacheWriteTokens += group.cacheWriteTokens
  acc.outputTokens += group.outputTokens
  acc.reasoningTokens += group.reasoningTokens
  acc.records += group.records
  acc.unpricedRecords += priced.unpricedRecords
  if (priced.reportedCostUsd !== null) {
    acc.reportedCostSum += priced.reportedCostUsd
    acc.reportedRecordCount += priced.reportedRecordCount
  }
  if (priced.estimatedCostUsd !== null) {
    acc.estimatedCostSum += priced.estimatedCostUsd
    acc.estimatedRecordCount += priced.estimatedRecordCount
  }
  if (priced.cacheSavingsUsd !== null) {
    acc.cacheSavingsSum += priced.cacheSavingsUsd
    acc.hasCacheSavings = true
  }
}

export interface FinalizedAggregate {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  records: number
  unpricedRecords: number
  costUsd: number | null
  reportedCostUsd: number | null
  estimatedCostUsd: number | null
  cacheSavingsUsd: number | null
}

export function finalizePricingAccumulator(acc: PricingAccumulator): FinalizedAggregate {
  const hasReported = acc.reportedRecordCount > 0
  const hasEstimated = acc.estimatedRecordCount > 0
  return {
    inputTokens: acc.inputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    outputTokens: acc.outputTokens,
    reasoningTokens: acc.reasoningTokens,
    records: acc.records,
    unpricedRecords: acc.unpricedRecords,
    reportedCostUsd: hasReported ? acc.reportedCostSum : null,
    estimatedCostUsd: hasEstimated ? acc.estimatedCostSum : null,
    costUsd: hasReported || hasEstimated ? acc.reportedCostSum + acc.estimatedCostSum : null,
    cacheSavingsUsd: acc.hasCacheSavings ? acc.cacheSavingsSum : null
  }
}
