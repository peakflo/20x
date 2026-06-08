import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'

const execFileAsync = promisify(execFile)

/**
 * Ensure well-known agent install directories are on the running process's
 * PATH so detection works immediately after install without an app restart.
 */
function ensureAgentPaths() {
  const home = homedir()
  const sep = process.platform === 'win32' ? ';' : ':'
  const pathEnv = process.env.PATH || ''
  const segments = pathEnv.split(sep)

  const knownDirs = [
    join(home, '.opencode', 'bin'),  // OpenCode standalone installer
    join(home, '.local', 'bin')       // Linux binary installs
  ]

  let modified = false
  for (const dir of knownDirs) {
    if (existsSync(dir) && !segments.includes(dir) && !segments.includes(`${dir}/`)) {
      process.env.PATH = `${dir}${sep}${process.env.PATH}`
      modified = true
    }
  }
  return modified
}

/**
 * Detect which agents and tools are installed on this system.
 * @returns {Promise<Record<string, { installed: boolean, version: string | null }>>}
 */
export async function detectInstalledAgents() {
  const isWin = process.platform === 'win32'

  // Ensure well-known install dirs are on PATH before probing
  ensureAgentPaths()

  /**
   * Run a command and extract a version string from stdout.
   * On Windows, shell: true is required to resolve .cmd/.bat wrappers.
   * @param {string} cmd
   * @param {string[]} args
   * @returns {Promise<{ installed: boolean, version: string | null }>}
   */
  async function probe(cmd, args) {
    try {
      const { stdout } = await execFileAsync(cmd, args, {
        timeout: 10000,
        shell: isWin,
        windowsHide: true
      })
      const raw = stdout.trim()
      // Extract version-like string (e.g. "v22.1.0", "2.44.0", "1.0.3")
      const match = raw.match(/(\d+\.\d+[\w.\-]*)/)
      return { installed: true, version: match ? match[1] : raw.split('\n')[0] }
    } catch {
      return { installed: false, version: null }
    }
  }

  // Run all probes in parallel — shell:true on Windows resolves .cmd automatically
  const [nodejs, npm, pnpm, git, gh, glab, claudeCode, opencode, codex] = await Promise.all([
    probe('node', ['--version']),
    probe('npm', ['--version']),
    probe('pnpm', ['--version']),
    probe('git', ['--version']),
    probe('gh', ['--version']),
    probe('glab', ['--version']),
    probe('claude', ['--version']),
    probe('opencode', ['--version']),
    probe('codex', ['--version'])
  ])

  return { nodejs, npm, pnpm, git, gh, glab, claudeCode, opencode, codex }
}
