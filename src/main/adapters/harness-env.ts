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

/**
 * Named provider-credential env vars 20x explicitly knows about. Kept as an
 * explicit list (rather than relying on the pattern match below alone) so
 * code that needs to re-add ONE specific credential by name has a typed,
 * documented set to reference — not because the pattern match wouldn't also
 * catch these (it does; every name here also matches `CREDENTIAL_SUFFIX_RE`).
 */
export const KNOWN_PROVIDER_CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENCODE_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'PEAKFLO_AI_GATEWAY_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'TOGETHER_API_KEY',
  'PERPLEXITY_API_KEY',
  'XAI_API_KEY',
  'COHERE_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_KEY',
  'NPM_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN'
] as const

export type KnownProviderCredentialEnvVar = (typeof KNOWN_PROVIDER_CREDENTIAL_ENV_VARS)[number]

const CREDENTIAL_SET: ReadonlySet<string> = new Set(KNOWN_PROVIDER_CREDENTIAL_ENV_VARS)

/**
 * Catches credential-shaped env vars by NAME PATTERN, not just the explicit
 * list above — so a provider 20x doesn't have a named constant for yet
 * (a new LLM vendor's `*_API_KEY`, a CI token, a registry `*_TOKEN`) is
 * stripped from agent envs by default instead of silently passing through
 * `{ ...process.env }` until someone remembers to add it by name.
 */
const CREDENTIAL_SUFFIX_RE = /(?:_API_KEY|_TOKEN|_SECRET(?:_KEY)?|_ACCESS_KEY|_PASSWORD|_CLIENT_SECRET)$/i

/**
 * Functional env vars that must always pass through even if a future
 * credential-shaped name coincidentally matches `CREDENTIAL_SUFFIX_RE`.
 * None of these currently match the pattern — this is a defensive allowlist,
 * checked first, so a pattern tweak can never regress one of these by
 * accident.
 */
const ALWAYS_PRESERVE = new Set([
  'PATH',
  'HOME',
  'LANG',
  'SSH_AUTH_SOCK',
  'NODE_EXTRA_CA_CERTS',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  // Claude Code's OWN inter-process messaging token for ITS spawned child
  // sessions — only ever present when 20x itself happens to be running
  // inside a Claude Code session (dogfooding/dev, not real end-user usage).
  // It's infra plumbing, not a provider credential, but its name matches
  // the generic `*_TOKEN` suffix pattern below, so it needs an explicit
  // carve-out rather than silently falling through.
  'CLAUDE_CODE_MESSAGING_TOKEN'
])

function isAlwaysPreserved(name: string): boolean {
  if (ALWAYS_PRESERVE.has(name)) return true
  // LC_* locale vars (LC_ALL, LC_CTYPE, ...) and HTTP(S)_PROXY / NO_PROXY /
  // *_proxy variants — functional, never credentials.
  if (/^LC_/.test(name)) return true
  if (/^(?:HTTPS?|NO|ALL)_PROXY$/i.test(name) || /^(?:https?|no|all)_proxy$/.test(name)) return true
  return false
}

/**
 * True for any env var name that is a known provider credential by exact
 * name OR by credential-shaped suffix pattern (see `CREDENTIAL_SUFFIX_RE`),
 * unless it's on the functional-vars allowlist.
 *
 * Note this now also strips `GITHUB_TOKEN`/`GH_TOKEN` and
 * `AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` from the ambient env handed to
 * every agent process. That is a deliberate behavior change from "pass
 * everything through": those are real credentials agents sometimes use to
 * drive `gh`/`aws` CLIs as part of their actual task, not just other
 * harnesses' LLM keys, so stripping them can break agents that previously
 * relied on inheriting them from the login shell. Agents that need `gh`/`aws`
 * CLI access should get that credential as an explicit per-agent secret
 * (`config.secretEnvVars`) instead of ambient inheritance — which also means
 * the value is registered with the session's SecretScrubber and redacted if
 * it ever appears in output, unlike silent ambient passthrough. See the PR
 * description for the product tradeoff this encodes.
 */
export function isKnownProviderCredentialVar(name: string): boolean {
  if (isAlwaysPreserved(name)) return false
  if (CREDENTIAL_SET.has(name)) return true
  return CREDENTIAL_SUFFIX_RE.test(name)
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

/** Minimal shape needed to register a value with a session's scrubber — avoids importing the concrete `SecretScrubber` class here just for a type. */
export interface ScrubberLike {
  addEntries(entries: Array<{ name?: string; value: string }>): void
}

/**
 * Re-adds back, from `source` (defaults to `process.env`), each of `names`
 * that's actually present — for the specific ambient env vars a harness's
 * OWN auth mode needs that `buildHarnessBaseEnv` stripped as "just another
 * credential" (a Bedrock bearer token, a gateway auth token, a setup-token
 * flow, ...). Each re-added value is registered with `scrubber` too, so an
 * accidental echo of it is still caught — unlike the silent, unscrubbed
 * `{...process.env}` passthrough this whole module replaced.
 */
export function reAddAmbientCredentials(
  env: Record<string, string>,
  names: readonly string[],
  scrubber?: ScrubberLike,
  source: NodeJS.ProcessEnv = process.env
): void {
  for (const name of names) {
    const value = source[name]
    if (!value) continue
    env[name] = value
    scrubber?.addEntries([{ name, value }])
  }
}

/**
 * The per-agent "Pass shell credentials" opt-in (`AgentConfigRecord.pass_shell_credentials`,
 * threaded through as `SessionConfig.allowShellCredentials`) — a no-op
 * unless `allowed` is true. When the agent has opted in, re-adds EVERY
 * credential-shaped var the login shell has (not just the harness's own
 * named auth vars) — the escape hatch for an agent that genuinely drives
 * `gh`/`aws` CLIs (or anything else) via ambient shell credentials instead
 * of an explicit per-agent secret. Every value passed this way is
 * registered with `scrubber` too.
 */
export function applyShellCredentialsOptIn(
  env: Record<string, string>,
  allowed: boolean | undefined,
  scrubber?: ScrubberLike,
  source: NodeJS.ProcessEnv = process.env
): void {
  if (!allowed) return
  for (const [name, value] of Object.entries(source)) {
    if (!value || !isKnownProviderCredentialVar(name)) continue
    env[name] = value
    scrubber?.addEntries([{ name, value }])
  }
}
