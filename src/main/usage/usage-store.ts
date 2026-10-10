/**
 * SQLite persistence for subscription usage tracking.
 *
 * Tables (all created with IF NOT EXISTS, so no schema-version bump is needed):
 *
 * - `token_usage_events`        append-only usage: one row per model per turn for providers
 *                               that report running totals, one row per message/turn for
 *                               providers that report discrete usage (deduped by
 *                               `source_key`). No FK to tasks: history outlives deleted tasks.
 * - `token_usage_session_totals` last cumulative totals seen per provider session +
 *                               bucket, used to turn cumulative provider figures into
 *                               per-turn deltas (survives app restarts / session resume).
 * - `provider_usage_limits`     latest plan-limit snapshot per harness instance (provider + instance_id).
 */

import type Database from 'better-sqlite3'
import { createId } from '@paralleldrive/cuid2'
import type {
  ProviderUsageLimits,
  TokenUsageRecord,
  UsageAggregate,
  UsageDayRow,
  UsageModelRow,
  UsageProvider,
  UsageSummary,
  UsageSummaryQuery,
  UsageTaskRow
} from '../../shared/usage'
import { isUsageProvider } from '../../shared/usage'
import { defaultHarnessInstanceId } from '../../shared/harness-instances'
import type { UsageBucket, UsageTotals } from './usage-normalize'
import { computeUsageDelta, isEmptyUsage } from './usage-normalize'
import {
  accumulatePricedGroup,
  finalizePricingAccumulator,
  newPricingAccumulator,
  priceModelGroup,
  type ModelUsageGroup,
  type RateResolver
} from './usage-pricing'

/** Used when a caller does not pass a resolver (e.g. old call sites, tests that only care about reported cost). */
const NO_RATE_RESOLVER: RateResolver = () => null

export const USAGE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS token_usage_events (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    agent_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    session_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    cost_source TEXT NOT NULL DEFAULT 'unavailable',
    created_at INTEGER NOT NULL,
    -- Provider-side id of a discrete usage item (e.g. an assistant message id)
    -- for providers that report usage per message instead of running totals.
    -- Unique per provider so replays and repeated updates never double count.
    source_key TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_token_usage_events_created ON token_usage_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_token_usage_events_task ON token_usage_events(task_id, created_at);

  CREATE TABLE IF NOT EXISTS token_usage_session_totals (
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    bucket TEXT NOT NULL,
    totals TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, session_id, bucket)
  );

  CREATE TABLE IF NOT EXISTS provider_usage_limits (
    provider TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, instance_id)
  );
`

/** Session totals untouched for this long are pruned (sessions are long dead by then). */
const SESSION_TOTALS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
/** Raw usage events are kept for a year. */
const USAGE_EVENTS_RETENTION_MS = 365 * 24 * 60 * 60 * 1000
const DEFAULT_SUMMARY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const TOP_TASKS_LIMIT = 10

/** One discrete usage item (per-message providers: OpenCode, Pi, Cursor turns). */
export interface DiscreteUsageItem {
  /** Stable provider-side id, unique per provider (e.g. `${sessionId}:${messageId}`). */
  sourceKey: string
  model: string
  usage: UsageTotals
  /** Unix ms the usage happened (e.g. message completion); defaults to now. */
  occurredAt?: number
}

export interface RecordDiscreteUsageInput {
  provider: UsageProvider
  sessionId?: string | null
  taskId?: string | null
  agentId?: string | null
  /** Harness instance that produced the usage. Defaults to the provider's default instance. */
  instanceId?: string | null
  items: DiscreteUsageItem[]
}

export interface RecordCumulativeUsageInput {
  provider: UsageProvider
  /** Provider session / thread id. Required: deltas are computed per session. */
  sessionId: string
  taskId?: string | null
  agentId?: string | null
  /** Harness instance that produced the usage. Defaults to the provider's default instance. */
  instanceId?: string | null
  /**
   * Whether the whole session was observed by this app. When false and no
   * baseline exists for a bucket, the reading only becomes the baseline
   * (never over-count history that predates tracking).
   */
  newSession: boolean
  buckets: UsageBucket[]
  /** Unix ms; defaults to now. */
  observedAt?: number
}

interface UsageEventRow {
  instance_id: string | null
  id: string
  task_id: string | null
  agent_id: string | null
  provider: string
  model: string
  session_id: string | null
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cost_usd: number | null
  cost_source: string
  created_at: number
}

/**
 * A row's provider-reported cost is only trustworthy when it is non-null and
 * not a reported `0` alongside non-zero tokens — Pi and OpenCode report `0`
 * for subscription logins, which means "not reported", not free (see
 * `priceModelGroup` in `usage-pricing.ts`).
 */
const TRUSTWORTHY_REPORTED_SQL =
  '(cost_usd IS NOT NULL AND NOT (cost_usd = 0 AND (input_tokens + cache_read_tokens + cache_write_tokens + output_tokens) > 0))'

/**
 * Per-(provider, model) token + cost totals, split into the "trustworthy
 * reported" bucket and the "needs pricing" bucket. Grouping and summing all
 * happen here in SQL; `usage-pricing.ts` prices each resulting group (at most
 * a few dozen rows), never per raw event row.
 */
const GROUP_PRICING_COLUMNS = `
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
  COUNT(*) AS records,
  COALESCE(SUM(CASE WHEN ${TRUSTWORTHY_REPORTED_SQL} THEN cost_usd ELSE 0 END), 0) AS reported_cost_usd,
  COALESCE(SUM(CASE WHEN ${TRUSTWORTHY_REPORTED_SQL} THEN 1 ELSE 0 END), 0) AS reported_records,
  COALESCE(SUM(CASE WHEN NOT (${TRUSTWORTHY_REPORTED_SQL}) THEN input_tokens ELSE 0 END), 0) AS unpriced_input_tokens,
  COALESCE(SUM(CASE WHEN NOT (${TRUSTWORTHY_REPORTED_SQL}) THEN cache_read_tokens ELSE 0 END), 0) AS unpriced_cache_read_tokens,
  COALESCE(SUM(CASE WHEN NOT (${TRUSTWORTHY_REPORTED_SQL}) THEN cache_write_tokens ELSE 0 END), 0) AS unpriced_cache_write_tokens,
  COALESCE(SUM(CASE WHEN NOT (${TRUSTWORTHY_REPORTED_SQL}) THEN output_tokens ELSE 0 END), 0) AS unpriced_output_tokens,
  COALESCE(SUM(CASE WHEN NOT (${TRUSTWORTHY_REPORTED_SQL}) THEN 1 ELSE 0 END), 0) AS unpriced_records_raw
`

interface ModelGroupSqlRow {
  provider: string
  model: string
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
  records: number
  reported_cost_usd: number
  reported_records: number
  unpriced_input_tokens: number
  unpriced_cache_read_tokens: number
  unpriced_cache_write_tokens: number
  unpriced_output_tokens: number
  unpriced_records_raw: number
}

function toModelUsageGroup(row: ModelGroupSqlRow): ModelUsageGroup {
  return {
    provider: row.provider as UsageProvider,
    model: row.model,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    records: row.records,
    reportedCostUsd: row.reported_cost_usd,
    reportedRecords: row.reported_records,
    unpricedInputTokens: row.unpriced_input_tokens,
    unpricedCacheReadTokens: row.unpriced_cache_read_tokens,
    unpricedCacheWriteTokens: row.unpriced_cache_write_tokens,
    unpricedOutputTokens: row.unpriced_output_tokens,
    unpricedRecordsRaw: row.unpriced_records_raw
  }
}

/** Total tokens processed by a group — used to rank `byModel` the same way the old single-dimension query did. */
function groupTotalTokens(group: ModelUsageGroup): number {
  return group.inputTokens + group.cacheReadTokens + group.cacheWriteTokens + group.outputTokens
}

function toRecord(row: UsageEventRow): TokenUsageRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    provider: row.provider as UsageProvider,
    model: row.model,
    sessionId: row.session_id,
    instanceId: row.instance_id,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    costUsd: row.cost_usd,
    costSource: row.cost_source === 'reported' ? 'reported' : 'unavailable',
    createdAt: row.created_at
  }
}

function parseTotals(raw: string): UsageTotals | null {
  try {
    const value = JSON.parse(raw) as Partial<UsageTotals>
    return {
      inputTokens: Number(value.inputTokens) || 0,
      cacheReadTokens: Number(value.cacheReadTokens) || 0,
      cacheWriteTokens: Number(value.cacheWriteTokens) || 0,
      outputTokens: Number(value.outputTokens) || 0,
      reasoningTokens: Number(value.reasoningTokens) || 0,
      costUsd: typeof value.costUsd === 'number' ? value.costUsd : null
    }
  } catch {
    return null
  }
}

export class UsageStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(USAGE_SCHEMA_SQL)
    this.ensureSourceKeyColumn()
    this.ensureInstanceSchema()
  }

  /**
   * Brings databases created before harness instances up to date: usage events
   * get an `instance_id` column, and plan limits move from one row per provider
   * to one row per (provider, instance). Legacy rows belong to the default
   * instance of their provider.
   */
  private ensureInstanceSchema(): void {
    const eventColumns = this.db.prepare('PRAGMA table_info(token_usage_events)').all() as Array<{ name: string }>
    if (!eventColumns.some((column) => column.name === 'instance_id')) {
      this.db.exec('ALTER TABLE token_usage_events ADD COLUMN instance_id TEXT')
      this.db.exec(`UPDATE token_usage_events SET instance_id = 'default:' || provider WHERE instance_id IS NULL`)
    }

    const limitColumns = this.db.prepare('PRAGMA table_info(provider_usage_limits)').all() as Array<{ name: string }>
    if (!limitColumns.some((column) => column.name === 'instance_id')) {
      this.db.transaction(() => {
        this.db.exec('ALTER TABLE provider_usage_limits RENAME TO provider_usage_limits_legacy')
        this.db.exec(USAGE_SCHEMA_SQL)
        this.db.exec(`
          INSERT INTO provider_usage_limits (provider, instance_id, snapshot, updated_at)
          SELECT provider, 'default:' || provider, snapshot, updated_at FROM provider_usage_limits_legacy
        `)
        this.db.exec('DROP TABLE provider_usage_limits_legacy')
      })()
    }
  }

  /** Adds `source_key` to tables created by an earlier build of this feature. */
  private ensureSourceKeyColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(token_usage_events)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'source_key')) {
      this.db.exec('ALTER TABLE token_usage_events ADD COLUMN source_key TEXT')
    }
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_events_source ON token_usage_events(provider, source_key) WHERE source_key IS NOT NULL'
    )
  }

  /**
   * Records discrete usage items (one per assistant message / turn) for
   * providers that report per-item usage. Each `sourceKey` is stored at most
   * once per provider, so repeated events and history replays are ignored.
   *
   * @returns The usage events actually written.
   */
  recordDiscreteUsage(input: RecordDiscreteUsageInput): TokenUsageRecord[] {
    if (input.items.length === 0) return []
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO token_usage_events (
        id, task_id, agent_id, provider, model, session_id,
        input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
        cost_usd, cost_source, created_at, source_key, instance_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const instanceId = input.instanceId || defaultHarnessInstanceId(input.provider)
    const run = this.db.transaction((): TokenUsageRecord[] => {
      const written: TokenUsageRecord[] = []
      for (const item of input.items) {
        if (!item.sourceKey || isEmptyUsage(item.usage)) continue
        const costUsd = item.usage.costUsd !== null && Number.isFinite(item.usage.costUsd) ? item.usage.costUsd : null
        const record: TokenUsageRecord = {
          id: createId(),
          taskId: input.taskId ?? null,
          agentId: input.agentId ?? null,
          provider: input.provider,
          model: item.model || 'unknown',
          sessionId: input.sessionId ?? null,
          instanceId,
          inputTokens: Math.round(item.usage.inputTokens),
          cacheReadTokens: Math.round(item.usage.cacheReadTokens),
          cacheWriteTokens: Math.round(item.usage.cacheWriteTokens),
          outputTokens: Math.round(item.usage.outputTokens),
          reasoningTokens: Math.round(item.usage.reasoningTokens),
          costUsd,
          costSource: costUsd === null ? 'unavailable' : 'reported',
          createdAt: item.occurredAt ?? Date.now()
        }
        const result = insert.run(
          record.id, record.taskId, record.agentId, record.provider, record.model, record.sessionId,
          record.inputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.outputTokens, record.reasoningTokens,
          record.costUsd, record.costSource, record.createdAt, item.sourceKey, instanceId
        )
        if (result.changes > 0) written.push(record)
      }
      return written
    })
    return run()
  }

  /**
   * Records the latest *cumulative* usage of a provider session. For each bucket
   * the difference against the previously persisted totals is stored as a usage
   * event (when non-zero) and the new totals replace the old ones — atomically,
   * so a crash can never double-count a turn.
   *
   * @returns The usage events written (empty when nothing new was consumed).
   */
  recordCumulativeUsage(input: RecordCumulativeUsageInput): TokenUsageRecord[] {
    if (!input.sessionId || input.buckets.length === 0) return []
    const observedAt = input.observedAt ?? Date.now()

    const selectTotals = this.db.prepare(
      'SELECT bucket, totals FROM token_usage_session_totals WHERE provider = ? AND session_id = ?'
    )
    const upsertTotals = this.db.prepare(`
      INSERT INTO token_usage_session_totals (provider, session_id, bucket, totals, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, session_id, bucket) DO UPDATE SET totals = excluded.totals, updated_at = excluded.updated_at
    `)
    const insertEvent = this.db.prepare(`
      INSERT INTO token_usage_events (
        id, task_id, agent_id, provider, model, session_id,
        input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
        cost_usd, cost_source, created_at, instance_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const instanceId = input.instanceId || defaultHarnessInstanceId(input.provider)

    const run = this.db.transaction((): TokenUsageRecord[] => {
      const previousByBucket = new Map<string, UsageTotals>()
      for (const row of selectTotals.all(input.provider, input.sessionId) as Array<{ bucket: string; totals: string }>) {
        const totals = parseTotals(row.totals)
        if (totals) previousByBucket.set(row.bucket, totals)
      }

      const written: TokenUsageRecord[] = []
      for (const bucket of input.buckets) {
        // Zeroed totals come from crashed/startup-error results. Persisting them
        // would make the next real reading look like a reset and double-count.
        if (isEmptyUsage(bucket.totals)) continue

        const previous = previousByBucket.get(bucket.key)
        upsertTotals.run(input.provider, input.sessionId, bucket.key, JSON.stringify(bucket.totals), observedAt)
        // A session that was not created here and has no baseline yet: its
        // totals include history we never observed. Baseline only.
        if (!previous && !input.newSession && previousByBucket.size === 0) continue

        const { delta } = computeUsageDelta(previous, bucket.totals)
        if (isEmptyUsage(delta)) continue

        const record: TokenUsageRecord = {
          id: createId(),
          taskId: input.taskId ?? null,
          agentId: input.agentId ?? null,
          provider: input.provider,
          model: bucket.model,
          sessionId: input.sessionId,
          instanceId,
          inputTokens: Math.round(delta.inputTokens),
          cacheReadTokens: Math.round(delta.cacheReadTokens),
          cacheWriteTokens: Math.round(delta.cacheWriteTokens),
          outputTokens: Math.round(delta.outputTokens),
          reasoningTokens: Math.round(delta.reasoningTokens),
          costUsd: delta.costUsd,
          costSource: delta.costUsd === null ? 'unavailable' : 'reported',
          createdAt: observedAt
        }
        insertEvent.run(
          record.id, record.taskId, record.agentId, record.provider, record.model, record.sessionId,
          record.inputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.outputTokens, record.reasoningTokens,
          record.costUsd, record.costSource, record.createdAt, instanceId
        )
        written.push(record)
      }
      return written
    })

    return run()
  }

  getUsageEvents(query: { sinceMs?: number; untilMs?: number; taskId?: string; limit?: number } = {}): TokenUsageRecord[] {
    const until = query.untilMs ?? Date.now() + 1
    const since = query.sinceMs ?? until - DEFAULT_SUMMARY_WINDOW_MS
    const limit = Math.max(1, Math.min(query.limit ?? 500, 5000))
    const rows = query.taskId
      ? this.db.prepare(
        'SELECT * FROM token_usage_events WHERE task_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?'
      ).all(query.taskId, since, until, limit)
      : this.db.prepare(
        'SELECT * FROM token_usage_events WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?'
      ).all(since, until, limit)
    return (rows as UsageEventRow[]).map(toRecord)
  }

  /**
   * Pricing (public rate table + custom prices) is resolved per (provider,
   * model) group, not per raw row — `resolveRate` defaults to "nothing is
   * priced" so callers that only care about reported cost (and existing
   * tests) see the old behaviour unchanged.
   */
  getUsageSummary(query: UsageSummaryQuery = {}, resolveRate: RateResolver = NO_RATE_RESOLVER): UsageSummary {
    const untilMs = query.untilMs ?? Date.now() + 1
    const sinceMs = query.sinceMs ?? untilMs - DEFAULT_SUMMARY_WINDOW_MS
    const offsetMinutes = Number.isFinite(query.utcOffsetMinutes)
      ? Math.round(query.utcOffsetMinutes as number)
      : -new Date().getTimezoneOffset()
    const offsetSeconds = offsetMinutes * 60

    const buildWhere = (alias = '', extra: string[] = []): string => {
      const col = (name: string): string => (alias ? `${alias}.${name}` : name)
      const clauses = [`${col('created_at')} >= @since`, `${col('created_at')} < @until`, ...extra]
      if (query.taskId) clauses.push(`${col('task_id')} = @taskId`)
      return `WHERE ${clauses.join(' AND ')}`
    }
    const where = buildWhere()
    const params = { since: sinceMs, until: untilMs, taskId: query.taskId ?? null, offset: offsetSeconds }

    // One SQL-aggregated group per (provider, model) — pricing below runs
    // over these groups (at most a few dozen), never over raw rows.
    const modelGroups = (this.db.prepare(
      `SELECT provider, model, ${GROUP_PRICING_COLUMNS} FROM token_usage_events ${where} GROUP BY provider, model`
    ).all(params) as ModelGroupSqlRow[])
      .filter((row) => isUsageProvider(row.provider))
      .map(toModelUsageGroup)
    const pricedModelGroups = modelGroups.map((group) => ({ group, priced: priceModelGroup(group, resolveRate) }))

    const totalsAcc = newPricingAccumulator()
    for (const { group, priced } of pricedModelGroups) accumulatePricedGroup(totalsAcc, group, priced)
    const totals: UsageAggregate = finalizePricingAccumulator(totalsAcc)

    const byProviderAcc = new Map<UsageProvider, ReturnType<typeof newPricingAccumulator>>()
    for (const { group, priced } of pricedModelGroups) {
      const acc = byProviderAcc.get(group.provider) ?? newPricingAccumulator()
      accumulatePricedGroup(acc, group, priced)
      byProviderAcc.set(group.provider, acc)
    }
    const byProvider = Array.from(byProviderAcc.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, acc]) => ({ provider, ...finalizePricingAccumulator(acc) }))

    const byModel: UsageModelRow[] = pricedModelGroups
      .sort((a, b) => groupTotalTokens(b.group) - groupTotalTokens(a.group))
      .map(({ group, priced }) => ({
        provider: group.provider,
        model: group.model,
        inputTokens: group.inputTokens,
        cacheReadTokens: group.cacheReadTokens,
        cacheWriteTokens: group.cacheWriteTokens,
        outputTokens: group.outputTokens,
        reasoningTokens: group.reasoningTokens,
        records: group.records,
        unpricedRecords: priced.unpricedRecords,
        costUsd: priced.costUsd,
        reportedCostUsd: priced.reportedCostUsd,
        estimatedCostUsd: priced.estimatedCostUsd,
        cacheSavingsUsd: priced.cacheSavingsUsd,
        costSource: priced.costSource
      }))

    const dayGroupRows = (this.db.prepare(
      `SELECT date(created_at / 1000 + @offset, 'unixepoch') AS day, provider, model, ${GROUP_PRICING_COLUMNS}
       FROM token_usage_events ${where}
       GROUP BY day, provider, model
       ORDER BY day`
    ).all(params) as Array<ModelGroupSqlRow & { day: string }>).filter((row) => isUsageProvider(row.provider))
    const byDayAcc = new Map<string, ReturnType<typeof newPricingAccumulator>>()
    // Token totals only (no pricing) per (day, provider) — the stacked
    // tokens-per-day chart's bar segments. Built from the same already-
    // grouped `dayGroupRows` as `byDay` itself, so this needs no second SQL
    // query; only token counts are needed here (not cost), since the chart's
    // tooltip shows cost once for the day's total, not per provider.
    const byDayProviderTokens = new Map<string, Map<UsageProvider, number>>()
    const dayOrder: string[] = []
    for (const row of dayGroupRows) {
      const group = toModelUsageGroup(row)
      const priced = priceModelGroup(group, resolveRate)
      if (!byDayAcc.has(row.day)) {
        byDayAcc.set(row.day, newPricingAccumulator())
        dayOrder.push(row.day)
      }
      accumulatePricedGroup(byDayAcc.get(row.day)!, group, priced)

      const providerTokens = byDayProviderTokens.get(row.day) ?? new Map<UsageProvider, number>()
      providerTokens.set(group.provider, (providerTokens.get(group.provider) ?? 0) + groupTotalTokens(group))
      byDayProviderTokens.set(row.day, providerTokens)
    }
    const byDay: UsageDayRow[] = dayOrder.map((day) => ({
      day,
      ...finalizePricingAccumulator(byDayAcc.get(day)!),
      byProvider: Array.from(byDayProviderTokens.get(day) ?? [])
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([provider, tokens]) => ({ provider, tokens }))
    }))

    const hasTasksTable = !!this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
    ).get()
    const taskWhere = buildWhere('e', ['e.task_id IS NOT NULL'])
    const taskOrderRows = this.db.prepare(
      `SELECT e.task_id AS task_id, ${hasTasksTable ? 't.title' : 'NULL'} AS title,
         (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(cache_read_tokens), 0) + COALESCE(SUM(cache_write_tokens), 0) + COALESCE(SUM(output_tokens), 0)) AS total_tokens
       FROM token_usage_events e ${hasTasksTable ? 'LEFT JOIN tasks t ON t.id = e.task_id' : ''}
       ${taskWhere}
       GROUP BY e.task_id
       ORDER BY total_tokens DESC
       LIMIT ${TOP_TASKS_LIMIT}`
    ).all(params) as Array<{ task_id: string; title: string | null }>

    let topTasks: UsageTaskRow[] = []
    if (taskOrderRows.length > 0) {
      const taskIds = taskOrderRows.map((row) => row.task_id)
      const placeholders = taskIds.map(() => '?').join(',')
      const taskGroupRows = (this.db.prepare(
        `SELECT task_id, provider, model, ${GROUP_PRICING_COLUMNS}
         FROM token_usage_events
         WHERE task_id IN (${placeholders}) AND created_at >= ? AND created_at < ?
         GROUP BY task_id, provider, model`
      ).all(...taskIds, sinceMs, untilMs) as Array<ModelGroupSqlRow & { task_id: string }>)
        .filter((row) => isUsageProvider(row.provider))

      const byTaskAcc = new Map<string, ReturnType<typeof newPricingAccumulator>>()
      for (const row of taskGroupRows) {
        const group = toModelUsageGroup(row)
        const priced = priceModelGroup(group, resolveRate)
        const acc = byTaskAcc.get(row.task_id) ?? newPricingAccumulator()
        accumulatePricedGroup(acc, group, priced)
        byTaskAcc.set(row.task_id, acc)
      }
      topTasks = taskOrderRows.map((row) => ({
        taskId: row.task_id,
        title: row.title ?? null,
        ...finalizePricingAccumulator(byTaskAcc.get(row.task_id) ?? newPricingAccumulator())
      }))
    }

    return { sinceMs, untilMs, totals, byProvider, byModel, byDay, topTasks }
  }

  getProviderUsageLimits(): ProviderUsageLimits[] {
    const rows = this.db.prepare(
      'SELECT provider, instance_id, snapshot FROM provider_usage_limits ORDER BY provider, instance_id'
    ).all() as Array<{ provider: string; instance_id: string; snapshot: string }>
    const result: ProviderUsageLimits[] = []
    for (const row of rows) {
      if (!isUsageProvider(row.provider)) continue
      try {
        const snapshot = JSON.parse(row.snapshot) as ProviderUsageLimits
        if (snapshot && Array.isArray(snapshot.windows)) {
          result.push({ ...snapshot, provider: row.provider, instanceId: row.instance_id })
        }
      } catch {
        // Corrupt row — ignore; the next probe overwrites it.
      }
    }
    return result
  }

  saveProviderUsageLimits(limits: ProviderUsageLimits): void {
    const instanceId = limits.instanceId || defaultHarnessInstanceId(limits.provider)
    this.db.prepare(`
      INSERT INTO provider_usage_limits (provider, instance_id, snapshot, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(provider, instance_id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at
    `).run(limits.provider, instanceId, JSON.stringify({ ...limits, instanceId }), Date.now())
  }

  /** Drops the plan-limit snapshot of a removed harness instance. */
  forgetInstance(instanceId: string): void {
    this.db.prepare('DELETE FROM provider_usage_limits WHERE instance_id = ?').run(instanceId)
  }

  /** Drops stale session totals and very old usage events. Safe to call at any time. */
  prune(nowMs = Date.now()): void {
    this.db.prepare('DELETE FROM token_usage_session_totals WHERE updated_at < ?').run(nowMs - SESSION_TOTALS_RETENTION_MS)
    this.db.prepare('DELETE FROM token_usage_events WHERE created_at < ?').run(nowMs - USAGE_EVENTS_RETENTION_MS)
  }

  /**
   * Latest usage event timestamp for a session after `afterMs`. Used by
   * agent-run-intervals.ts crash recovery as the preferred "last known
   * activity" signal (token_usage_events has a real `session_id` column,
   * unlike transcript_parts) before falling back to transcript activity.
   */
  getLatestEventAtForSession(sessionId: string, afterMs: number): number | null {
    const row = this.db.prepare(`
      SELECT MAX(created_at) AS m FROM token_usage_events WHERE session_id = ? AND created_at > ?
    `).get(sessionId, afterMs) as { m: number | null }
    return row.m ?? null
  }

  /**
   * Every usage event with a session id, oldest first — the backfill job's
   * primary source for deriving approximate historical run intervals (it has
   * real per-session granularity, unlike transcript_parts which is scoped to
   * task_id only). One row per (session_id, provider, model, turn); the
   * caller groups by session_id and merges consecutive activity.
   */
  getUsageEventActivityForBackfill(): Array<{
    sessionId: string
    taskId: string | null
    agentId: string | null
    provider: string
    instanceId: string | null
    createdAt: number
  }> {
    const rows = this.db.prepare(`
      SELECT session_id, task_id, agent_id, provider, instance_id, created_at
      FROM token_usage_events
      WHERE session_id IS NOT NULL
      ORDER BY session_id ASC, created_at ASC
    `).all() as Array<{ session_id: string; task_id: string | null; agent_id: string | null; provider: string; instance_id: string | null; created_at: number }>
    return rows.map((row) => ({
      sessionId: row.session_id,
      taskId: row.task_id,
      agentId: row.agent_id,
      provider: row.provider,
      instanceId: row.instance_id,
      createdAt: row.created_at
    }))
  }
}
