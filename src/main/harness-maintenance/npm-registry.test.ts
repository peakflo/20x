import { describe, expect, it, vi } from 'vitest'
import { NpmLatestVersionCache, fetchLatestNpmVersion, fetchLatestNpmVersionUncached, type FetchLike } from './npm-registry'

function fakeFetch(result: { ok: boolean; version?: string } | 'throw' | 'hang'): FetchLike {
  return vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
    if (result === 'hang') {
      await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
      throw new Error('unreachable')
    }
    if (result === 'throw') throw new Error('network down')
    return { ok: result.ok, json: async () => ({ version: result.version }) }
  })
}

describe('fetchLatestNpmVersionUncached', () => {
  it('returns the version from a successful response', async () => {
    const version = await fetchLatestNpmVersionUncached('opencode-ai', fakeFetch({ ok: true, version: '1.18.35' }))
    expect(version).toBe('1.18.35')
  })

  it('returns null on a non-ok response', async () => {
    const version = await fetchLatestNpmVersionUncached('opencode-ai', fakeFetch({ ok: false }))
    expect(version).toBeNull()
  })

  it('returns null on a network error (offline)', async () => {
    const version = await fetchLatestNpmVersionUncached('opencode-ai', fakeFetch('throw'))
    expect(version).toBeNull()
  })

  it('times out after 4s and returns null', async () => {
    vi.useFakeTimers()
    const promise = fetchLatestNpmVersionUncached('opencode-ai', fakeFetch('hang'))
    await vi.advanceTimersByTimeAsync(4001)
    const version = await promise
    expect(version).toBeNull()
    vi.useRealTimers()
  })
})

describe('NpmLatestVersionCache', () => {
  it('serves a cached success within the 1h TTL without calling the fetcher again', async () => {
    const cache = new NpmLatestVersionCache()
    const fetchImpl = fakeFetch({ ok: true, version: '1.0.0' })
    const first = await fetchLatestNpmVersion('@openai/codex', cache, { fetchImpl })
    const second = await fetchLatestNpmVersion('@openai/codex', cache, { fetchImpl })
    expect(first).toBe('1.0.0')
    expect(second).toBe('1.0.0')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('re-fetches after the 1h success TTL expires', async () => {
    vi.useFakeTimers()
    try {
      const cache = new NpmLatestVersionCache()
      const fetchImpl = fakeFetch({ ok: true, version: '1.0.0' })
      await fetchLatestNpmVersion('@openai/codex', cache, { fetchImpl })
      vi.setSystemTime(Date.now() + 61 * 60 * 1000)
      await fetchLatestNpmVersion('@openai/codex', cache, { fetchImpl })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-fetches a failed lookup sooner than a success (1 minute, not 1 hour)', async () => {
    vi.useFakeTimers()
    try {
      const cache = new NpmLatestVersionCache()
      const fetchImpl = fakeFetch('throw')
      await fetchLatestNpmVersion('@openai/codex', cache, { fetchImpl })
      vi.setSystemTime(Date.now() + 61 * 1000)
      await fetchLatestNpmVersion('@openai/codex', cache, { fetchImpl })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bypasses the cache with fresh: true', async () => {
    const cache = new NpmLatestVersionCache()
    const fetchImpl = fakeFetch({ ok: true, version: '1.0.0' })
    await fetchLatestNpmVersion('@openai/codex', cache, { fetchImpl })
    await fetchLatestNpmVersion('@openai/codex', cache, { fetchImpl, fresh: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('persists across instances via the injected store', async () => {
    const store = new Map<string, string>()
    const persisted = { get: (k: string) => store.get(k), set: (k: string, v: string) => store.set(k, v) }
    const cache1 = new NpmLatestVersionCache(persisted)
    const fetchImpl = fakeFetch({ ok: true, version: '2.0.0' })
    await fetchLatestNpmVersion('@openai/codex', cache1, { fetchImpl })

    const cache2 = new NpmLatestVersionCache(persisted)
    const second = await fetchLatestNpmVersion('@openai/codex', cache2, { fetchImpl })
    expect(second).toBe('2.0.0')
    expect(fetchImpl).toHaveBeenCalledTimes(1) // cache2 never had to call the network
  })
})
