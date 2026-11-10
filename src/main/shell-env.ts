import { spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Shell environment resolution for macOS GUI launches.
 *
 * macOS GUI apps (launched from /Applications) do NOT inherit the user's shell
 * environment, so CLI tools like codex, claude, gh etc. cannot be found and
 * auth env vars like CODEX_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY are
 * missing. We read the values from a login shell and apply them to process.env.
 *
 * We need the interactive shell (`-ilc`) because tools like NVM, pnpm, bun,
 * etc. add their paths in `.zshrc` / `.bashrc` (interactive config), NOT in
 * `.zprofile` / `.bash_profile` (login-only config). Interactive mode also
 * makes init scripts (oh-my-zsh, powerlevel10k, gitstatus, ...) emit escape
 * codes and prompt noise, so every value is wrapped in unique markers.
 *
 * CODEX_HOME: if the user's terminal `codex` uses a custom CODEX_HOME (e.g. a
 * work profile / a different ChatGPT account than ~/.codex), 20x must read the
 * SAME one — otherwise codex-acp authenticates as whatever account lives in the
 * default ~/.codex.
 */
export const SHELL_ENV_KEYS = ['PATH', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_HOME'] as const
export type ShellEnvKey = (typeof SHELL_ENV_KEYS)[number]
export type ShellEnvValues = Partial<Record<ShellEnvKey, string>>

/** Heavy ~/.zshrc setups (nvm, oh-my-zsh, p10k, conda, gcloud) can take >5s on a busy boot. */
export const SHELL_ENV_TIMEOUT_MS = 20_000

const startMarker = (key: ShellEnvKey): string => `__20X_${key}_START__`
const endMarker = (key: ShellEnvKey): string => `__20X_${key}_END__`

/** Shell snippet printing every key wrapped in markers (e.g. __20X_PATH_START__...__20X_PATH_END__). */
export function buildShellEnvCommand(): string {
  return SHELL_ENV_KEYS
    .map((key) => `printf '%s%s%s\\n' "${startMarker(key)}" "$${key}" "${endMarker(key)}"`)
    .join('; ')
}

/** Extracts marked values from (possibly noisy, possibly partial) shell output. */
export function parseShellEnvOutput(stdout: string): ShellEnvValues {
  const values: ShellEnvValues = {}
  for (const key of SHELL_ENV_KEYS) {
    const match = stdout.match(new RegExp(`${startMarker(key)}([\\s\\S]*?)${endMarker(key)}`))
    if (match?.[1]) values[key] = match[1]
  }
  return values
}

export interface ShellRunResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  error?: string
}

export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<ShellRunResult>

/** Spawns the shell with stdin ignored (so interactive init can't block on a TTY read). */
export const defaultShellRunner: ShellRunner = (shell, args, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (result: Omit<ShellRunResult, 'stdout' | 'stderr' | 'timedOut'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, timedOut, ...result })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Keep oh-my-zsh from prompting/updating and tmux plugins from hijacking the shell.
          DISABLE_AUTO_UPDATE: 'true',
          ZSH_TMUX_AUTOSTART: 'false'
        }
      })
    } catch (err) {
      resolve({ stdout, stderr, code: null, timedOut: false, error: (err as Error).message })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < 8192) stderr += chunk })
    child.on('error', (err) => finish({ code: null, error: err.message }))
    child.on('close', (code) => finish({ code }))
  })

export type ShellEnvResult =
  | { ok: true; values: ShellEnvValues; flags: string; durationMs: number; warning?: string }
  | { ok: false; reason: string; durationMs: number }

function describeFailure(res: ShellRunResult, timeoutMs: number): string {
  if (res.timedOut) return `timed out after ${timeoutMs}ms`
  if (res.error) return res.error
  const tail = res.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300)
  return `exit code ${res.code}${tail ? `: ${tail}` : ''} (PATH markers missing)`
}

/**
 * Reads the user's shell environment. Tries `-ilc` first, then retries once
 * with `-lc` (login only — skips a broken/slow .zshrc). Output is parsed even
 * when the shell exits non-zero or is killed, as long as the PATH marker made it.
 */
export async function readShellEnv(opts: {
  shell?: string
  timeoutMs?: number
  run?: ShellRunner
} = {}): Promise<ShellEnvResult> {
  const shell = opts.shell || process.env.SHELL || '/bin/zsh'
  const timeoutMs = opts.timeoutMs ?? SHELL_ENV_TIMEOUT_MS
  const run = opts.run ?? defaultShellRunner
  const command = buildShellEnvCommand()
  const started = Date.now()
  const reasons: string[] = []

  for (const flags of ['-ilc', '-lc']) {
    const res = await run(shell, [flags, command], timeoutMs)
    const values = parseShellEnvOutput(res.stdout)
    if (values.PATH) {
      const failed = res.timedOut || res.error || (res.code !== 0 && res.code !== null)
      return {
        ok: true,
        values,
        flags,
        durationMs: Date.now() - started,
        warning: failed ? describeFailure(res, timeoutMs) : undefined
      }
    }
    reasons.push(`${shell} ${flags}: ${describeFailure(res, timeoutMs)}`)
  }
  return { ok: false, reason: reasons.join('; '), durationMs: Date.now() - started }
}

/** Applies resolved shell values to process.env. PATH is required; others only when non-empty. */
export function applyShellEnv(values: ShellEnvValues, env: NodeJS.ProcessEnv = process.env): void {
  for (const key of SHELL_ENV_KEYS) {
    const value = values[key]
    if (value) env[key] = value
  }
}

// ── Fallback PATH ─────────────────────────────────────────────────────────

function compareVersionsDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true })
}

function listNvmVersions(nvmDir: string): string[] {
  try {
    return (readdirSync(join(nvmDir, 'versions', 'node')) as string[])
      .filter((v) => /^v\d/.test(v))
      .sort(compareVersionsDesc)
  } catch {
    return []
  }
}

/**
 * Resolves an nvm alias (contents of ~/.nvm/alias/default, e.g. "22", "lts/*",
 * "node", "stable", "v22.14.0", "lts/iron") to an installed version directory
 * name, or null. Follows alias files recursively like nvm does.
 */
export function resolveNvmAlias(nvmDir: string, alias: string, versions = listNvmVersions(nvmDir), depth = 0): string | null {
  const name = alias.trim()
  if (!name || depth > 10 || versions.length === 0) return null
  if (name === 'system') return null
  if (name === 'node' || name === 'stable') return versions[0]

  // Alias file (e.g. alias/lts/* -> "lts/jod", alias/lts/jod -> "v22.12.0", or a custom alias)
  const aliasFile = join(nvmDir, 'alias', name)
  if (!name.includes('..') && existsSync(aliasFile)) {
    try {
      const target = readFileSync(aliasFile, 'utf8').trim()
      if (target && target !== name) return resolveNvmAlias(nvmDir, target, versions, depth + 1)
    } catch {
      // unreadable alias — fall through to prefix matching
    }
  }

  if (name.startsWith('lts/')) return null
  const prefix = name.replace(/^v/, '')
  if (!/^\d+(\.\d+){0,2}$/.test(prefix)) return null
  return versions.find((v) => v === `v${prefix}` || v.startsWith(`v${prefix}.`)) ?? null
}

/** Bin dir of nvm's default Node (from alias/default), or null. */
export function getNvmDefaultBin(home: string, nvmDir = process.env.NVM_DIR || join(home, '.nvm')): string | null {
  try {
    const alias = readFileSync(join(nvmDir, 'alias', 'default'), 'utf8')
    const version = resolveNvmAlias(nvmDir, alias)
    return version ? join(nvmDir, 'versions', 'node', version, 'bin') : null
  } catch {
    return null
  }
}

/** Bin dir of the newest installed nvm Node, or null. */
export function getNvmNewestBin(home: string, nvmDir = process.env.NVM_DIR || join(home, '.nvm')): string | null {
  const versions = listNvmVersions(nvmDir)
  return versions.length > 0 ? join(nvmDir, 'versions', 'node', versions[0], 'bin') : null
}

export interface FallbackPathOptions {
  home?: string
  existingPath?: string
  nvmDir?: string
  exists?: (dir: string) => boolean
}

/**
 * Builds a fallback PATH when the shell can't be read. Version-manager Node
 * dirs come first so `#!/usr/bin/env node` scripts (codex, claude, ...) pick
 * the user's Node instead of a possibly-broken Homebrew node. Only existing
 * dirs are included; entries are deduped; the inherited PATH is appended.
 */
export function buildFallbackPath(opts: FallbackPathOptions = {}): string {
  const home = opts.home ?? process.env.HOME ?? ''
  const exists = opts.exists ?? existsSync
  const existingPath = opts.existingPath ?? process.env.PATH ?? ''
  const nvmDir = opts.nvmDir ?? (process.env.NVM_DIR || (home ? join(home, '.nvm') : ''))

  const candidates: Array<string | null> = []
  if (home) {
    candidates.push(
      // Node version managers
      nvmDir ? getNvmDefaultBin(home, nvmDir) : null,
      nvmDir ? getNvmNewestBin(home, nvmDir) : null,
      join(home, '.volta', 'bin'),
      join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
      join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
      join(home, '.fnm', 'aliases', 'default', 'bin'),
      process.env.ASDF_DATA_DIR ? join(process.env.ASDF_DATA_DIR, 'shims') : join(home, '.asdf', 'shims'),
      join(home, '.local', 'share', 'mise', 'shims'),
      // User-level global bins
      join(home, '.local', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, 'Library', 'pnpm'),
      join(home, '.npm-global', 'bin'),
      join(home, '.cargo', 'bin'),
      join(home, '.opencode', 'bin')
    )
  }
  candidates.push(
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  )

  const preferred = candidates.filter((dir): dir is string => !!dir && exists(dir))
  return [...new Set([...preferred, ...existingPath.split(':')])]
    .filter(Boolean)
    .join(':')
}
