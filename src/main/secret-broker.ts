/**
 * Secret Broker — local HTTP server for secure secret injection.
 *
 * Runs in the Electron main process, listens on 127.0.0.1:{random port}.
 * Agent shell wrappers call this to fetch decrypted secrets at command execution time.
 * Secrets never enter the agent process environment directly — only the broker
 * port and a per-session token are passed to the agent.
 *
 * Flow:
 *   1. Agent session starts → registerSecretSession(token, agentId, secretIds)
 *   2. Agent's SHELL is set to secret-shell.sh wrapper
 *   3. Wrapper calls GET /secrets/export?token=<token>
 *   4. Broker decrypts secrets from SQLite, returns export KEY='val' statements
 *   5. Wrapper evals exports, unsets broker vars, exec's real shell
 *   6. The real shell command runs with secrets in env — agent process never has them
 */

import { createServer, type Server as HttpServer } from 'http'
import { writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { DatabaseManager } from './database'

let server: HttpServer | null = null
let port: number | null = null
let dbRef: DatabaseManager | null = null

// session token → { agentId, secretIds }
const activeSessions = new Map<string, { agentId: string; secretIds: string[] }>()

export function getSecretBrokerPort(): number | null {
  return port
}

export function registerSecretSession(token: string, agentId: string, secretIds: string[]): void {
  activeSessions.set(token, { agentId, secretIds })
  console.log(`[SecretBroker] Registered session for agent ${agentId} with ${secretIds.length} secret(s)`)
}

export function unregisterSecretSession(token: string): void {
  activeSessions.delete(token)
}

export function startSecretBroker(db: DatabaseManager): Promise<number> {
  if (server && port) return Promise.resolve(port)
  dbRef = db

  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')

      if (url.pathname === '/secrets/export') {
        const token = url.searchParams.get('token')
        if (!token || !activeSessions.has(token)) {
          console.log(`[SecretBroker] 403 — invalid/missing token: ${token ? token.substring(0, 8) + '...' : 'null'}`)
          res.writeHead(403, { 'Content-Type': 'text/plain' })
          res.end('')
          return
        }

        const session = activeSessions.get(token)!
        if (!dbRef) {
          console.log('[SecretBroker] 500 — dbRef is null')
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('')
          return
        }

        console.log(`[SecretBroker] Fetching secrets for agent ${session.agentId}, secretIds: [${session.secretIds.join(', ')}]`)
        const secrets = dbRef.getSecretsWithValues(session.secretIds)
        console.log(`[SecretBroker] Found ${secrets.length} secret(s): [${secrets.map(s => `${s.env_var_name}(${s.value.length} chars)`).join(', ')}]`)

        // Return shell export statements
        // Single-quote values and escape embedded single quotes
        const exports = secrets
          .map(s => `export ${s.env_var_name}='${s.value.replace(/'/g, "'\\''")}'`)
          .join('\n')

        console.log(`[SecretBroker] Response body length: ${exports.length} bytes`)
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(exports)
        return
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('')
    })

    // Listen on random available port, loopback only
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

/**
 * Writes the secret shell wrapper script to the app's userData directory.
 * This script is set as $SHELL for agent processes — it transparently fetches
 * secrets from the broker before executing the real shell.
 *
 * Returns the absolute path to the wrapper script.
 */
export function writeSecretShellWrapper(): string {
  const shellPath = join(app.getPath('userData'), 'secret-shell.sh')

  const debugLog = join(app.getPath('userData'), 'secret-shell-debug.log')

  const script = `#!/bin/bash
# 20x Secret Shell Wrapper
# Fetches secrets from the local broker and injects them into the command environment.
# The agent process has _20X_SB_PORT and _20X_SB_TOKEN but NOT the actual secret values.

_real_shell="\${_20X_REAL_SHELL:-/bin/bash}"

# Fetch secrets from broker and export them
if [ -n "\$_20X_SB_PORT" ] && [ -n "\$_20X_SB_TOKEN" ]; then
  _20x_http_code=\$(curl -sf -o /tmp/_20x_secrets_body -w "%{http_code}" "http://127.0.0.1:\${_20X_SB_PORT}/secrets/export?token=\${_20X_SB_TOKEN}" 2>/dev/null)
  _20x_secrets=\$(cat /tmp/_20x_secrets_body 2>/dev/null)
  rm -f /tmp/_20x_secrets_body

  # Debug logging
  echo "[secret-shell \$(date '+%H:%M:%S')] port=\$_20X_SB_PORT http_code=\$_20x_http_code body_len=\${#_20x_secrets} args=\$*" >> "${debugLog}"

  if [ -n "\$_20x_secrets" ]; then
    eval "\$_20x_secrets"
  fi
  # Clean up broker vars so they don't leak into command output
  unset _20X_SB_PORT _20X_SB_TOKEN _20X_REAL_SHELL _20x_secrets _20x_http_code
fi

# Execute the real shell with original arguments
exec "\$_real_shell" "\$@"
`

  writeFileSync(shellPath, script, 'utf-8')
  chmodSync(shellPath, 0o755)
  console.log(`[SecretBroker] Wrote shell wrapper to ${shellPath}`)
  return shellPath
}
