/**
 * The environment for the harness CLI child process.
 *
 * ALLOWLIST, not a copy of `process.env`: 20x's own environment can hold
 * provider keys, enterprise tokens, broker URLs and anything a user exported in
 * their shell profile. The CLI needs a PATH to find node/npm/git, a HOME for its
 * credential file and npm cache, and locale/terminal basics. Nothing else.
 *
 * A denylist pass runs on top of the allowlist as defence in depth, so a
 * future addition to the allowlist cannot smuggle a secret-looking variable in.
 */
const ALLOWED_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  // Corporate network setup the npm download may need.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS'
] as const

const SECRET_KEY = /(token|secret|password|passwd|credential|api[_-]?key|auth|bearer|session|cookie|private|jwt)/i
const SECRET_VALUE = /(\beyJ[A-Za-z0-9_-]{6,}\.|\bBearer\s|\b(?:sk|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{16,})/
const PROXY_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i

export function buildCleanEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ALLOWED_KEYS) {
    const value = parent[key]
    if (value === undefined || value === '') continue
    if (SECRET_KEY.test(key)) continue
    if (SECRET_VALUE.test(value)) continue
    // A proxy URL with embedded credentials is a secret in an unexpected place.
    if (/proxy/i.test(key) && PROXY_CREDENTIALS.test(value)) continue
    env[key] = value
  }
  // Quiet npm: no update nag, no funding or audit chatter in the progress.
  env.npm_config_update_notifier = 'false'
  env.npm_config_fund = 'false'
  env.npm_config_audit = 'false'
  return env
}

/** Names the child environment must never contain. Exported for tests. */
export function findSecretLookingKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => SECRET_KEY.test(key))
}
