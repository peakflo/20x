/**
 * Types and strict validation for the official ACP (Agent Client Protocol)
 * agent registry document.
 *
 * The registry is third-party-authored JSON fetched from a public CDN. Every
 * entry is validated defensively: a malformed or hostile entry (path
 * traversal in a command, a floating npx/uvx version, a non-HTTPS URL, an
 * icon pointing somewhere other than the known CDN) is dropped rather than
 * trusted, so one bad entry can never take down discovery of every other
 * agent — and nothing here is ever executed without the strict shape checks
 * passing first.
 */

import { posix as posixPath } from 'path'

/** The six platform targets a registry distribution entry can be keyed by. */
export const ACP_PLATFORM_TARGETS = [
  'darwin-aarch64',
  'darwin-x86_64',
  'linux-aarch64',
  'linux-x86_64',
  'windows-aarch64',
  'windows-x86_64'
] as const

export type AcpPlatformTarget = (typeof ACP_PLATFORM_TARGETS)[number]

export interface AcpRegistryBinaryTarget {
  archive: string
  cmd: string
  sha256?: string
  args?: string[]
  env?: Record<string, string>
}

export interface AcpRegistryNpxDistribution {
  package: string
  args?: string[]
  env?: Record<string, string>
}

export interface AcpRegistryUvxDistribution {
  package: string
  args?: string[]
  env?: Record<string, string>
}

export interface AcpRegistryDistribution {
  binary?: Partial<Record<AcpPlatformTarget, AcpRegistryBinaryTarget>>
  npx?: AcpRegistryNpxDistribution
  uvx?: AcpRegistryUvxDistribution
}

export interface AcpRegistryAgentEntry {
  id: string
  name: string
  version: string
  description?: string
  authors?: string[]
  license?: string
  license_url?: string
  website?: string
  repository?: string
  icon?: string
  distribution: AcpRegistryDistribution
}

export interface AcpRegistryIndex {
  version: string
  agents: AcpRegistryAgentEntry[]
}

/** Known CDN host the registry and its icons are served from. */
const REGISTRY_CDN_HOST = 'cdn.agentclientprotocol.com'
const MAX_URL_LENGTH = 2048
const MAX_STRING_LENGTH = 4096
const MAX_AUTHORS = 32
const MAX_ARGS = 64
const MAX_ENV_VARS = 64

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
/** npm spec `name@X.Y.Z` or `@scope/name@X.Y.Z`, optional -prerelease/+build. */
const NPX_SPEC_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
/**
 * PyPI spec pinned to an exact version. `uv`/`uvx` accepts either the PEP 440
 * `pkg==X.Y.Z` form or the npm-style `pkg@X.Y.Z` form — both appear in the
 * public registry — but never a bare/floating package name.
 */
const UVX_SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(==|@)\d+(\.\d+)*([.-]?(a|b|rc|post|dev)\d*)?$/

export function isAcpPlatformTarget(value: string): value is AcpPlatformTarget {
  return (ACP_PLATFORM_TARGETS as readonly string[]).includes(value)
}

/** Maps the running process onto a registry platform-target string, or null if unsupported. */
export function currentPlatformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): AcpPlatformTarget | null {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : null
  const a = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
  if (!os || !a) return null
  return `${os}-${a}` as AcpPlatformTarget
}

function isSafeString(value: unknown, maxLength = MAX_STRING_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

/** Absolute HTTPS URL, no embedded credentials, bounded length. */
function isSafeHttpsUrl(value: unknown): value is string {
  if (!isSafeString(value, MAX_URL_LENGTH)) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  return true
}

/**
 * Rejects absolute paths, Windows drive prefixes, and any path that escapes
 * its own starting directory via `..` traversal (after normalization, so
 * `a/../../b` is caught even though no single raw segment looks dangerous).
 * A conventional `./agent` prefix — the shape every real binary `cmd` in the
 * public registry uses — is accepted.
 */
export function isSafeRelativeCommandPath(cmd: unknown): cmd is string {
  if (!isSafeString(cmd, 512)) return false
  const slashed = cmd.replace(/\\/g, '/')
  if (slashed.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(slashed)) return false
  const normalized = posixPath.normalize(slashed)
  if (normalized === '.' || normalized === '') return false
  if (normalized.startsWith('/')) return false
  if (normalized === '..' || normalized.startsWith('../')) return false
  return true
}

function sanitizeArgs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_ARGS) return undefined
  const args: string[] = []
  for (const item of value) {
    if (!isSafeString(item, 1024)) return undefined
    args.push(item)
  }
  return args
}

function sanitizeEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_ENV_VARS) return undefined
  const env: Record<string, string> = {}
  for (const [key, val] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !isSafeString(val, 4096)) return undefined
    env[key] = val as string
  }
  return env
}

function validateBinaryTarget(value: unknown): AcpRegistryBinaryTarget | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!isSafeHttpsUrl(v.archive)) return null
  if (!isSafeRelativeCommandPath(v.cmd)) return null
  const sha256 = v.sha256
  if (sha256 !== undefined && !(typeof sha256 === 'string' && /^[0-9a-f]{64}$/i.test(sha256))) return null
  const args = sanitizeArgs(v.args)
  if (v.args !== undefined && args === undefined) return null
  const env = sanitizeEnv(v.env)
  if (v.env !== undefined && env === undefined) return null
  return { archive: v.archive as string, cmd: v.cmd as string, sha256: sha256 as string | undefined, args, env }
}

function validateNpxOrUvx(
  value: unknown,
  specRe: RegExp
): { package: string; args?: string[]; env?: Record<string, string> } | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!isSafeString(v.package, 512) || !specRe.test(v.package)) return null
  const args = sanitizeArgs(v.args)
  if (v.args !== undefined && args === undefined) return null
  const env = sanitizeEnv(v.env)
  if (v.env !== undefined && env === undefined) return null
  return { package: v.package, args, env }
}

function validateDistribution(value: unknown): AcpRegistryDistribution | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const distribution: AcpRegistryDistribution = {}

  if (v.binary !== undefined) {
    if (typeof v.binary !== 'object' || v.binary === null) return null
    const binary: Partial<Record<AcpPlatformTarget, AcpRegistryBinaryTarget>> = {}
    for (const [target, targetValue] of Object.entries(v.binary as Record<string, unknown>)) {
      if (!isAcpPlatformTarget(target)) continue // unknown target key: ignore, don't fail the whole entry
      const validated = validateBinaryTarget(targetValue)
      if (validated) binary[target] = validated
    }
    if (Object.keys(binary).length > 0) distribution.binary = binary
  }
  if (v.npx !== undefined) {
    const npx = validateNpxOrUvx(v.npx, NPX_SPEC_RE)
    if (npx) distribution.npx = npx
  }
  if (v.uvx !== undefined) {
    const uvx = validateNpxOrUvx(v.uvx, UVX_SPEC_RE)
    if (uvx) distribution.uvx = uvx
  }
  if (!distribution.binary && !distribution.npx && !distribution.uvx) return null
  return distribution
}

/** Known-good icon URL for an agent id, independent of what the entry itself claims. */
export function fallbackIconUrl(id: string): string {
  return `https://${REGISTRY_CDN_HOST}/registry/v1/latest/${encodeURIComponent(id)}.svg`
}

function validateIcon(id: string, value: unknown): string | undefined {
  if (value === undefined) return fallbackIconUrl(id)
  if (!isSafeHttpsUrl(value)) return fallbackIconUrl(id)
  try {
    const url = new URL(value as string)
    if (url.hostname !== REGISTRY_CDN_HOST) return fallbackIconUrl(id)
  } catch {
    return fallbackIconUrl(id)
  }
  return value as string
}

function validateAuthors(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_AUTHORS) return undefined
  const authors: string[] = []
  for (const item of value) {
    if (!isSafeString(item, 256)) return undefined
    authors.push(item)
  }
  return authors
}

/**
 * Validates one raw registry entry. Returns null (never throws) when the
 * entry doesn't pass strict validation, so the caller can drop it and keep
 * processing the rest of the registry.
 */
export function validateAgentEntry(value: unknown): AcpRegistryAgentEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>

  if (!isSafeString(v.id, 128) || !ID_RE.test(v.id)) return null
  if (!isSafeString(v.name, 256)) return null
  if (!isSafeString(v.version, 128) || !VERSION_RE.test(v.version)) return null

  const distribution = validateDistribution(v.distribution)
  if (!distribution) return null

  if (v.description !== undefined && !isSafeString(v.description, 2048)) return null
  if (v.license !== undefined && !isSafeString(v.license, 256)) return null
  if (v.license_url !== undefined && !isSafeHttpsUrl(v.license_url)) return null
  if (v.website !== undefined && !isSafeHttpsUrl(v.website)) return null
  if (v.repository !== undefined && !isSafeHttpsUrl(v.repository)) return null

  const authors = validateAuthors(v.authors)
  if (v.authors !== undefined && authors === undefined) return null

  return {
    id: v.id as string,
    name: v.name as string,
    version: v.version as string,
    description: v.description as string | undefined,
    authors,
    license: v.license as string | undefined,
    license_url: v.license_url as string | undefined,
    website: v.website as string | undefined,
    repository: v.repository as string | undefined,
    icon: validateIcon(v.id as string, v.icon),
    distribution
  }
}

export interface ValidatedRegistry {
  index: AcpRegistryIndex
  /** Number of raw entries dropped by strict validation. */
  droppedCount: number
}

/**
 * Validates a raw decoded registry document. Never throws for entry-level
 * problems — those entries are dropped and counted. Throws only when the
 * document itself has no usable envelope (not an object, no `agents` array).
 */
export function validateRegistryIndex(raw: unknown): ValidatedRegistry {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('ACP registry document is not an object')
  }
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.agents)) {
    throw new Error('ACP registry document has no "agents" array')
  }
  const version = isSafeString(r.version, 32) ? (r.version as string) : '0.0.0'
  const agents: AcpRegistryAgentEntry[] = []
  let dropped = 0
  for (const raw of r.agents) {
    const entry = validateAgentEntry(raw)
    if (entry) agents.push(entry)
    else dropped++
  }
  return { index: { version, agents }, droppedCount: dropped }
}
