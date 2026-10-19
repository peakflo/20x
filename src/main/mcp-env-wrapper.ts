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

import { writeFileSync, chmodSync, mkdirSync, existsSync } from 'fs'
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

function ensureLoaderScript(dir: string, isWin: boolean): string {
  const wrapperPath = join(dir, isWin ? 'mcp-env-loader.ps1' : 'mcp-env-loader.sh')
  if (!existsSync(wrapperPath)) {
    writeFileSync(wrapperPath, isWin ? WINDOWS_LOADER : POSIX_LOADER, 'utf-8')
    if (!isWin) chmodSync(wrapperPath, 0o755)
  }
  return wrapperPath
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
