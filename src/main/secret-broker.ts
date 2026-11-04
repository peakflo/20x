/**
 * Secret Broker — local HTTP server for secure secret injection.
 *
 * Runs in the Electron main process, listens on 127.0.0.1:{random port} only.
 * A harness-specific hook/plugin (the PreToolUse hook in claude-code-adapter.ts,
 * the OpenCode plugin in opencode-adapter.ts) rewrites the single command about
 * to run into a tiny loader call that fetches this session's secrets from the
 * broker and `eval`s the result — so the exported values live only inside that
 * one command's own shell process, never in the agent's own process env, never
 * in a file in the workspace, and never as a literal value in the command text
 * that gets shown in the transcript.
 *
 * Flow (per Bash/shell tool call, not per session):
 *   1. Agent session starts → registerSecretSession(token, agentId, secretIds)
 *   2. The hook/plugin rewrites `command` to:
 *        eval "$(<secret-loader.sh> <port> <token>)"
 *        <original command>
 *   3. The loader calls GET /secrets/export with `Authorization: Bearer <token>`
 *   4. Broker decrypts secrets from SQLite, returns `export KEY='val'` lines
 *   5. The subshell `eval`s them, then the original command runs with the
 *      secrets in ITS OWN env only — nothing else on the machine ever sees them
 *   6. Session ends → unregisterSecretSession(token) — the token stops working
 *      immediately, even if it leaked into a log somewhere
 *
 * The broker token itself (not a user secret — an ephemeral, per-session,
 * loopback-only, revoked-on-end capability) is allowed to appear in the
 * command text the loader line shows — the guarantee this module exists for
 * is that no *secret value* ever does.
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from 'http'
import { writeFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createHash, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import type { DatabaseManager } from './database'

let server: HttpServer | null = null
let port: number | null = null
let dbRef: DatabaseManager | null = null

// SHA-256(token) hex → { agentId, secretIds }. Keyed by hash, never by the
// raw token, so a lookup never has to branch on the token's own bytes.
const activeSessions = new Map<string, { agentId: string; secretIds: string[] }>()

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/**
 * Constant-time membership check: every registered session's digest is
 * compared against the candidate with `timingSafeEqual` (itself constant-time
 * for equal-length buffers, which SHA-256 digests always are), and every
 * entry is checked regardless of an earlier match — so the total time taken
 * depends only on how many sessions are registered, never on how close a
 * wrong guess got.
 */
function findSessionForToken(token: string): { agentId: string; secretIds: string[] } | null {
  const candidate = hashToken(token)
  let found: { agentId: string; secretIds: string[] } | null = null
  for (const [digestHex, session] of activeSessions) {
    if (timingSafeEqual(candidate, Buffer.from(digestHex, 'hex'))) found = session
  }
  return found
}

function readBearerToken(authHeader: string | string[] | undefined): string | null {
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

export function getSecretBrokerPort(): number | null {
  return port
}

export function registerSecretSession(token: string, agentId: string, secretIds: string[]): void {
  activeSessions.set(hashToken(token).toString('hex'), { agentId, secretIds })
  console.log(`[SecretBroker] Registered session for agent ${agentId} with ${secretIds.length} secret(s)`)
}

/** Revokes a token immediately — called on every session-ending path (stop/destroy/cleanup). */
export function unregisterSecretSession(token: string): void {
  activeSessions.delete(hashToken(token).toString('hex'))
}

export function startSecretBroker(db: DatabaseManager): Promise<number> {
  if (server && port) return Promise.resolve(port)
  dbRef = db

  return new Promise((resolve, reject) => {
    server = createServer((req: IncomingMessage, res) => {
      const url = new URL(req.url || '/', 'http://localhost')

      if (url.pathname === '/secrets/export') {
        const token = readBearerToken(req.headers.authorization)
        const session = token ? findSessionForToken(token) : null
        if (!session) {
          res.writeHead(403, { 'Content-Type': 'text/plain' })
          res.end('')
          return
        }

        if (!dbRef) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('')
          return
        }

        const secrets = dbRef.getSecretsWithValues(session.secretIds)
        // Names and a count only — never values, never the request itself.
        console.log(`[SecretBroker] Served ${secrets.length} secret(s) to agent ${session.agentId}: [${secrets.map((s) => s.env_var_name).join(', ')}]`)

        // Single-quote values and escape embedded single quotes.
        const exports = secrets
          .map((s) => `export ${s.env_var_name}='${s.value.replace(/'/g, "'\\''")}'`)
          .join('\n')

        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(exports)
        return
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('')
    })

    // Listen on random available port, loopback only.
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (typeof addr === 'object' && addr) {
        port = addr.port
        console.log(`[SecretBroker] Started on port ${port}`)
        resolve(port)
      } else {
        reject(new Error('Failed to get secret broker address'))
      }
    })

    server.on('error', reject)
  })
}

export function stopSecretBroker(): void {
  if (server) {
    server.close()
    server = null
    port = null
  }
  activeSessions.clear()
}

function secretLoaderDir(): string {
  const dir = join(app.getPath('userData'), 'secret-loader')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

// Takes (port, tokenFilePath) as plain arguments — NOT the token itself.
// P1, re-review: the token used to be passed as a plain argument, which put
// it in two places it didn't need to be: the loader subprocess's own argv
// (readable via `ps -ef`/`ps eww`/`/proc/*/cmdline`), and — one level up —
// the WRAPPED command's own text (`updatedInput`/OpenCode's persisted
// `args.command`), visible in the transcript. It's not a user secret (an
// ephemeral, loopback-only, revoked-on-session-end capability token), but
// there's no reason to spend that exposure either, so it's now read from a
// 0600 file instead (see `writeSecretTokenFile`) — the command text and
// this script's own argv carry only a PATH.
//
// Forwarded to curl via `-H @-` (stdin), not `-H "Authorization: ..."` —
// otherwise the token would still land in CURL's OWN argv even though it
// never touches this script's argv. `$(cat "$tokenfile")` strips the
// trailing newline the file is written with (POSIX command substitution
// always does), so the header value is exact.
//
// Stdout carries ONLY the broker's `export` lines (or nothing) — the
// channel the caller's `eval "$(...)"` captures and runs — so a secret
// value is the only thing that can ever reach the command it's injected
// into. Never enables `-x`. Fails closed on any error: nothing is
// exported, the original command still runs (just without secrets), and a
// one-line diagnostic goes to STDERR — `eval "$(...)"` only captures
// STDOUT, so this reaches the WRAPPED command's own stderr (caller must
// not redirect it away — see the `2>/dev/null` removal at the call sites,
// another P2 re-review finding), which the Bash tool surfaces like any
// other stderr output instead of failing completely silently.
//
// `#!/bin/sh`, not `#!/bin/bash` — no bash-specific syntax is used, and sh
// is universally present (including Git Bash on Windows, which this script
// now always targets — see writeSecretLoaderScript's docstring).
const POSIX_LOADER = `#!/bin/sh
port="$1"
tokenfile="$2"
if [ -z "$port" ] || [ -z "$tokenfile" ]; then
  echo "20x secret-loader: missing port/token-file — failing closed, no secrets available" >&2
  exit 1
fi
if [ ! -f "$tokenfile" ]; then
  echo "20x secret-loader: token file not found — failing closed, no secrets available" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "20x secret-loader: curl not found on PATH — failing closed, no secrets available" >&2
  exit 1
fi
if ! printf 'Authorization: Bearer %s' "$(cat "$tokenfile")" | curl -sf --max-time 3 -H @- "http://127.0.0.1:$port/secrets/export"; then
  echo "20x secret-loader: could not reach the secret broker at 127.0.0.1:$port within 3s — failing closed, no secrets available" >&2
  exit 1
fi
`

// P1 finding, re-review: a separate WINDOWS_LOADER (.ps1) used to be
// selected whenever `process.platform === 'win32'`, on the assumption some
// future caller would invoke it through PowerShell. No caller ever has —
// every current one (Claude Code's PreToolUse hook, OpenCode's generated
// plugin) builds the exact same `eval "$(<loaderPath> <port> <tokenFile>)"`
// POSIX construct regardless of host OS, because both harnesses' Bash tool
// runs through Git Bash on Windows, not PowerShell or cmd.exe. Git Bash's
// `eval "$(...)"` has no idea how to run a `.ps1` file — it would try to
// execute it directly as a shell script and fail (or, with `2>/dev/null`
// swallowing the error, silently produce nothing), so a Windows Claude Code
// session lost secret delivery entirely despite the loader path being set.
// Removed rather than kept as unreachable dead code — `writeSecretLoaderScript`
// below now always writes the POSIX script, on every platform.

/**
 * Writes the shared secret-loader script (shared by every session and
 * every harness that wraps a command with it) and returns its path.
 * Callers build the command-text invocation themselves:
 * `eval "$(<loaderPath> <port> <tokenFilePath>)"` (see `writeSecretTokenFile`
 * below for the token half of that).
 *
 * ALWAYS the POSIX script, even on Windows — see WINDOWS_LOADER's docstring
 * above for why `process.platform` is not the right thing to switch on
 * here. Content-compared and rewritten on a mismatch (not just written
 * once when missing) — a fix to this script's own source must actually
 * reach a user whose app already wrote an older version of the file.
 */
export function writeSecretLoaderScript(): string {
  const dir = secretLoaderDir()
  const loaderPath = join(dir, 'secret-loader.sh')
  const current = existsSync(loaderPath) ? readFileSync(loaderPath, 'utf-8') : null
  if (current !== POSIX_LOADER) {
    writeFileSync(loaderPath, POSIX_LOADER, 'utf-8')
    chmodSync(loaderPath, 0o755)
  }
  return loaderPath
}

function secretTokenDir(): string {
  const dir = join(app.getPath('userData'), 'secret-tokens')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * Writes `token` to a 0600 file outside the workspace and returns its path
 * — what the loader invocation embeds in the command text instead of the
 * token itself (see `POSIX_LOADER`'s docstring and `SessionConfig.secretTokenFilePath`
 * for the full reasoning). Named by a hash of the token's own bytes, not
 * anything session-identifying, so repeated calls for the SAME token
 * overwrite the same file (no buildup) while two different tokens never
 * collide.
 */
export function writeSecretTokenFile(token: string): string {
  const dir = secretTokenDir()
  const name = createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32)
  const path = join(dir, `${name}.token`)
  // Re-review (round 3, Minor): mode set at creation time, not via a
  // separate chmod call afterward — write-then-chmod leaves a brief window
  // where the file exists with default (umask-dependent, often
  // world/group-readable) permissions before the chmod call narrows it,
  // during which another local user could read the token.
  writeFileSync(path, token, { encoding: 'utf-8', mode: 0o600 })
  return path
}

/**
 * Deletes the token file for `token`, written by `writeSecretTokenFile` —
 * call when the session that owns the token ends (alongside
 * `unregisterSecretSession`). Recomputes the same hash-derived path rather
 * than requiring the caller to have kept it around. Safe to call when the
 * file doesn't exist.
 */
export function deleteSecretTokenFile(token: string): void {
  const dir = secretTokenDir()
  const name = createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32)
  const path = join(dir, `${name}.token`)
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // Best-effort.
  }
}

/**
 * Deletes every leftover token file from a previous run — call once at app
 * startup, before any session starts (same pattern as
 * `cleanupStaleLocalMcpEnvFiles` in mcp-env-wrapper.ts). The broker's own
 * `activeSessions` map starts empty on every app launch, so a token file on
 * disk at startup can never correspond to a session this process actually
 * knows about — it's definitely stale, most commonly left behind by a force
 * quit or crash that skipped `deleteSecretTokenFile`. Minor finding,
 * re-review (round 3): nothing previously swept these up.
 */
export function cleanupStaleSecretTokenFiles(): void {
  const dir = secretTokenDir()
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.token')) continue
    try {
      const path = join(dir, entry)
      if (statSync(path).isFile()) unlinkSync(path)
    } catch {
      // Best-effort.
    }
  }
}

/** Shell-quotes a command-line argument for the loader invocation. Single-quote, escape embedded single quotes — same convention as the export lines above. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
