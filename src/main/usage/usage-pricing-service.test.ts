import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RateTableService, RATE_TABLE_REFRESH_FLOOR_MS, RATE_TABLE_TTL_MS } from './usage-pricing-service'
import { BUNDLED_FALLBACK_RATE_TABLE } from './usage-pricing'

const RAW = { 'gpt-5': { input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5, litellm_provider: 'openai' } }

let dir: string
let cacheFilePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-pricing-service-'))
  cacheFilePath = join(dir, 'model-prices-cache.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('RateTableService', () => {
  it('starts from the bundled fallback when there is no disk cache yet', () => {
    const service = new RateTableService({ cacheFilePath })
    expect(service.getTable()).toBe(BUNDLED_FALLBACK_RATE_TABLE)
    expect(service.getFetchedAt()).toBe(0)
  })

  it('fetches, prices with the result, and persists it to disk', async () => {
    let now = 1_000_000
    const service = new RateTableService({ cacheFilePath, fetchJson: async () => RAW, now: () => now })
    const result = await service.refresh({ force: true })
    expect(result.refreshed).toBe(true)
    expect(service.getTable()['gpt-5']).toBeDefined()
    expect(service.getFetchedAt()).toBe(now)

    const persisted = JSON.parse(readFileSync(cacheFilePath, 'utf8'))
    expect(persisted.fetchedAt).toBe(now)
    expect(persisted.table['gpt-5']).toBeDefined()

    // A fresh service picks up the persisted cache without fetching.
    now += 1
    const reloaded = new RateTableService({ cacheFilePath, fetchJson: async () => { throw new Error('should not fetch') }, now: () => now })
    expect(reloaded.getTable()['gpt-5']).toBeDefined()
  })

  it('never fetches more often than the 60s floor, even when forced', async () => {
    let now = 0
    let fetchCount = 0
    const service = new RateTableService({ cacheFilePath, fetchJson: async () => { fetchCount++; return RAW }, now: () => now })

    await service.refresh({ force: true })
    expect(fetchCount).toBe(1)

    now += RATE_TABLE_REFRESH_FLOOR_MS - 1
    const second = await service.refresh({ force: true })
    expect(second.refreshed).toBe(false)
    expect(fetchCount).toBe(1)

    now += 2
    await service.refresh({ force: true })
    expect(fetchCount).toBe(2)
  })

  it('does not re-fetch within the TTL unless forced', async () => {
    let now = 0
    let fetchCount = 0
    const service = new RateTableService({ cacheFilePath, fetchJson: async () => { fetchCount++; return RAW }, now: () => now })
    await service.refresh({ force: true })
    expect(fetchCount).toBe(1)

    now += RATE_TABLE_REFRESH_FLOOR_MS + 1
    const unforced = await service.refresh({ force: false })
    expect(unforced.refreshed).toBe(false)
    expect(fetchCount).toBe(1)

    now += RATE_TABLE_TTL_MS
    await service.refresh({ force: false })
    expect(fetchCount).toBe(2)
  })

  it('keeps using the last known table when a refresh fails', async () => {
    let now = 0
    const service = new RateTableService({ cacheFilePath, fetchJson: async () => RAW, now: () => now })
    await service.refresh({ force: true })
    expect(service.getTable()['gpt-5']).toBeDefined()

    now += RATE_TABLE_REFRESH_FLOOR_MS + 1
    const failing = new RateTableService({
      cacheFilePath,
      fetchJson: async () => { throw new Error('network down') },
      now: () => now
    })
    const result = await failing.refresh({ force: true })
    expect(result.refreshed).toBe(false)
    expect(result.error).toMatch(/network down/)
    // Still has what the disk cache gave it at construction time.
    expect(failing.getTable()['gpt-5']).toBeDefined()
  })

  it('falls back to the bundled snapshot when there is no cache and the fetch fails', async () => {
    const service = new RateTableService({ cacheFilePath, fetchJson: async () => { throw new Error('offline') } })
    const result = await service.refresh({ force: true })
    expect(result.refreshed).toBe(false)
    expect(service.getTable()).toBe(BUNDLED_FALLBACK_RATE_TABLE)
  })

  it('shares one in-flight refresh across concurrent callers', async () => {
    let fetchCount = 0
    const service = new RateTableService({
      cacheFilePath,
      fetchJson: async () => { fetchCount++; await new Promise((r) => setTimeout(r, 10)); return RAW }
    })
    const [a, b] = await Promise.all([service.refresh({ force: true }), service.refresh({ force: true })])
    expect(fetchCount).toBe(1)
    expect(a).toEqual(b)
  })

  it('ensureFresh only refreshes once the TTL has lapsed, and never throws', async () => {
    let now = 0
    let fetchCount = 0
    const service = new RateTableService({ cacheFilePath, fetchJson: async () => { fetchCount++; return RAW }, now: () => now })
    // Bundled fallback, fetchedAt = 0 → TTL already "lapsed" relative to now=0? Use now far in the future for the first check instead.
    now = RATE_TABLE_TTL_MS + 1
    await service.ensureFresh()
    expect(fetchCount).toBe(1)

    now += 10
    await service.ensureFresh()
    expect(fetchCount).toBe(1) // within TTL of the fetch above

    const neverThrows = new RateTableService({ cacheFilePath: join(dir, 'other.json'), fetchJson: async () => { throw new Error('boom') }, now: () => RATE_TABLE_TTL_MS + 1 })
    await expect(neverThrows.ensureFresh()).resolves.toBeUndefined()
  })
})
