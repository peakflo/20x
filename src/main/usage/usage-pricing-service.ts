/**
 * Owns the live rate table: an in-memory copy backed by a disk cache (app
 * data), refreshed from the network at most once a day automatically, with a
 * 60s floor even on an explicit (`force`) refresh. Never blocks a caller on
 * the network — `getTable()` always returns the best table known so far
 * (live fetch > disk cache > the bundled fallback snapshot), and a failed
 * fetch just keeps using whatever was already loaded.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { BUNDLED_FALLBACK_RATE_TABLE, parseRateTable, type RateTable } from './usage-pricing'
import { fetchRateTableJson, RATE_TABLE_URL } from './usage-pricing-fetch'

export const RATE_TABLE_TTL_MS = 24 * 60 * 60 * 1000
export const RATE_TABLE_REFRESH_FLOOR_MS = 60 * 1000

interface RateTableCacheFile {
  fetchedAt: number
  table: RateTable
}

export interface RateTableRefreshResult {
  refreshed: boolean
  table: RateTable
  error?: string
}

export interface RateTableServiceOptions {
  /** Where the parsed table is cached on disk, e.g. `<userData>/usage/model-prices-cache.json`. */
  cacheFilePath: string
  /** Defaults to the real network fetch; tests inject a fake. */
  fetchJson?: (url: string) => Promise<unknown>
  now?: () => number
  url?: string
}

export class RateTableService {
  private table: RateTable
  // -Infinity (not 0) sentinels "never" — 0 is a real, if unlikely, epoch ms
  // value, and small test/boundary `now()` values near 0 must still be
  // treated as infinitely stale, not accidentally "just fetched".
  private fetchedAt = -Infinity
  private lastAttemptAt = -Infinity
  private refreshing: Promise<RateTableRefreshResult> | null = null
  private readonly cacheFilePath: string
  private readonly fetchJson: (url: string) => Promise<unknown>
  private readonly now: () => number
  private readonly url: string

  constructor(options: RateTableServiceOptions) {
    this.cacheFilePath = options.cacheFilePath
    this.fetchJson = options.fetchJson ?? fetchRateTableJson
    this.now = options.now ?? Date.now
    this.url = options.url ?? RATE_TABLE_URL
    this.table = BUNDLED_FALLBACK_RATE_TABLE
    this.loadDiskCache()
  }

  /** The best table known right now. Never waits on the network. */
  getTable(): RateTable {
    return this.table
  }

  /** Unix ms of the last successful fetch, or 0 if only the bundled fallback (or a cached copy of it) has ever been used. */
  getFetchedAt(): number {
    return Number.isFinite(this.fetchedAt) ? this.fetchedAt : 0
  }

  private loadDiskCache(): void {
    try {
      const raw = readFileSync(this.cacheFilePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<RateTableCacheFile> | null
      if (parsed && typeof parsed.fetchedAt === 'number' && parsed.table && typeof parsed.table === 'object') {
        this.table = parsed.table as RateTable
        this.fetchedAt = parsed.fetchedAt
      }
    } catch {
      // No cache file yet, or it's unreadable/corrupt — keep the bundled fallback.
    }
  }

  private saveDiskCache(): void {
    try {
      mkdirSync(dirname(this.cacheFilePath), { recursive: true })
      const file: RateTableCacheFile = { fetchedAt: this.fetchedAt, table: this.table }
      writeFileSync(this.cacheFilePath, JSON.stringify(file))
    } catch (error) {
      console.warn('[RateTableService] failed to persist the rate table cache:', error)
    }
  }

  /**
   * Refreshes from the network. `force` skips the 24h TTL but never the 60s
   * floor, so a user mashing "Refresh" (or several windows opening at once)
   * cannot hammer the source. Concurrent callers share one in-flight fetch.
   */
  async refresh(options: { force?: boolean } = {}): Promise<RateTableRefreshResult> {
    if (this.refreshing) return this.refreshing

    const nowMs = this.now()
    if (nowMs - this.lastAttemptAt < RATE_TABLE_REFRESH_FLOOR_MS) {
      return { refreshed: false, table: this.table }
    }
    if (!options.force && nowMs - this.fetchedAt < RATE_TABLE_TTL_MS) {
      return { refreshed: false, table: this.table }
    }

    this.lastAttemptAt = nowMs
    const pending = this.doFetch(nowMs).finally(() => {
      this.refreshing = null
    })
    this.refreshing = pending
    return pending
  }

  /** Opportunistic background refresh once the TTL has lapsed. Never throws, never awaited by UI code. */
  async ensureFresh(): Promise<void> {
    if (this.now() - this.fetchedAt < RATE_TABLE_TTL_MS) return
    await this.refresh({ force: false }).catch(() => undefined)
  }

  private async doFetch(nowMs: number): Promise<RateTableRefreshResult> {
    try {
      const raw = await this.fetchJson(this.url)
      const table = parseRateTable(raw)
      if (Object.keys(table).length === 0) throw new Error('rate table fetch returned no priced models')
      this.table = table
      this.fetchedAt = nowMs
      this.saveDiskCache()
      return { refreshed: true, table: this.table }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[RateTableService] refresh failed, keeping the last known table:', message)
      return { refreshed: false, table: this.table, error: message }
    }
  }
}
