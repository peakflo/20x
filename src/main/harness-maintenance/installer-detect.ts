import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import type { HarnessKey, InstallerKind } from '../../shared/harness-maintenance'

const execFileAsync = promisify(execFile)

export interface InstallerDetectionResult {
  installer: InstallerKind
  /** Human-readable update command, built from the detected installer. Null when manual-only. */
  updateCommand: string | null
  /** Literal argv to spawn for the update, when `canUpdate`. Null when manual-only. */
  updateArgv: { cmd: string; args: string[] } | null
  /** Lock key: one update runs at a time per key (one npm prefix, or the shared "homebrew" key). */
  lockKey: string | null
}

/** Normalizes a path for cross-platform matching: lowercase, forward slashes, no trailing slash. */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}

/**
 * Resolves a command name to the real, symlink-followed path of the binary
 * that would run, using `which` (POSIX) or `where` (Windows). Returns null
 * when the command isn't found.
 */
export async function resolveBinaryPath(cmd: string): Promise<string | null> {
  const isWin = process.platform === 'win32'
  try {
    const { stdout } = await execFileAsync(isWin ? 'where' : 'which', [cmd], {
      timeout: 5000,
      windowsHide: true
    })
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    if (!first) return null
    const { realpathSync } = await import('fs')
    try {
      return realpathSync(first)
    } catch {
      return first
    }
  } catch {
    return null
  }
}

/** Native install path patterns per harness (own CLI installer, no package manager involved). */
const NATIVE_PATH_PATTERNS: Partial<Record<HarnessKey, (normalized: string) => boolean>> = {
  'claude-code': (p) => p.endsWith('/.local/bin/claude') || p.endsWith('/.local/bin/claude.exe') || p.includes('/.local/share/claude/'),
  codex: (p) => p.endsWith('/.local/bin/codex') || p.endsWith('/.local/bin/codex.exe') || p.includes('/.local/share/codex/'),
  opencode: (p) => p.includes('/.opencode/bin/')
}

/** Native self-update command per harness, when the native-install pattern matched. */
const NATIVE_UPDATE_ARGS: Partial<Record<HarnessKey, string[]>> = {
  'claude-code': ['update'],
  codex: ['update'],
  opencode: ['upgrade']
}

/**
 * Display name for the native update command. Not derived from the resolved
 * path's basename: a native installer can target a versioned file (e.g.
 * Claude Code's own installer resolves `claude` to a `.local/share/claude/
 * versions/<version>` file literally named after the version, not `claude`).
 */
const NATIVE_DISPLAY_NAME: Partial<Record<HarnessKey, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode'
}

const HOMEBREW_PATH = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//

/**
 * Detects which installer owns a resolved binary path, and derives the
 * display/update command for it. Pure w.r.t. the filesystem except for one
 * `existsSync` check used to disambiguate the npm-global shim on Windows.
 *
 * Order mirrors how specific each signal is: a harness's own native installer
 * first, then Homebrew (a distinctive `Cellar`/`Caskroom` path shape), then
 * the global-install directory shapes of pnpm/yarn/bun/npm, then version
 * managers (mise/asdf/volta/nvm) and anything else as manual-only.
 */
export function detectInstaller(harness: HarnessKey, realPath: string, npmPackageName: string | null): InstallerDetectionResult {
  const p = normalize(realPath)
  const manual = (): InstallerDetectionResult => ({ installer: 'manual', updateCommand: null, updateArgv: null, lockKey: null })

  const nativeMatch = NATIVE_PATH_PATTERNS[harness]
  if (nativeMatch?.(p)) {
    const args = NATIVE_UPDATE_ARGS[harness] ?? []
    return {
      installer: 'native',
      updateCommand: `${NATIVE_DISPLAY_NAME[harness] ?? basename(realPath)} ${args.join(' ')}`.trim(),
      updateArgv: { cmd: realPath, args },
      lockKey: `native:${harness}`
    }
  }

  const homebrewMatch = HOMEBREW_PATH.exec(p)
  if (homebrewMatch) {
    const kindSegment = homebrewMatch[2]
    const name = homebrewMatch[3]
    if (name !== 'mise') {
      const isCask = kindSegment === 'caskroom'
      return {
        installer: isCask ? 'homebrew-cask' : 'homebrew-formula',
        updateCommand: isCask ? `brew upgrade --cask ${name}` : `brew upgrade ${name}`,
        updateArgv: { cmd: 'brew', args: isCask ? ['upgrade', '--cask', name] : ['upgrade', name] },
        lockKey: 'homebrew'
      }
    }
  }

  if (p.includes('/.bun/bin/')) {
    if (!npmPackageName) return manual()
    return {
      installer: 'bun-global',
      updateCommand: `bun install -g ${npmPackageName}@latest`,
      updateArgv: { cmd: 'bun', args: ['install', '-g', `${npmPackageName}@latest`] },
      lockKey: 'bun-global'
    }
  }

  const pnpmShapes = ['/.local/share/pnpm/', '/library/pnpm/', '/local/share/pnpm/', '/appdata/local/pnpm/', '/pnpm/global/']
  if (pnpmShapes.some((shape) => p.includes(shape))) {
    if (!npmPackageName) return manual()
    return {
      installer: 'pnpm-global',
      updateCommand: `pnpm add -g ${npmPackageName}@latest`,
      updateArgv: { cmd: 'pnpm', args: ['add', '-g', `${npmPackageName}@latest`] },
      lockKey: 'pnpm-global'
    }
  }

  if (/\/yarn\/(?:data\/)?global\/node_modules\//.test(p)) {
    if (!npmPackageName) return manual()
    return {
      installer: 'yarn-global',
      updateCommand: `yarn global add ${npmPackageName}@latest`,
      updateArgv: { cmd: 'yarn', args: ['global', 'add', `${npmPackageName}@latest`] },
      lockKey: 'yarn-global'
    }
  }

  if (npmPackageName) {
    const npmGlobal = detectNpmGlobal(realPath, p, npmPackageName)
    if (npmGlobal) return npmGlobal
  }

  // Version managers: once ownership isn't proven as npm/pnpm/yarn/bun/
  // Homebrew above, a mise/asdf/volta/nvm-shaped path means the version is
  // pinned in that manager's own config — "updating" means editing that
  // config, not running a package-manager command.
  if (p.includes('/mise/installs/') || p.includes('/mise/shims/')) return manual()
  if (p.includes('/.asdf/installs/') || p.includes('/.asdf/shims/')) return manual()
  if (p.includes('/.volta/')) return manual()
  if (p.includes('/.nvm/versions/node/')) return manual()

  return manual()
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/**
 * POSIX npm global installs lay the package out at
 * `<prefix>/lib/node_modules/<package>/...`. Windows npm globals have no such
 * segment — instead, the shim sits next to a `node_modules/<package>` folder,
 * which we check for with `existsSync` since it can't be inferred from the
 * path string alone.
 */
function detectNpmGlobal(realPath: string, normalizedPath: string, npmPackageName: string): InstallerDetectionResult | null {
  const pkgSegment = `/lib/node_modules/${npmPackageName.toLowerCase()}/`
  const segmentIndex = normalizedPath.indexOf(pkgSegment)
  if (segmentIndex !== -1) {
    const before = normalizedPath.slice(0, segmentIndex)
    // Reject a nested/transitive package (another node_modules earlier in the path).
    if (before.includes('/node_modules/')) return null
    // Slice the original (case-preserved, slash-normalized-only) path at the
    // same index so the prefix we pass to npm matches the real path on disk
    // — case matters on case-sensitive filesystems (Linux).
    const casedPath = realPath.replace(/\\/g, '/')
    const prefix = segmentIndex === 0 ? '/' : casedPath.slice(0, segmentIndex)
    return {
      installer: 'npm-global',
      updateCommand: `npm install -g --prefix ${prefix} ${npmPackageName}@latest`,
      updateArgv: { cmd: 'npm', args: ['install', '-g', '--prefix', prefix, `${npmPackageName}@latest`] },
      lockKey: `npm-global:${prefix.toLowerCase()}`
    }
  }

  if (process.platform === 'win32') {
    const shimDir = dirname(realPath)
    const manifestPath = join(shimDir, 'node_modules', npmPackageName, 'package.json')
    if (existsSync(manifestPath)) {
      return {
        installer: 'npm-global',
        updateCommand: `npm install -g --prefix ${shimDir} ${npmPackageName}@latest`,
        updateArgv: { cmd: 'npm', args: ['install', '-g', '--prefix', shimDir, `${npmPackageName}@latest`] },
        lockKey: `npm-global:${normalize(shimDir)}`
      }
    }
  }

  return null
}
