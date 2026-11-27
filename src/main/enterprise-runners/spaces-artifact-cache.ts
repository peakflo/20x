/**
 * Cache for read-only Spaces artifacts, so the panel keeps working offline.
 *
 * Bounded two ways: an LRU cap (entry count and total bytes) and a TTL.
 * Secrets are never cached: content that looks like a credential is stored as
 * "metadata only" and reads as "not cached".
 */

export interface CachedArtifact {
  key: string
  taskId: string
  /** Opaque JSON-serialisable metadata (summary rows). */
  meta: unknown
  /** Text content; null when the file is binary, too large or looked secret. */
  content: string | null
  encoding: 'utf8' | 'base64' | 'none'
  mimeType: string
  sizeBytes: number
  storedAt: number
}

export interface SpacesArtifactCacheOptions {
  maxEntries?: number
  maxBytes?: number
  maxEntryBytes?: number
  ttlMs?: number
  now?: () => number
}

export const DEFAULT_ARTIFACT_CACHE = {
  maxEntries: 200,
  maxBytes: 20 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024,
  ttlMs: 7 * 24 * 60 * 60 * 1000
} as const

const SECRET_PATTERNS = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/, // JWT
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|ghp|gho|ghs|xox[bp])[-_][A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/
]

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text))
}

export class SpacesArtifactCache {
  /** Map insertion order is the LRU order (oldest first). */
  private readonly entries = new Map<string, CachedArtifact>()
  private totalBytes = 0
  private readonly o: Required<SpacesArtifactCacheOptions>

  constructor(options: SpacesArtifactCacheOptions = {}) {
    this.o = { ...DEFAULT_ARTIFACT_CACHE, now: Date.now, ...options }
  }

  private cost(e: CachedArtifact): number {
    return (e.content?.length ?? 0) + 256
  }

  private drop(key: string): void {
    const e = this.entries.get(key)
    if (!e) return
    this.totalBytes -= this.cost(e)
    this.entries.delete(key)
  }

  put(entry: Omit<CachedArtifact, 'storedAt'>): CachedArtifact {
    const tooBig = entry.content !== null && entry.content.length > this.o.maxEntryBytes
    const secret = entry.content !== null && looksSecret(entry.content)
    const stored: CachedArtifact = {
      ...entry,
      content: tooBig || secret ? null : entry.content,
      encoding: tooBig || secret ? 'none' : entry.encoding,
      storedAt: this.o.now()
    }
    this.drop(entry.key)
    this.entries.set(entry.key, stored)
    this.totalBytes += this.cost(stored)
    this.evict()
    return stored
  }

  /** Returns a fresh entry and marks it most recently used; expired entries are dropped. */
  get(key: string): CachedArtifact | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    if (this.o.now() - e.storedAt > this.o.ttlMs) {
      this.drop(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, e)
    return e
  }

  listForTask(taskId: string): CachedArtifact[] {
    const out: CachedArtifact[] = []
    for (const [key, e] of [...this.entries]) {
      if (e.taskId !== taskId) continue
      if (this.o.now() - e.storedAt > this.o.ttlMs) { this.drop(key); continue }
      out.push(e)
    }
    return out
  }

  clear(): void {
    this.entries.clear()
    this.totalBytes = 0
  }

  get size(): number { return this.entries.size }
  get bytes(): number { return this.totalBytes }

  private evict(): void {
    while (this.entries.size > this.o.maxEntries || this.totalBytes > this.o.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) return
      this.drop(oldest)
    }
  }

  /** Serialise for persistence (settings). Only live entries. */
  snapshot(): CachedArtifact[] {
    const now = this.o.now()
    return [...this.entries.values()].filter((e) => now - e.storedAt <= this.o.ttlMs)
  }

  restore(entries: CachedArtifact[]): void {
    for (const e of entries) {
      this.entries.set(e.key, e)
      this.totalBytes += this.cost(e)
    }
    this.evict()
  }
}
