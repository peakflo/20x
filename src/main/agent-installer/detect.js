import { execFile } from 'child_process'
import { promisify } from 'util'
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'path'
import { homedir } from 'os'
import { accessSync, closeSync, constants as fsConstants, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from 'fs'

const execFileAsync = promisify(execFile)
export const MINIMUM_PI_VERSION = '0.80.5'

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

function ensurePathDirectory(dir) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const segments = (process.env.PATH || '').split(sep)
  if (!dir || segments.includes(dir) || segments.includes(`${dir}/`)) return false
  process.env.PATH = `${dir}${sep}${process.env.PATH || ''}`
  return true
}

/** Move (or add) `dir` to the front of PATH. */
function prependPathDirectory(dir) {
  const segments = (process.env.PATH || '').split(delimiter).filter((p) => p && p !== dir && p !== `${dir}/`)
  process.env.PATH = [dir, ...segments].join(delimiter)
}

/** Return common locations used by global npm and Node version managers. */
export async function getPiCommandCandidates() {
  const home = homedir()
  const candidates = process.platform === 'win32'
    ? [
        'pi.cmd',
        'pi.exe',
        join(home, 'AppData', 'Roaming', 'npm', 'pi.cmd'),
        join(home, 'AppData', 'Roaming', 'npm', 'pi.exe')
      ]
    : [
        'pi',
        '/opt/homebrew/bin/pi',
        '/usr/local/bin/pi',
        join(home, '.local', 'bin', 'pi'),
        join(home, '.npm-global', 'bin', 'pi'),
        join(home, '.volta', 'bin', 'pi')
      ]

  try {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const { stdout } = await execFileAsync(npmCommand, ['prefix', '-g'], {
      timeout: 5000,
      shell: process.platform === 'win32',
      windowsHide: true
    })
    const prefix = stdout.trim()
    if (prefix) {
      candidates.push(process.platform === 'win32'
        ? join(prefix, 'pi.cmd')
        : join(prefix, 'bin', 'pi'))
    }
  } catch {
    // npm is optional during detection.
  }

  return unique(candidates)
}

export function isVersionAtLeast(version, minimum) {
  const current = String(version || '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const required = String(minimum || '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(current.length, required.length)
  for (let index = 0; index < length; index++) {
    if ((current[index] || 0) > (required[index] || 0)) return true
    if ((current[index] || 0) < (required[index] || 0)) return false
  }
  return true
}

// ── Probe helpers ─────────────────────────────────────────────────────────

const VERSION_TIMEOUT_MS = 10000

/** Extract a version-like string (e.g. "v22.1.0", "2.44.0", "1.0.3") from CLI output. */
export function parseVersionOutput(raw) {
  const text = String(raw || '').trim()
  const match = text.match(/(\d+\.\d+[\w.\-]*)/)
  return match ? match[1] : text.split('\n')[0]
}

function isExecutableFile(file) {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve a bare command against PATH (POSIX only). Returns null when not found. */
export function resolveCommandOnPath(cmd, pathValue = process.env.PATH || '') {
  if (isAbsolute(cmd) || cmd.includes('/')) return isExecutableFile(cmd) ? cmd : null
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, cmd)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

/** True when the file starts with a `#!/usr/bin/env node` (or `env -S node ...`) shebang. */
export function hasEnvNodeShebang(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(256)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const firstLine = buf.subarray(0, n).toString('utf8').split('\n')[0]
    return /^#!\s*\/usr\/bin\/env\s+(?:-S\s+)?node(?:\s|$)/.test(firstLine)
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function listNvmVersions(nvmDir) {
  try {
    return readdirSync(join(nvmDir, 'versions', 'node'))
      .filter((v) => /^v\d/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  } catch {
    return []
  }
}

/** Resolve an nvm alias ("22", "lts/*", "node", "v22.14.0", ...) to an installed version dir name. */
export function resolveNvmAlias(nvmDir, alias, versions = listNvmVersions(nvmDir), depth = 0) {
  const name = String(alias || '').trim()
  if (!name || depth > 10 || versions.length === 0 || name === 'system') return null
  if (name === 'node' || name === 'stable') return versions[0]
  const aliasFile = join(nvmDir, 'alias', name)
  if (!name.includes('..') && existsSync(aliasFile)) {
    try {
      const target = readFileSync(aliasFile, 'utf8').trim()
      if (target && target !== name) return resolveNvmAlias(nvmDir, target, versions, depth + 1)
    } catch {
      // fall through
    }
  }
  if (name.startsWith('lts/')) return null
  const prefix = name.replace(/^v/, '')
  if (!/^\d+(\.\d+){0,2}$/.test(prefix)) return null
  return versions.find((v) => v === `v${prefix}` || v.startsWith(`v${prefix}.`)) ?? null
}

/**
 * Node binaries that can run an `env node` script, best first: the node next
 * to the script's (symlink) location, the node of the install prefix that owns
 * the script's realpath (e.g. .../nvm/versions/node/vX/bin/node), then nvm's
 * default and newest Node.
 */
export function getNodeCandidatesForScript(scriptPath, home = homedir()) {
  const candidates = []
  try {
    if (lstatSync(scriptPath).isSymbolicLink()) {
      const target = resolvePath(dirname(scriptPath), readlinkSync(scriptPath))
      candidates.push(join(dirname(target), 'node'))
    }
  } catch {
    // ignore
  }
  try {
    const real = realpathSync(scriptPath)
    candidates.push(join(dirname(real), 'node'))
    let dir = dirname(real)
    for (let i = 0; i < 8; i++) {
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
      candidates.push(join(dir, 'bin', 'node'))
    }
  } catch {
    // ignore
  }
  const nvmDir = process.env.NVM_DIR || join(home, '.nvm')
  const versions = listNvmVersions(nvmDir)
  try {
    const def = resolveNvmAlias(nvmDir, readFileSync(join(nvmDir, 'alias', 'default'), 'utf8'), versions)
    if (def) candidates.push(join(nvmDir, 'versions', 'node', def, 'bin', 'node'))
  } catch {
    // no nvm default
  }
  if (versions[0]) candidates.push(join(nvmDir, 'versions', 'node', versions[0], 'bin', 'node'))
  return unique(candidates).filter(isExecutableFile)
}

function errorSnippet(err) {
  const stderr = String(err?.stderr || '').trim()
  const stdout = String(err?.stdout || '').trim()
  const base = err?.killed || err?.signal === 'SIGTERM'
    ? `timed out after ${VERSION_TIMEOUT_MS}ms`
    : (err?.message || String(err)).split('\n')[0]
  const detail = (stderr || stdout).split('\n').slice(-3).join(' | ')
  return (detail ? `${base}: ${detail}` : base).slice(0, 400)
}

/**
 * Run `<cmd> <args>` and extract a version. Distinguishes not-found (ENOENT)
 * from found-but-failed; for a failing `#!/usr/bin/env node` script, retries
 * with a working node binary (PATH may point `env node` at a broken node).
 * Result keeps `{ installed, version }` and adds optional `path`/`error`/`via`.
 */
export async function probeCommand(cmd, args, opts = {}) {
  const isWin = process.platform === 'win32'
  const exec = opts.exec || execFileAsync
  const execOpts = { timeout: VERSION_TIMEOUT_MS, shell: isWin, windowsHide: true }
  try {
    const { stdout, stderr } = await exec(cmd, args, execOpts)
    return { installed: true, version: parseVersionOutput(`${stdout}\n${stderr}`) }
  } catch (err) {
    if (isWin) return { installed: false, version: null }
    const resolved = resolveCommandOnPath(cmd)
    if (err?.code === 'ENOENT' || !resolved) return { installed: false, version: null }

    const firstError = errorSnippet(err)
    if (hasEnvNodeShebang(resolved)) {
      const nodes = opts.nodeCandidates ? opts.nodeCandidates(resolved) : getNodeCandidatesForScript(resolved)
      for (const node of nodes) {
        try {
          const { stdout, stderr } = await exec(node, [resolved, ...args], { ...execOpts, shell: false })
          console.warn(`[detect] ${cmd} failed via PATH (${firstError}); succeeded with ${node}`)
          // Put the working node first so `env node` resolves to it when the
          // agent is actually launched, not just detected.
          prependPathDirectory(dirname(node))
          return { installed: true, version: parseVersionOutput(`${stdout}\n${stderr}`), path: resolved, via: node }
        } catch {
          // try the next node
        }
      }
    }
    console.warn(`[detect] ${cmd} found at ${resolved} but \`${[cmd, ...args].join(' ')}\` failed: ${firstError}`)
    return { installed: false, version: null, path: resolved, error: firstError }
  }
}

/**
 * Ensure well-known agent install directories are on the running process's
 * PATH so detection works immediately after install without an app restart.
 */
function ensureAgentPaths() {
  const home = homedir()

  const knownDirs = [
    join(home, '.opencode', 'bin'),  // OpenCode standalone installer
    join(home, '.local', 'bin')       // Linux binary installs
  ]

  let modified = false
  for (const dir of knownDirs) {
    if (existsSync(dir) && ensurePathDirectory(dir)) modified = true
  }
  return modified
}

/**
 * Detect which agents and tools are installed on this system.
 * Entries may carry optional `path`, `error` (stderr snippet when the binary
 * exists but `--version` failed) and `via` (node used for an `env node` retry).
 * @returns {Promise<Record<string, { installed: boolean, version: string | null, path?: string, error?: string, via?: string }>>}
 */
export async function detectInstalledAgents() {
  // Ensure well-known install dirs are on PATH before probing
  ensureAgentPaths()

  /**
   * @param {string} cmd
   * @param {string[]} args
   * @returns {Promise<{ installed: boolean, version: string | null, path?: string, error?: string, via?: string }>}
   */
  const probe = (cmd, args) => probeCommand(cmd, args)

  async function probePi() {
    for (const command of await getPiCommandCandidates()) {
      const status = await probe(command, ['--version'])
      if (!status.installed) continue
      if (existsSync(command)) ensurePathDirectory(dirname(command))
      const supported = status.version
        ? isVersionAtLeast(status.version, MINIMUM_PI_VERSION)
        : false
      return {
        ...status,
        supported,
        reason: supported
          ? null
          : status.version
            ? `Pi ${status.version} is unsupported. Update to ${MINIMUM_PI_VERSION} or newer.`
            : `Could not determine the Pi version. Pi ${MINIMUM_PI_VERSION} or newer is required.`
      }
    }
    return { installed: false, version: null, supported: false, reason: 'Pi CLI is not installed.' }
  }

  // Run all probes in parallel — shell:true on Windows resolves .cmd automatically
  const [nodejs, npm, pnpm, git, gh, glab, claudeCode, opencode, codex, cursor, gemini, amp, pi] = await Promise.all([
    probe('node', ['--version']),
    probe('npm', ['--version']),
    probe('pnpm', ['--version']),
    probe('git', ['--version']),
    probe('gh', ['--version']),
    probe('glab', ['--version']),
    probe('claude', ['--version']),
    probe('opencode', ['--version']),
    probe('codex', ['--version']),
    probe('cursor-agent', ['--version']),
    probe('gemini', ['--version']),
    probe('amp', ['--version']),
    probePi()
  ])

  return { nodejs, npm, pnpm, git, gh, glab, claudeCode, opencode, codex, cursor, gemini, amp, pi }
}
