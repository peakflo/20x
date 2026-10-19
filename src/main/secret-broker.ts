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
import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'fs'
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

// Takes (port, token) as plain arguments — no file, no env var, nothing
// written to disk per session. Stdout carries ONLY the broker's `export`
// lines (or nothing) — the channel the caller's `eval "$(...)"` captures and
// runs — so a secret value is the only thing that can ever reach the
// command it's injected into. Never enables `-x`. Fails closed on any
// error: nothing is exported, the original command still runs (just without
// secrets), and a one-line diagnostic goes to STDERR, which `eval "$(...)"`
// does NOT capture — it reaches the harness's own stderr/log, not the
// command's captured stdout or the transcript the model sees as output.
const POSIX_LOADER = `#!/bin/bash
port="$1"
token="$2"
if [ -z "$port" ] || [ -z "$token" ]; then
  echo "20x secret-loader: missing port/token — failing closed, no secrets available" >&2
  exit 1
fi
if ! curl -sf -H "Authorization: Bearer $token" "http://127.0.0.1:$port/secrets/export"; then
  echo "20x secret-loader: could not reach the secret broker at 127.0.0.1:$port — failing closed, no secrets available" >&2
  exit 1
fi
`

// Windows equivalent, for harnesses/paths that invoke the loader through
// PowerShell rather than a POSIX shell (currently none do — kept for parity
// and so a future Windows-side caller does not have to reinvent this).
const WINDOWS_LOADER = `param([string]$Port, [string]$Token)
if (-not $Port -or -not $Token) {
  Write-Error "20x secret-loader: missing port/token — failing closed, no secrets available"
  exit 1
}
try {
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/secrets/export" -Headers @{ Authorization = "Bearer $Token" } -UseBasicParsing -TimeoutSec 5
  Write-Output $response.Content
} catch {
  Write-Error "20x secret-loader: could not reach the secret broker at 127.0.0.1:$Port — failing closed, no secrets available"
  exit 1
}
`

/**
 * Writes the shared secret-loader script (idempotent — written once, shared
 * by every session and every harness that wraps a command with it) and
 * returns its path. Callers build the command-text invocation themselves:
 * `eval "$(<loaderPath> <port> <token>)"`.
 */
export function writeSecretLoaderScript(): string {
  const dir = secretLoaderDir()
  const isWin = process.platform === 'win32'
  const loaderPath = join(dir, isWin ? 'secret-loader.ps1' : 'secret-loader.sh')
  if (!existsSync(loaderPath)) {
    writeFileSync(loaderPath, isWin ? WINDOWS_LOADER : POSIX_LOADER, 'utf-8')
    if (!isWin) chmodSync(loaderPath, 0o755)
  }
  return loaderPath
}

/** Shell-quotes a command-line argument for the loader invocation (the token). Single-quote, escape embedded single quotes — same convention as the export lines above. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
