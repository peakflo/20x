/**
 * Secret hygiene for the runner client.
 *
 * Two jobs:
 *  1. `scrubForLog` — anything that is logged is passed through here first.
 *  2. `assertRequestBodySafe` — a last line of defence on every outgoing
 *     request body. The request builders already use explicit allowlists; this
 *     catches a regression that would copy local config into a body.
 */

/** Keys that hold local-only configuration and must never reach a runner. */
const FORBIDDEN_KEYS = new Set([
  'secretenvvars',
  'secretbrokerport',
  'secretsessiontoken',
  'secretshellpath',
  'mcpservers',
  'apikeys',
  'harnesshome',
  'env',
  'environment'
])

/** Free text typed by the user may legitimately mention localhost. */
const FREE_TEXT_KEYS = new Set(['message', 'content', 'title', 'description', 'answer'])

const LOCAL_BROKER_URL = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/i
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g
const KEY_VALUE = /\b((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^\s"',}]{6,})/gi

/** Redacts bearer tokens, JWTs, key=value secrets and any known secret value. */
export function scrubForLog(input: unknown, knownSecrets: Iterable<string> = []): string {
  let text: string
  if (typeof input === 'string') text = input
  else if (input instanceof Error) text = input.message
  else {
    try { text = JSON.stringify(input) ?? String(input) } catch { text = String(input) }
  }
  text = text.replace(BEARER, 'Bearer [redacted]').replace(JWT, '[redacted-jwt]').replace(KEY_VALUE, '$1[redacted]')
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) text = text.split(secret).join('[redacted]')
  }
  return text
}

export class UnsafeRunnerRequestError extends Error {
  constructor(reason: string) {
    super(`Refusing to send request to a runner: ${reason}`)
    this.name = 'UnsafeRunnerRequestError'
  }
}

function* walk(value: unknown, path: string, depth = 0): Generator<{ path: string; key?: string; value: unknown }> {
  if (value === null || typeof value !== 'object') return
  // Too deep to inspect is too deep to trust: refuse rather than skip.
  if (depth > 8) throw new UnsafeRunnerRequestError(`field ${path} is nested too deeply to verify`)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      yield { path: `${path}[${i}]`, value: value[i] }
      yield* walk(value[i], `${path}[${i}]`, depth + 1)
    }
    return
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    yield { path: `${path}.${key}`, key, value: v }
    yield* walk(v, `${path}.${key}`, depth + 1)
  }
}

/**
 * Throws when `body` carries a local-only key, a local broker/proxy URL, or the
 * value of a known local secret. `knownSecrets` are values held in memory only
 * (never logged or persisted by this module).
 */
export function assertRequestBodySafe(body: unknown, knownSecrets: Iterable<string> = []): void {
  if (body === undefined || body === null) return
  const secrets = [...knownSecrets].filter((s) => s && s.length >= 6)
  for (const { path, key, value } of walk(body, 'body')) {
    if (key && FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new UnsafeRunnerRequestError(`field ${path} is local-only configuration`)
    }
    if (typeof value === 'string') {
      if (!(key && FREE_TEXT_KEYS.has(key.toLowerCase())) && LOCAL_BROKER_URL.test(value)) throw new UnsafeRunnerRequestError(`field ${path} contains a local broker/proxy URL`)
      for (const s of secrets) {
        if (value.includes(s)) throw new UnsafeRunnerRequestError(`field ${path} contains a local secret value`)
      }
    }
  }
  if (typeof body === 'string') {
    for (const s of secrets) if (body.includes(s)) throw new UnsafeRunnerRequestError('body contains a local secret value')
  }
}

/**
 * Removes URLs of local services (secret broker, local MCP servers) from text
 * that is sent to a runner. Only the given ports are touched, so a user can
 * still mention `localhost:3000`.
 */
export function redactLocalServices(text: string, ports: Iterable<number>): string {
  let out = text
  for (const port of ports) {
    const re = new RegExp(`(?:https?:\\/\\/)?(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}\\b[^\\s"')\\]]*`, 'gi')
    out = out.replace(re, '[local service removed]')
  }
  return out
}
