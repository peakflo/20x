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
$envFile = $args[0]
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^([^=]+)=([\\s\\S]*)$') {
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
  }
}
$rest = $args[1..($args.Count - 1)]
& $rest[0] $rest[1..($rest.Count - 1)]
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

  if (isWin) {
    const envFile = join(dir, `${serverId}.env.txt`)
    const lines = Object.entries(env)
      .map(([k, v]) => `${k}=${v.replace(/\r?\n/g, ' ')}`)
      .join('\n')
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
  const lines = Object.entries(env)
    .map(([k, v]) => `export ${k}='${shellEscapeSingleQuote(v)}'`)
    .join('\n')
  writeFileSync(envFile, lines + '\n', 'utf-8')
  chmodSync(envFile, 0o600)

  return { command: wrapperPath, args: [envFile, command, ...args] }
}
