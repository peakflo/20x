import { describe, it, expect } from 'vitest'
import {
  BUNDLED_FALLBACK_RATE_TABLE,
  accumulatePricedGroup,
  createRateLookup,
  createRateResolver,
  customPriceToRate,
  finalizePricingAccumulator,
  newPricingAccumulator,
  normalizeModelId,
  parseRateTable,
  priceModelGroup,
  type ModelUsageGroup,
  type RateResolver
} from './usage-pricing'
import type { CustomModelPrice } from '../../shared/usage'

/**
 * Real entries from the public rate table (litellm-shaped), frozen here as
 * fixtures so parsing/lookup tests never depend on the network. Picked to
 * exercise: missing cache rates (`gpt-5`), a published fast/priority tier
 * with its own cache rate (`azure/gpt-5.6`), a published ultrafast tier plus
 * ignored tiered/flex/batch variants (`gpt-6-astra`), the Claude
 * `provider_specific_entry.fast` multiplier (`claude-opus-4-8`), a model with
 * no fast tier at all (`claude-opus-4-7`), and the schema-documentation
 * `sample_spec` entry that must be skipped.
 */
const RAW_FIXTURE = {
  sample_spec: { fields: { ignored: true } },
  'claude-opus-4-7': {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    litellm_provider: 'anthropic',
    provider_specific_entry: { us: 1.1 }
  },
  'claude-opus-4-8': {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    litellm_provider: 'anthropic',
    provider_specific_entry: { us: 1.1, fast: 2.0 }
  },
  'gpt-5': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-7,
    input_cost_per_token_priority: 2.5e-6,
    output_cost_per_token_priority: 2e-5,
    cache_read_input_token_cost_priority: 2.5e-7,
    litellm_provider: 'openai'
    // No cache_creation_input_token_cost field at all — must fall back to input.
  },
  'azure/gpt-5.6': {
    input_cost_per_token: 4e-6,
    output_cost_per_token: 2e-5,
    cache_read_input_token_cost: 4e-7,
    cache_creation_input_token_cost: 5e-6,
    input_cost_per_token_priority: 8e-6,
    output_cost_per_token_priority: 4e-5,
    cache_read_input_token_cost_priority: 8e-7,
    cache_creation_input_token_cost_priority: 1e-5,
    input_cost_per_token_above_272k_tokens_priority: 1.6e-5,
    litellm_provider: 'azure'
  },
  'gpt-6-astra': {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
    cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 1.25e-5,
    input_cost_per_token_ultrafast: 6e-5,
    output_cost_per_token_ultrafast: 3e-4,
    cache_read_input_token_cost_ultrafast: 6e-6,
    cache_creation_input_token_cost_ultrafast: 7.5e-5,
    // Tiered-by-context, flex and batch variants — must never affect the parsed rates.
    input_cost_per_token_above_272k_tokens: 2e-5,
    input_cost_per_token_above_272k_tokens_ultrafast: 1.2e-4,
    input_cost_per_token_flex: 5e-6,
    input_cost_per_token_batches: 5e-6,
    litellm_provider: 'openai'
  },
  'claude-sonnet-4-5': {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    litellm_provider: 'anthropic'
  },
  // An embedding-style entry with no token-based chat pricing — must be skipped.
  'text-embedding-3-large': {
    input_cost_per_token: 1.3e-7,
    litellm_provider: 'openai',
    mode: 'embedding'
  }
}

describe('parseRateTable', () => {
  const table = parseRateTable(RAW_FIXTURE)

  it('skips the sample_spec schema-documentation entry', () => {
    expect(table.sample_spec).toBeUndefined()
  })

  it('skips entries with no usable standard input/output rate', () => {
    expect(table['text-embedding-3-large']).toBeUndefined()
  })

  it('parses standard rates', () => {
    expect(table['claude-sonnet-4-5'].standard).toEqual({ input: 3e-6, output: 1.5e-5, cacheRead: 3e-7, cacheWrite: 3.75e-6 })
  })

  it('falls back cache rates to the input rate when missing — never free by omission', () => {
    expect(table['gpt-5'].standard).toEqual({ input: 1.25e-6, output: 1e-5, cacheRead: 1.25e-7, cacheWrite: 1.25e-6 })
  })

  it('parses a published priority (fast) tier, including its own cache rate', () => {
    expect(table['azure/gpt-5.6'].fast).toEqual({ input: 8e-6, output: 4e-5, cacheRead: 8e-7, cacheWrite: 1e-5 })
  })

  it('parses a published ultrafast tier and ignores above-threshold/flex/batch variants', () => {
    const entry = table['gpt-6-astra']
    expect(entry.standard).toEqual({ input: 1e-5, output: 5e-5, cacheRead: 1e-6, cacheWrite: 1.25e-5 })
    expect(entry.ultrafast).toEqual({ input: 6e-5, output: 3e-4, cacheRead: 6e-6, cacheWrite: 7.5e-5 })
  })

  it('derives the fast tier from provider_specific_entry.fast when no priority fields are published (Claude)', () => {
    expect(table['claude-opus-4-8'].fast).toEqual({ input: 1e-5, output: 5e-5, cacheRead: 1e-6, cacheWrite: 1.25e-5 })
  })

  it('leaves no fast tier when neither priority fields nor a fast multiplier are published', () => {
    expect(table['claude-opus-4-7'].fast).toBeUndefined()
  })

  it('lowercases model keys', () => {
    expect(Object.keys(table)).toContain('claude-sonnet-4-5')
    expect(Object.keys(table)).not.toContain('Claude-Sonnet-4-5')
  })
})

describe('normalizeModelId', () => {
  it('lowercases', () => {
    expect(normalizeModelId('Claude-Opus-4-7')).toEqual({ providerQualified: 'claude-opus-4-7', bare: 'claude-opus-4-7' })
  })

  it('strips a provider prefix for the bare id but keeps it for the provider-qualified id', () => {
    expect(normalizeModelId('openai/gpt-5')).toEqual({ providerQualified: 'openai/gpt-5', bare: 'gpt-5' })
    expect(normalizeModelId('anthropic/claude-sonnet-4-5')).toEqual({ providerQualified: 'anthropic/claude-sonnet-4-5', bare: 'claude-sonnet-4-5' })
  })

  it('strips a trailing date suffix', () => {
    expect(normalizeModelId('claude-sonnet-4-5-20250929').bare).toBe('claude-sonnet-4-5')
    expect(normalizeModelId('claude-sonnet-4-5-2025-09-29').bare).toBe('claude-sonnet-4-5')
  })

  it('strips [1m]-style variant markers', () => {
    expect(normalizeModelId('gpt-5-codex[1m]').bare).toBe('gpt-5-codex')
    expect(normalizeModelId('openai/gpt-5-codex [1m]').bare).toBe('gpt-5-codex')
  })

  it('handles an empty/garbage id without throwing', () => {
    expect(normalizeModelId('').bare).toBe('')
    expect(normalizeModelId('   ').bare).toBe('')
  })
})

describe('createRateLookup — real model ids 20x stores', () => {
  const lookup = createRateLookup(parseRateTable(RAW_FIXTURE))

  it('Claude Code: bare dated/undated ids', () => {
    expect(lookup('claude-code', 'claude-opus-4-7')).toEqual({ input: 5e-6, output: 2.5e-5, cacheRead: 5e-7, cacheWrite: 6.25e-6 })
  })

  it('Codex: bare id', () => {
    expect(lookup('codex', 'gpt-5')).toEqual({ input: 1.25e-6, output: 1e-5, cacheRead: 1.25e-7, cacheWrite: 1.25e-6 })
  })

  it('OpenCode: provider/model form resolves via the bare name', () => {
    expect(lookup('opencode', 'anthropic/claude-sonnet-4-5')).toEqual({ input: 3e-6, output: 1.5e-5, cacheRead: 3e-7, cacheWrite: 3.75e-6 })
  })

  it('Pi: provider/model form resolves via the bare name', () => {
    expect(lookup('pi', 'openai/gpt-5')).toEqual({ input: 1.25e-6, output: 1e-5, cacheRead: 1.25e-7, cacheWrite: 1.25e-6 })
  })

  it('Cursor: bare id', () => {
    expect(lookup('cursor', 'gpt-5')).not.toBeNull()
  })

  it('tries the provider-qualified key before the bare name', () => {
    // "azure/gpt-5.6" is itself a published key — the bare "gpt-5.6" is not.
    expect(lookup('cursor', 'azure/gpt-5.6')).toEqual({ input: 4e-6, output: 2e-5, cacheRead: 4e-7, cacheWrite: 5e-6 })
  })

  it('returns null for an unknown model', () => {
    expect(lookup('codex', 'totally-unknown-model-xyz')).toBeNull()
  })

  it('returns the fast/ultrafast tier only when asked for it', () => {
    const table = parseRateTable(RAW_FIXTURE)
    const l = createRateLookup(table)
    expect(l('openai', 'gpt-6-astra', 'standard')).toEqual({ input: 1e-5, output: 5e-5, cacheRead: 1e-6, cacheWrite: 1.25e-5 })
    expect(l('openai', 'gpt-6-astra', 'ultrafast')).toEqual({ input: 6e-5, output: 3e-4, cacheRead: 6e-6, cacheWrite: 7.5e-5 })
    // No fast tier published for this model — falls back to standard.
    expect(l('openai', 'gpt-6-astra', 'fast')).toEqual({ input: 1e-5, output: 5e-5, cacheRead: 1e-6, cacheWrite: 1.25e-5 })
  })
})

describe('customPriceToRate', () => {
  it('converts USD per million tokens to USD per token', () => {
    expect(customPriceToRate({ model: 'm', inputPerMTok: 3, outputPerMTok: 15 })).toEqual({
      input: 3e-6, output: 1.5e-5, cacheRead: 3e-6, cacheWrite: 3e-6
    })
  })

  it('falls back cache rates to the input rate when left blank (undefined), but 0 means free', () => {
    const blank = customPriceToRate({ model: 'm', inputPerMTok: 2, outputPerMTok: 10 })
    expect(blank.cacheRead).toBe(2e-6)
    expect(blank.cacheWrite).toBe(2e-6)

    const free = customPriceToRate({ model: 'm', inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0, cacheWritePerMTok: 0 })
    expect(free.cacheRead).toBe(0)
    expect(free.cacheWrite).toBe(0)
  })
})

describe('createRateResolver — precedence', () => {
  const table = parseRateTable(RAW_FIXTURE)

  it('a custom price wins over the public rate table', () => {
    const customPrices: CustomModelPrice[] = [{ model: 'gpt-5', inputPerMTok: 100, outputPerMTok: 200 }]
    const resolver = createRateResolver(customPrices, table)
    const resolved = resolver('codex', 'gpt-5')
    expect(resolved?.source).toBe('custom')
    expect(resolved?.rate.input).toBeCloseTo(100e-6)
  })

  it('falls back to the public rate table when no custom price is set', () => {
    const resolver = createRateResolver([], table)
    expect(resolver('codex', 'gpt-5')?.source).toBe('estimated')
  })

  it('returns null when neither a custom price nor a public rate is known', () => {
    const resolver = createRateResolver([], table)
    expect(resolver('codex', 'never-heard-of-this-model')).toBeNull()
  })

  it('matches a custom price across providers using the same normalised model id', () => {
    const customPrices: CustomModelPrice[] = [{ model: 'my-model', inputPerMTok: 1, outputPerMTok: 2 }]
    const resolver = createRateResolver(customPrices, table)
    expect(resolver('opencode', 'someprovider/my-model')?.source).toBe('custom')
    expect(resolver('pi', 'MY-MODEL')?.source).toBe('custom')
  })
})

// ── priceModelGroup ──────────────────────────────────────────

function group(partial: Partial<ModelUsageGroup> = {}): ModelUsageGroup {
  return {
    provider: 'codex',
    model: 'gpt-5',
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    records: 1,
    reportedCostUsd: 0,
    reportedRecords: 0,
    unpricedInputTokens: 0,
    unpricedCacheReadTokens: 0,
    unpricedCacheWriteTokens: 0,
    unpricedOutputTokens: 0,
    unpricedRecordsRaw: 0,
    ...partial
  }
}

const RATE = { input: 1e-6, output: 2e-6, cacheRead: 2e-7, cacheWrite: 4e-7 }
const ESTIMATED: RateResolver = () => ({ rate: RATE, source: 'estimated' })
const CUSTOM: RateResolver = () => ({ rate: RATE, source: 'custom' })
const NONE: RateResolver = () => null

describe('priceModelGroup', () => {
  it('a fully reported group is priced from the reported sum, with no estimate', () => {
    const g = group({ records: 2, reportedRecords: 2, reportedCostUsd: 1.5, unpricedRecordsRaw: 0 })
    const priced = priceModelGroup(g, ESTIMATED)
    expect(priced).toMatchObject({ costUsd: 1.5, reportedCostUsd: 1.5, estimatedCostUsd: null, unpricedRecords: 0, costSource: 'reported' })
  })

  it('a fully unreported group with a known rate is priced entirely from the estimate', () => {
    const g = group({
      records: 1,
      reportedRecords: 0,
      unpricedRecordsRaw: 1,
      unpricedInputTokens: 1_000_000,
      unpricedCacheReadTokens: 500_000,
      unpricedCacheWriteTokens: 100_000,
      unpricedOutputTokens: 200_000
    })
    const priced = priceModelGroup(g, ESTIMATED)
    const expected = 1_000_000 * RATE.input + 500_000 * RATE.cacheRead + 100_000 * RATE.cacheWrite + 200_000 * RATE.output
    expect(priced.costUsd).toBeCloseTo(expected)
    expect(priced.reportedCostUsd).toBeNull()
    expect(priced.estimatedCostUsd).toBeCloseTo(expected)
    expect(priced.unpricedRecords).toBe(0)
    expect(priced.costSource).toBe('estimated')
  })

  it('a mixed group sums the reported portion and the estimated portion', () => {
    const g = group({
      records: 2,
      reportedRecords: 1,
      reportedCostUsd: 0.5,
      unpricedRecordsRaw: 1,
      unpricedInputTokens: 1_000_000,
      unpricedOutputTokens: 0
    })
    const priced = priceModelGroup(g, ESTIMATED)
    expect(priced.reportedCostUsd).toBe(0.5)
    expect(priced.estimatedCostUsd).toBeCloseTo(1_000_000 * RATE.input)
    expect(priced.costUsd).toBeCloseTo(0.5 + 1_000_000 * RATE.input)
    expect(priced.costSource).toBe('estimated')
  })

  it('an unknown model with a reported portion stays partially unpriced, not fully unpriced', () => {
    const g = group({ records: 2, reportedRecords: 1, reportedCostUsd: 0.5, unpricedRecordsRaw: 1 })
    const priced = priceModelGroup(g, NONE)
    expect(priced.costUsd).toBe(0.5)
    expect(priced.reportedCostUsd).toBe(0.5)
    expect(priced.estimatedCostUsd).toBeNull()
    expect(priced.unpricedRecords).toBe(1)
    expect(priced.costSource).toBe('reported')
  })

  it('an unknown model with nothing reported is fully unpriced', () => {
    const g = group({ records: 1, reportedRecords: 0, unpricedRecordsRaw: 1 })
    const priced = priceModelGroup(g, NONE)
    expect(priced.costUsd).toBeNull()
    expect(priced.reportedCostUsd).toBeNull()
    expect(priced.estimatedCostUsd).toBeNull()
    expect(priced.unpricedRecords).toBe(1)
    expect(priced.costSource).toBe('unpriced')
  })

  it('a custom price overrides even a fully reported group entirely', () => {
    const g = group({
      records: 2,
      reportedRecords: 2,
      reportedCostUsd: 999, // what the provider reported — must be ignored
      inputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0
    })
    const priced = priceModelGroup(g, CUSTOM)
    expect(priced.reportedCostUsd).toBeNull()
    expect(priced.costSource).toBe('custom')
    expect(priced.costUsd).toBeCloseTo(1_000_000 * RATE.input)
    expect(priced.estimatedCostUsd).toBeCloseTo(1_000_000 * RATE.input)
    expect(priced.estimatedRecordCount).toBe(2)
    expect(priced.reportedRecordCount).toBe(0)
  })

  it('zero reported cost alongside non-zero tokens is treated as "not reported" and estimated instead', () => {
    // Pi/OpenCode report cost: 0 for subscription logins — the SQL layer (and
    // usage-store tests) classify that row as "unpriced", not "reported $0".
    // priceModelGroup only ever sees the already-classified sums, so this is
    // exercised end-to-end in usage-store.test.ts; here we just confirm a
    // group with reportedRecords: 0 (what that classification produces) is
    // priced from the estimate, not left at $0.
    const g = group({
      records: 1,
      reportedRecords: 0,
      reportedCostUsd: 0,
      unpricedRecordsRaw: 1,
      unpricedInputTokens: 1_000_000
    })
    const priced = priceModelGroup(g, ESTIMATED)
    expect(priced.costUsd).toBeCloseTo(1_000_000 * RATE.input)
    expect(priced.costSource).toBe('estimated')
  })

  it('reasoning tokens are never charged separately — only input/cacheRead/cacheWrite/output feed the price', () => {
    const base = group({
      records: 1, reportedRecords: 0, unpricedRecordsRaw: 1,
      unpricedOutputTokens: 100_000, reasoningTokens: 0
    })
    const withReasoning = group({
      records: 1, reportedRecords: 0, unpricedRecordsRaw: 1,
      unpricedOutputTokens: 100_000, reasoningTokens: 90_000 // already counted inside outputTokens upstream
    })
    expect(priceModelGroup(base, ESTIMATED).costUsd).toBeCloseTo(priceModelGroup(withReasoning, ESTIMATED).costUsd!)
  })

  it('computes cache savings as cacheReadTokens × (input rate − cache-read rate)', () => {
    const g = group({ records: 1, reportedRecords: 1, reportedCostUsd: 1, cacheReadTokens: 1_000_000 })
    const priced = priceModelGroup(g, ESTIMATED)
    expect(priced.cacheSavingsUsd).toBeCloseTo(1_000_000 * (RATE.input - RATE.cacheRead))
  })

  it('cache savings is null when nothing is priced', () => {
    const g = group({ records: 1, reportedRecords: 0, unpricedRecordsRaw: 1, cacheReadTokens: 1_000_000 })
    expect(priceModelGroup(g, NONE).cacheSavingsUsd).toBeNull()
  })
})

describe('pricing accumulator (re-aggregation across groups)', () => {
  it('sums reported and estimated separately and nulls out a bucket nothing contributed to', () => {
    const acc = newPricingAccumulator()
    const reportedGroup = group({ records: 1, reportedRecords: 1, reportedCostUsd: 2, inputTokens: 10 })
    accumulatePricedGroup(acc, reportedGroup, priceModelGroup(reportedGroup, NONE))
    const estimatedGroup = group({
      model: 'gpt-6-astra', records: 1, reportedRecords: 0, unpricedRecordsRaw: 1, unpricedInputTokens: 1_000_000, inputTokens: 1_000_000
    })
    accumulatePricedGroup(acc, estimatedGroup, priceModelGroup(estimatedGroup, ESTIMATED))

    const result = finalizePricingAccumulator(acc)
    expect(result.reportedCostUsd).toBe(2)
    expect(result.estimatedCostUsd).toBeCloseTo(1_000_000 * RATE.input)
    expect(result.costUsd).toBeCloseTo(2 + 1_000_000 * RATE.input)
    expect(result.records).toBe(2)
    expect(result.inputTokens).toBe(1_000_010)
  })

  it('costUsd is null only when nothing in the accumulator is priced at all', () => {
    const acc = newPricingAccumulator()
    const g = group({ records: 1, reportedRecords: 0, unpricedRecordsRaw: 1 })
    accumulatePricedGroup(acc, g, priceModelGroup(g, NONE))
    const result = finalizePricingAccumulator(acc)
    expect(result.costUsd).toBeNull()
    expect(result.unpricedRecords).toBe(1)
  })
})

describe('BUNDLED_FALLBACK_RATE_TABLE', () => {
  const lookup = createRateLookup(BUNDLED_FALLBACK_RATE_TABLE)

  it('prices the common Claude, GPT/Codex and Gemini families out of the box', () => {
    for (const model of ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5', 'gpt-5', 'gpt-5-codex', 'gpt-4o', 'gemini-2.5-pro', 'gemini-2.5-flash']) {
      expect(lookup('claude-code', model), model).not.toBeNull()
    }
  })

  it('resolves provider-qualified ids used by OpenCode and Pi against the fallback', () => {
    expect(lookup('opencode', 'anthropic/claude-sonnet-4-5')).not.toBeNull()
    expect(lookup('pi', 'openai/gpt-5-codex')).not.toBeNull()
  })
})
