/**
 * Shared helper for building a harness agent process's environment.
 *
 * 20x reads provider credentials (OPENAI_API_KEY, CODEX_API_KEY,
 * ANTHROPIC_API_KEY, ...) out of the user's login shell at startup so it can
 * find a subscription token or API key the terminal already has (see
 * loadPlatformShellEnv in index.ts). That is legitimate — the app process
 * itself needs to know these values.
 *
 * What is NOT legitimate is handing every one of them to every spawned agent
 * process via `{ ...process.env }`. A Codex session never needs
 * ANTHROPIC_API_KEY; a Pi session never needs any of them. Each adapter must
 * start from `buildHarnessBaseEnv()` (every env var EXCEPT the known
 * provider-credential ones) and re-add back, explicitly, only the one
 * credential its own auth method actually requires for this session.
 */

/** Every provider credential env var 20x knows about and reads from the login shell / config. */
export const KNOWN_PROVIDER_CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENCODE_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'PEAKFLO_AI_GATEWAY_API_KEY'
] as const

export type KnownProviderCredentialEnvVar = (typeof KNOWN_PROVIDER_CREDENTIAL_ENV_VARS)[number]

const CREDENTIAL_SET: ReadonlySet<string> = new Set(KNOWN_PROVIDER_CREDENTIAL_ENV_VARS)

export function isKnownProviderCredentialVar(name: string): boolean {
  return CREDENTIAL_SET.has(name)
}

/**
 * Base environment for a spawned harness process: a copy of `source`
 * (defaults to `process.env`) with every known provider-credential variable
 * removed. PATH, locale (LANG/LC_*), proxy settings (HTTP_PROXY etc.), and
 * everything else not on the denylist passes through unchanged.
 *
 * Callers must explicitly re-add back only the credential(s) this specific
 * harness/session actually needs.
 */
export function buildHarnessBaseEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (isKnownProviderCredentialVar(key)) continue
    env[key] = value
  }
  return env
}
