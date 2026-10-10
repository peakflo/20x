/**
 * Bundled version requirements and npm package names for user-installed
 * harness CLIs. This is a static, bundled-only manifest — no remote fetch.
 * Keep it small and update it by hand when a harness's minimum/recommended
 * version changes.
 *
 * Renderer, main and mobile share this file. Keep Node and Electron imports out.
 */

/** A harness whose CLI the user installs and updates themselves. Matches `CodingAgentType` values. */
export type HarnessKey = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'cursor'

export const HARNESS_KEYS: readonly HarnessKey[] = ['claude-code', 'codex', 'opencode', 'pi', 'cursor'] as const

export function isHarnessKey(value: unknown): value is HarnessKey {
  return typeof value === 'string' && (HARNESS_KEYS as readonly string[]).includes(value)
}

export interface HarnessVersionRequirement {
  /** Below this version, the harness is flagged `unsupported` (not just outdated). */
  minimum?: string
  /** Below this version (but at/above `minimum`), the harness is flagged `below_recommended`. */
  recommended?: string
}

/** Was `MINIMUM_PI_VERSION` in `agent-installer/detect.js`. Kept as the single source of truth. */
export const MINIMUM_PI_VERSION = '0.80.5'

/**
 * Bundled minimum/recommended versions per harness. Cursor has none: it is
 * moving to `@cursor/sdk`, pinned in 20x's own package.json, so it updates
 * with 20x rather than being version-checked here.
 */
export const HARNESS_VERSION_REQUIREMENTS: Record<HarnessKey, HarnessVersionRequirement> = {
  'claude-code': { recommended: '1.0.0' },
  codex: { recommended: '0.20.0' },
  opencode: { recommended: '1.0.0' },
  pi: { minimum: MINIMUM_PI_VERSION, recommended: '0.84.0' },
  cursor: {}
}

/** The npm package that ships a harness's CLI, or null when it has none (Cursor). */
export const HARNESS_NPM_PACKAGES: Record<HarnessKey, string | null> = {
  'claude-code': '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  // OpenCode kept its 1.x package name; 2.x ships under a different package
  // (see `resolveOpencodeNpmPackage`). Never move a 1.x install onto 2.x.
  opencode: 'opencode-ai',
  pi: '@earendil-works/pi-coding-agent',
  cursor: null
}

/** OpenCode's 2.x line ships under a different npm package than 1.x. */
export const OPENCODE_V2_NPM_PACKAGE = '@opencode/cli'

/**
 * The npm package name to check/update against, given the currently installed
 * version (when known). OpenCode is the only harness with a major-version
 * package split: an installed 2.x never gets offered the 1.x package's
 * "latest", and vice versa. An unknown/missing version conservatively stays
 * on the 1.x package name (the common case today).
 */
export function resolveNpmPackageName(harness: HarnessKey, installedVersion: string | null): string | null {
  if (harness !== 'opencode') return HARNESS_NPM_PACKAGES[harness]
  const major = installedVersion ? Number.parseInt(installedVersion.split('.')[0] ?? '', 10) : NaN
  return major >= 2 ? OPENCODE_V2_NPM_PACKAGE : HARNESS_NPM_PACKAGES.opencode
}
