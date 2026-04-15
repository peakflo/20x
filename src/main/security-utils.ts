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
 */
export function sanitizeEnvForChild(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env, ...extra } as Record<string, string>
  for (const key of SENSITIVE_ENV_VARS) {
    delete env[key]
  }
  return env
}

/**
 * Hostnames and IP patterns considered "local" or "private".
 * Used to block SSRF to internal services.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
])

/**
 * Check if an IP address falls within RFC-1918 private ranges or
 * other non-routable address spaces:
 *   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
 */
function isPrivateIP(ip: string): boolean {
  // IPv4 mapped in IPv6 — extract the v4 portion
  const v4Match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  const v4 = v4Match ? v4Match[1] : ip

  const parts = v4.split('.').map(Number)
  if (parts.length !== 4 || parts.some(isNaN)) return false

  const [a, b] = parts
  if (a === 10) return true                               // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true        // 172.16.0.0/12
  if (a === 192 && b === 168) return true                 // 192.168.0.0/16
  if (a === 169 && b === 254) return true                 // 169.254.0.0/16
  if (a === 127) return true                              // 127.0.0.0/8 (full loopback)
  if (a === 0) return true                                // 0.0.0.0/8

  return false
}

/**
 * Validate that a URL does not target localhost or private network addresses.
 * Returns `{ safe: true }` if the URL is acceptable, or `{ safe: false, reason }` if blocked.
 */
export function validateUrlNotLocal(url: string): { safe: boolean; reason?: string } {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()

    // Strip brackets from IPv6 addresses for checking
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
  /(?:sk|pk|rk|ak|xox[bpas])-[A-Za-z0-9_\-]{10,}/gi,      // API key prefixes (Stripe, Slack, etc.)
  /ghp_[A-Za-z0-9]{36}/gi,                                    // GitHub personal access tokens
  /gho_[A-Za-z0-9]{36}/gi,                                    // GitHub OAuth tokens
  /glpat-[A-Za-z0-9_\-]{20}/gi,                               // GitLab personal access tokens
]

/**
 * Redact potentially sensitive values from a string before logging.
 * Replaces matches with `[REDACTED]`.
 */
export function redactSensitiveData(input: string): string {
  let result = input
  for (const pattern of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0
    result = result.replace(pattern, '[REDACTED]')
  }
  return result
}
