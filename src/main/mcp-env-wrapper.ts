/**
 * Keeps local (stdio) MCP server secret env vars off argv.
 *
 * `McpServerRecord.environment` can carry real credential values a local MCP
 * server needs (a vendor API key, etc). The config object that carries it is,
 * for at least one harness, serialized verbatim onto that harness's spawned
 * CLI's argv (`--mcp-config <json>` — see the pinned
 * `@anthropic-ai/claude-agent-sdk`), which `ps -ef`/`ps eww` can read.
 *
 * Instead of putting `environment` directly into the mcpServers config, write
 * it to a 0600 file outside the workspace and wrap the real command in a tiny
 * loader that sources the file, then execs the original command unmodified.
 * The config (and argv) then carries only a file path, never a value.
 */

import { writeFileSync, chmodSync, mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface WrappedLocalMcpCommand {
  command: string
  args: string[]
}

function envDir(): string {
  const dir = join(app.getPath('userData'), 'mcp-env')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function shellEscapeSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''")
}

/** POSIX env-var-name shape: a letter/underscore followed by letters, digits, underscores. */
const VALID_ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Drops any entry whose key isn't a plausible env var name instead of
 * writing it to the loader file. Defense in depth: every call site today
 * sources `env` from server-config fields the user themselves typed, but a
 * malformed/injected key (e.g. containing `=`, a newline, or control
 * characters) could otherwise corrupt the line-based "NAME=value" format
 * both loaders parse and smuggle extra lines/vars past the intended entry.
 */
function sanitizeEnvEntries(env: Record<string, string>): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (const [key, value] of Object.entries(env)) {
    if (!VALID_ENV_VAR_NAME.test(key)) {
      console.warn(`[McpEnvWrapper] Skipping local MCP env var with invalid name: ${JSON.stringify(key)}`)
      continue
    }
    entries.push([key, value])
  }
  return entries
}

const POSIX_LOADER = `#!/bin/bash
# 20x MCP local-server env loader.
# Sources a 0600 env file (first arg) then execs the real command (remaining
# args) unmodified. Prints nothing on the happy path and never enables -x —
# the whole point is that this process's env vars never show up anywhere.
envfile="$1"
shift
if [ -n "$envfile" ] && [ -f "$envfile" ]; then
  . "$envfile"
fi
exec "$@"
`

const WINDOWS_LOADER = `# 20x MCP local-server env loader (PowerShell).
# Each line of the env file is "NAME=<base64>" — the value is base64-encoded
# so this loader never has to guess a text encoding and embedded newlines
# (e.g. a PEM private key) survive round-trip instead of being flattened to
# spaces by the writer or split across lines by the reader.
$envFile = $args[0]
if (Test-Path $envFile) {
  Get-Content -LiteralPath $envFile -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') {
      $name = $Matches[1]
      $bytes = [Convert]::FromBase64String($Matches[2])
      $value = [System.Text.Encoding]::UTF8.GetString($bytes)
      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}
# The inner slice below is guarded explicitly instead of being taken
# unconditionally: when there are zero trailing args (just the command, no
# arguments to it), slicing from index 1 to (Count - 1) with Count equal to 1
# produces a DESCENDING range whose first element is out of bounds (silently
# $null in PowerShell) and whose second element duplicates the command itself
# — corrupting the argument list instead of producing an empty one. Splatting
# with @ (not a bare array variable) also matters: PowerShell passes a bare
# array variable as a single argument, not one argument per element.
if ($args.Count -lt 2) {
  Write-Error '20x MCP env loader: no command given'
  exit 1
}
$rest = $args[1..($args.Count - 1)]
$cmd = $rest[0]
if ($rest.Count -gt 1) {
  $cmdArgs = @($rest[1..($rest.Count - 1)])
} else {
  $cmdArgs = @()
}
& $cmd @cmdArgs
exit $LASTEXITCODE
`

/**
 * Minor finding, re-review: writing the loader only when the file is
 * MISSING means a user who already had an older version of 20x write this
 * file once never gets a fix to the loader's own source — including fixes
 * like the Windows arg-slicing bug fixed in this same PR — since the file
 * already exists and is never re-examined. Compare content instead of just
 * presence, and rewrite whenever it doesn't match exactly (covers "missing"
 * and "changed" in the same check, with nothing extra to version by hand).
 */
function ensureLoaderScript(dir: string, isWin: boolean): string {
  const wrapperPath = join(dir, isWin ? 'mcp-env-loader.ps1' : 'mcp-env-loader.sh')
  const expected = isWin ? WINDOWS_LOADER : POSIX_LOADER
  const current = existsSync(wrapperPath) ? readFileSync(wrapperPath, 'utf-8') : null
  if (current !== expected) {
    writeFileSync(wrapperPath, expected, 'utf-8')
    if (!isWin) chmodSync(wrapperPath, 0o755)
  }
  return wrapperPath
}

/**
 * `serverId` shape 20x's own `createId()` always produces — validated
 * before use in a filename as defense in depth (every call site today
 * passes a DB row id, never raw user input, but a malformed/unexpected id
 * must not be allowed to construct a path outside `envDir()`, e.g. via a
 * `../` segment).
 */
const VALID_SERVER_ID_RE = /^[A-Za-z0-9_-]+$/

function envFilePaths(dir: string, serverId: string): string[] {
  return [join(dir, `${serverId}.env.sh`), join(dir, `${serverId}.env.txt`)]
}

/**
 * Deletes the env file for one MCP server row (both the POSIX and Windows
 * variants, in case the platform changed since it was written) — call when
 * that server's last live session ends. Best-effort: if another live
 * session still uses the same server row, its own next
 * `writeLocalMcpEnvWrapper` call (every prompt rebuilds the MCP config)
 * recreates the file — the same self-healing behavior the per-call
 * overwrite below already relies on for secret rotation.
 */
export function cleanupLocalMcpEnvFile(serverId: string): void {
  if (!VALID_SERVER_ID_RE.test(serverId)) return
  const dir = join(app.getPath('userData'), 'mcp-env')
  for (const path of envFilePaths(dir, serverId)) {
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      // Best-effort — a locked/missing file here isn't worth failing over.
    }
  }
}

/**
 * Deletes every leftover local-MCP env file from a previous run — call once
 * at app startup, before any session starts. Nothing persists these
 * registrations across an app restart (every session re-resolves and
 * rewrites its MCP config on its first prompt), so anything already on disk
 * at startup is definitely stale — most commonly left behind by a force
 * quit or crash that skipped the per-session cleanup above. The loader
 * scripts themselves (`mcp-env-loader.sh`/`.ps1`) are untouched — shared,
 * content-checked and rewritten on demand by `ensureLoaderScript`.
 */
export function cleanupStaleLocalMcpEnvFiles(): void {
  const dir = join(app.getPath('userData'), 'mcp-env')
  if (!existsSync(dir)) return
  let removed = 0
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.env.sh') && !entry.endsWith('.env.txt')) continue
    try {
      const path = join(dir, entry)
      if (statSync(path).isFile()) {
        unlinkSync(path)
        removed += 1
      }
    } catch {
      // Best-effort.
    }
  }
  if (removed > 0) console.log(`[McpEnvWrapper] Removed ${removed} stale local-MCP env file(s) from a previous run`)
}

/**
 * Writes `env` to a 0600 file and returns a `{command, args}` pair that, when
 * spawned, sources that file then execs the original `command`/`args`
 * unmodified. `serverId` scopes the env-file name — each call overwrites it,
 * so secret rotation takes effect the next time the MCP server (re)starts,
 * no app restart needed. Returns the original `{command, args}` unmodified
 * when `env` is empty — no wrapper indirection when there's nothing to hide.
 */
export function writeLocalMcpEnvWrapper(
  serverId: string,
  command: string,
  args: string[],
  env: Record<string, string>
): WrappedLocalMcpCommand {
  if (Object.keys(env).length === 0) return { command, args }
  if (!VALID_SERVER_ID_RE.test(serverId)) {
    throw new Error(`[McpEnvWrapper] Refusing to build a local MCP env wrapper for an unexpected server id: ${JSON.stringify(serverId)}`)
  }

  const isWin = process.platform === 'win32'
  const dir = envDir()
  const wrapperPath = ensureLoaderScript(dir, isWin)

  const sanitized = sanitizeEnvEntries(env)

  if (isWin) {
    const envFile = join(dir, `${serverId}.env.txt`)
    // Base64-encode every value: the loader otherwise has to guess a text
    // encoding for Get-Content, and a value containing a real newline (a PEM
    // private key, a multi-line token) would either get flattened to spaces
    // on write or split across multiple garbage lines on read. Base64 is
    // pure ASCII and round-trips exactly regardless of either.
    const lines = sanitized.map(([k, v]) => `${k}=${Buffer.from(v, 'utf-8').toString('base64')}`).join('\n')
    writeFileSync(envFile, lines + '\n', 'utf-8')
    try {
      chmodSync(envFile, 0o600)
    } catch {
      // Windows ACLs don't map cleanly to POSIX chmod bits — best-effort only.
    }
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath, envFile, command, ...args]
    }
  }

  const envFile = join(dir, `${serverId}.env.sh`)
  const lines = sanitized.map(([k, v]) => `export ${k}='${shellEscapeSingleQuote(v)}'`).join('\n')
  writeFileSync(envFile, lines + '\n', 'utf-8')
  chmodSync(envFile, 0o600)

  return { command: wrapperPath, args: [envFile, command, ...args] }
}
