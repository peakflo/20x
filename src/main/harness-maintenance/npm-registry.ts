/**
 * Latest-version lookups for npm-published harness CLIs, with a 1-hour cache
 * (in-memory, plus an injectable persisted store so it survives app restarts)
 * and a 4-second timeout. Never throws — a failed or offline lookup resolves
 * to `null` so the UI can show "unknown" instead of blocking.
 */

const TIMEOUT_MS = 4000
const SUCCESS_TTL_MS = 60 * 60 * 1000 // 1 hour
const FAILURE_TTL_MS = 60 * 1000 // 1 minute — don't hide a real update behind a transient blip

interface CacheEntry {
  version: string | null
  fetchedAt: number
}

/** Minimal persistence contract so main can back the cache with settings, and tests can use a plain object. */
export interface MaintenanceCacheStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

export class NpmLatestVersionCache {
  private memory = new Map<string, CacheEntry>()

  constructor(private readonly persisted?: MaintenanceCacheStore, private readonly persistKey = 'harness_npm_latest_cache') {
    if (persisted) {
      try {
        const raw = persisted.get(persistKey)
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, CacheEntry>
          for (const [key, entry] of Object.entries(parsed)) this.memory.set(key, entry)
        }
      } catch {
        // Corrupt/old cache shape — start fresh.
      }
    }
  }

  get(pkg: string, now = Date.now()): { hit: true; version: string | null } | { hit: false } {
    const entry = this.memory.get(pkg)
    if (!entry) return { hit: false }
    const ttl = entry.version ? SUCCESS_TTL_MS : FAILURE_TTL_MS
    if (now - entry.fetchedAt > ttl) return { hit: false }
    return { hit: true, version: entry.version }
  }

  set(pkg: string, version: string | null, now = Date.now()): void {
    this.memory.set(pkg, { version, fetchedAt: now })
    this.persist()
  }

  clear(pkg: string): void {
    this.memory.delete(pkg)
    this.persist()
  }

  private persist(): void {
    if (!this.persisted) return
    try {
      const obj = Object.fromEntries(this.memory.entries())
      this.persisted.set(this.persistKey, JSON.stringify(obj))
    } catch {
      // Best-effort — an in-memory-only cache for this run is fine.
    }
  }
}

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>

/**
 * Fetches `GET https://registry.npmjs.org/<pkg>/latest` with a 4s timeout.
 * Pass `fetchImpl` in tests; defaults to the global `fetch` (undici, via Node/Electron).
 */
export async function fetchLatestNpmVersionUncached(pkg: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) return null
    const data = await response.json() as { version?: unknown }
    return typeof data.version === 'string' ? data.version : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Cached latest-version lookup. `fresh: true` bypasses the cache (used right before/after running an update). */
export async function fetchLatestNpmVersion(
  pkg: string,
  cache: NpmLatestVersionCache,
  opts: { fresh?: boolean; fetchImpl?: FetchLike } = {}
): Promise<string | null> {
  if (!opts.fresh) {
    const cached = cache.get(pkg)
    if (cached.hit) return cached.version
  }
  const version = await fetchLatestNpmVersionUncached(pkg, opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike))
  cache.set(pkg, version)
  return version
}
