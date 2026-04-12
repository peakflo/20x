/**
 * Security utilities for defense-in-depth hardening.
 *
 * - Strips sensitive env vars from child process environments
 * - Validates URLs to block SSRF against localhost / private networks
 * - Redacts sensitive content from log output
 */

/**
 * Environment variable names that must never be forwarded to child processes.
 * Includes Secret Broker credentials and other sensitive internal vars.
 */
const SENSITIVE_ENV_VARS = [
  '_20X_SB_PORT',
  '_20X_SB_TOKEN',
  '_20X_REAL_SHELL',
]

/**
 * Create a sanitized copy of process.env with sensitive vars removed.
 * Use this instead of `{ ...process.env }` when spawning child processes.
 * @param {Record<string, string>} extra
 * @returns {Record<string, string>}
 */
export function sanitizeEnvForChild(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const key of SENSITIVE_ENV_VARS) {
    delete env[key]
  }
  return env
}

/**
 * Hostnames and IP patterns considered "local" or "private".
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
])

/**
 * Check if an IP address falls within RFC-1918 private ranges.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIP(ip) {
  const v4Match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  const v4 = v4Match ? v4Match[1] : ip

  const parts = v4.split('.').map(Number)
  if (parts.length !== 4 || parts.some(isNaN)) return false

  const [a, b] = parts
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 127) return true
  if (a === 0) return true

  return false
}

/**
 * Validate that a URL does not target localhost or private network addresses.
 * @param {string} url
 * @returns {{ safe: boolean, reason?: string }}
 */
export function validateUrlNotLocal(url) {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()

    const bare = hostname.replace(/^\[|\]$/g, '')

    if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_HOSTNAMES.has(bare)) {
      return { safe: false, reason: `Blocked request to local address: ${hostname}` }
    }

    if (isPrivateIP(bare)) {
      return { safe: false, reason: `Blocked request to private IP: ${hostname}` }
    }

    return { safe: true }
  } catch {
    return { safe: false, reason: `Invalid URL: ${url}` }
  }
}

/**
 * Patterns that indicate sensitive data in log output.
 */
const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|token|secret|password|bearer|authorization|credential)["\s:=]+["']?[A-Za-z0-9_\-./+=]{8,}/gi,
  /(?:sk|pk|rk|ak|xox[bpas])-[A-Za-z0-9_\-]{10,}/gi,
  /ghp_[A-Za-z0-9]{36}/gi,
  /gho_[A-Za-z0-9]{36}/gi,
  /glpat-[A-Za-z0-9_\-]{20}/gi,
]

/**
 * Redact potentially sensitive values from a string before logging.
 * @param {string} input
 * @returns {string}
 */
export function redactSensitiveData(input) {
  let result = input
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, '[REDACTED]')
  }
  return result
}
