/**
 * Fetches, validates, and caches the official ACP agent registry, and
 * resolves which distribution (binary / npx / uvx) a given entry should use
 * on the current machine.
 *
 * Network fetches are capped (30s, 1 MiB) and failures fall back to the last
 * good on-disk cache rather than failing outright, so a flaky network never
 * makes previously-discovered agents disappear.
 */

import { execFile } from 'child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import {
  currentPlatformTarget,
  validateRegistryIndex,
  type AcpPlatformTarget,
  type AcpRegistryAgentEntry,
  type AcpRegistryIndex
} from './registry-types'

const execFileAsync = promisify(execFile)

export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
const FETCH_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 1024 * 1024 // 1 MiB

export type DistributionKind = 'binary' | 'npx' | 'uvx'

export interface ResolvedDistribution {
  kind: DistributionKind
  /** The full entry this was resolved from. */
  entry: AcpRegistryAgentEntry
  /** Only set for kind === 'binary'. */
  platformTarget?: AcpPlatformTarget
  /** The declared args for this distribution (binary/npx/uvx all may carry their own). */
  args: string[]
  env: Record<string, string>
}

export interface DistributionResolutionFailure {
  kind: 'unsupported-platform' | 'no-distribution-for-platform' | 'runner-unavailable'
  message: string
  /** Set when the failure is specifically a missing npm/uv runner. */
  missingRunner?: 'npm' | 'uv'
}

export interface RegistryLoadResult {
  index: AcpRegistryIndex
  source: 'network' | 'cache'
  droppedCount: number
}

export interface RegistryClientOptions {
  /** Directory the registry cache file is written under, e.g. `<userData>/acp-agents`. */
  cacheDir: string
  fetchImpl?: typeof fetch
  url?: string
}

function cacheFilePath(cacheDir: string): string {
  return join(cacheDir, 'registry-cache.json')
}

/** Streams the registry response with a hard byte cap, enforced while reading (not after). */
async function readCappedBody(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('ACP registry response exceeded the 1 MiB size cap')
    }
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error('ACP registry response exceeded the 1 MiB size cap')
      }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}

async function fetchRegistryText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`ACP registry fetch failed with HTTP ${response.status}`)
    }
    return await readCappedBody(response)
  } finally {
    clearTimeout(timeout)
  }
}

/** Atomic write: temp file + rename, so a concurrent reader never sees a half-written cache. */
async function writeCacheAtomic(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {})
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

async function readCache(path: string): Promise<RegistryLoadResult | null> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const raw = JSON.parse(text)
    const { index, droppedCount } = validateRegistryIndex(raw)
    return { index, source: 'cache', droppedCount }
  } catch {
    return null
  }
}

/**
 * Serializes concurrent refreshes so two near-simultaneous callers don't both
 * hit the network; the second just awaits the first's in-flight promise.
 */
class RegistryClient {
  private inFlight: Promise<RegistryLoadResult> | null = null

  constructor(private options: RegistryClientOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  private get url(): string {
    return this.options.url ?? ACP_REGISTRY_URL
  }

  private get cachePath(): string {
    return cacheFilePath(this.options.cacheDir)
  }

  /** Loads from cache only, never touching the network. Used by low-latency status checks. */
  async loadCachedOnly(): Promise<RegistryLoadResult | null> {
    return readCache(this.cachePath)
  }

  /**
   * Loads the registry: fetches fresh unless `forceRefetch` is false and a
   * cache already exists. On any fetch failure, falls back to the cache. If
   * there's no usable network response AND no valid cache, throws.
   */
  async load(opts: { forceRefetch?: boolean } = {}): Promise<RegistryLoadResult> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.loadInternal(opts)
    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private async loadInternal(opts: { forceRefetch?: boolean }): Promise<RegistryLoadResult> {
    const shouldFetch = opts.forceRefetch !== false
    if (shouldFetch) {
      try {
        const text = await fetchRegistryText(this.url, this.fetchImpl)
        const raw = JSON.parse(text)
        const { index, droppedCount } = validateRegistryIndex(raw)
        await writeCacheAtomic(this.cachePath, text).catch(() => {
          // Cache write failures are non-fatal: the caller still gets a fresh result.
        })
        return { index, source: 'network', droppedCount }
      } catch {
        const cached = await readCache(this.cachePath)
        if (cached) return cached
        throw new Error('ACP registry is unavailable (network fetch failed and no cache exists)')
      }
    }
    const cached = await readCache(this.cachePath)
    if (cached) return cached
    return this.loadInternal({ forceRefetch: true })
  }
}

export function createRegistryClient(options: RegistryClientOptions): RegistryClient {
  return new RegistryClient(options)
}

/** Case-insensitive substring search over id/name/description, name matches ranked first. */
export function searchAgents(index: AcpRegistryIndex, query: string): AcpRegistryAgentEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...index.agents]
  const nameMatches: AcpRegistryAgentEntry[] = []
  const otherMatches: AcpRegistryAgentEntry[] = []
  for (const agent of index.agents) {
    if (agent.name.toLowerCase().includes(q) || agent.id.toLowerCase().includes(q)) {
      nameMatches.push(agent)
    } else if (agent.description?.toLowerCase().includes(q)) {
      otherMatches.push(agent)
    }
  }
  return [...nameMatches, ...otherMatches]
}

const runnerCache = new Map<string, boolean>()

/** Checks whether a runner (npm, uv, or any other command) resolves on PATH. Result is cached per-process. */
export async function commandExistsOnPath(cmd: string): Promise<boolean> {
  if (runnerCache.has(cmd)) return runnerCache.get(cmd) as boolean
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const exists = await execFileAsync(finder, [cmd])
    .then(() => true)
    .catch(() => false)
  runnerCache.set(cmd, exists)
  return exists
}

/** Test-only: clears the per-process runner presence cache. */
export function __resetRunnerCacheForTests(): void {
  runnerCache.clear()
}

export interface ResolveDistributionOptions {
  preferred?: DistributionKind | 'auto'
  platformTarget?: AcpPlatformTarget | null
  hasNpm?: () => Promise<boolean>
  hasUv?: () => Promise<boolean>
}

/**
 * Resolves which distribution to use for an entry on this machine: binary
 * first, then npx, then uvx (unless the caller pins one explicitly), hiding
 * npx/uvx when the corresponding runner isn't present.
 */
export async function resolveDistribution(
  entry: AcpRegistryAgentEntry,
  opts: ResolveDistributionOptions = {}
): Promise<ResolvedDistribution | DistributionResolutionFailure> {
  // `undefined` means "not specified, detect it"; an explicit `null` means
  // "simulate/force unsupported" (used by tests) and must not be coerced.
  const platformTarget = 'platformTarget' in opts ? opts.platformTarget : currentPlatformTarget()
  const preferred = opts.preferred ?? 'auto'
  const hasNpm = opts.hasNpm ?? (() => commandExistsOnPath('npm'))
  const hasUv = opts.hasUv ?? (() => commandExistsOnPath('uv'))

  const order: DistributionKind[] = preferred === 'auto' ? ['binary', 'npx', 'uvx'] : [preferred]

  for (const kind of order) {
    if (kind === 'binary') {
      if (!platformTarget) continue
      const target = entry.distribution.binary?.[platformTarget]
      if (!target) continue
      return {
        kind: 'binary',
        entry,
        platformTarget,
        args: target.args ?? [],
        env: target.env ?? {}
      }
    }
    if (kind === 'npx') {
      if (!entry.distribution.npx) continue
      if (!(await hasNpm())) {
        if (preferred === 'npx') return { kind: 'runner-unavailable', message: 'npm is not available on PATH', missingRunner: 'npm' }
        continue
      }
      return { kind: 'npx', entry, args: entry.distribution.npx.args ?? [], env: entry.distribution.npx.env ?? {} }
    }
    if (kind === 'uvx') {
      if (!entry.distribution.uvx) continue
      if (!(await hasUv())) {
        if (preferred === 'uvx') return { kind: 'runner-unavailable', message: 'uv is not available on PATH', missingRunner: 'uv' }
        continue
      }
      return { kind: 'uvx', entry, args: entry.distribution.uvx.args ?? [], env: entry.distribution.uvx.env ?? {} }
    }
  }

  if (!platformTarget) {
    return { kind: 'unsupported-platform', message: `Unsupported platform: ${process.platform}/${process.arch}` }
  }
  return {
    kind: 'no-distribution-for-platform',
    message: `"${entry.name}" has no installable distribution for ${platformTarget} (or its required runner is missing)`
  }
}

/**
 * Filters a registry's agents down to ones installable on this machine —
 * used for search results, so a user is never offered an agent with no
 * viable distribution rather than shown it greyed out.
 */
export async function filterInstallableOnThisPlatform(
  agents: AcpRegistryAgentEntry[],
  opts: ResolveDistributionOptions = {}
): Promise<AcpRegistryAgentEntry[]> {
  const results: AcpRegistryAgentEntry[] = []
  for (const agent of agents) {
    const resolved = await resolveDistribution(agent, opts)
    if ('kind' in resolved && (resolved.kind === 'binary' || resolved.kind === 'npx' || resolved.kind === 'uvx')) {
      results.push(agent)
    }
  }
  return results
}

export async function removeRegistryCache(cacheDir: string): Promise<void> {
  await rm(cacheFilePath(cacheDir), { force: true })
}
