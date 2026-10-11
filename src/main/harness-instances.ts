/**
 * Filesystem side of harness instances: where an instance keeps its login, and
 * which session history it shares with the default home of its harness.
 *
 * - Codex: an instance home holds its own `auth.json` and `models_cache.json`.
 *   Everything else that a thread needs (sessions, archived_sessions, config,
 *   AGENTS.md, skills, prompts, sqlite) is linked to the real default home.
 * - Claude Code: an instance home is a separate CLAUDE_CONFIG_DIR, so its login
 *   (`.credentials.json`, or the Keychain entry keyed by the directory) is
 *   separate. Only the session history that `claude --resume` reads is linked
 *   (`projects/`, plus `session-env/`, `todos/` and `file-history/` when present).
 *   Not linked: `settings.json`, `sessions/` (the live process registry),
 *   `.credentials.json` and the rest of the state. MCP servers are passed per
 *   session by 20x, so they do not depend on the instance's settings.
 *
 * A real directory at a shared path is never replaced with a link. If it
 * holds data, the instance is marked not shareable, and a handoff is used when
 * a task moves to or from it. An empty real directory has nothing to lose, so
 * it is replaced by the link.
 *
 * Every function takes its platform, environment and link function as
 * arguments, so tests run on any host.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, symlinkSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'path'
import type { DetectedHarnessCandidate, HarnessType } from '../shared/harness-instances'

/**
 * Codex state that every instance shares with the real default home.
 *
 * Thread state lives in root-level SQLite databases (`state_5.sqlite`,
 * `thread_history_1.sqlite`, ...), not only in `sqlite/`. Those are linked.
 * SQLite places the `-wal` and `-shm` files next to the real database, so the
 * links need no companions (checked with better-sqlite3: a connection opened
 * through a link and one on the real file see the same rows).
 */
export const CODEX_SHARED_DIRECTORIES = ['sessions', 'archived_sessions', 'skills', 'prompts', 'sqlite'] as const
/**
 * Codex files linked to the default home. Codex may rewrite these atomically,
 * which replaces a link with a plain copy. The instance then keeps that copy.
 */
export const CODEX_SHARED_FILES = ['AGENTS.md', 'session_index.jsonl'] as const
/** Copied once when the instance has none. Codex rewrites it, so later default changes do not reach the instance. */
export const CODEX_COPIED_ONCE_FILES = ['config.toml'] as const
const CODEX_ROOT_DATABASE = /^[A-Za-z0-9_]+\.sqlite$/

/**
 * Claude Code session state linked to the default config directory. `projects`
 * holds the transcripts that `--resume` reads. The others are per-session state.
 */
export const CLAUDE_SHARED_DIRECTORIES = ['projects', 'session-env', 'todos', 'file-history'] as const

export type LinkType = 'dir' | 'junction' | 'file'

/** Symlink type for a shared directory: a junction on Windows, a directory link elsewhere. */
export function directoryLinkType(platform: NodeJS.Platform): LinkType {
  return platform === 'win32' ? 'junction' : 'dir'
}

export type LinkFn = (target: string, path: string, type: LinkType) => void

export type SharedLinkStatus =
  | 'linked'
  | 'copied'
  | 'already-linked'
  | 'replaced-empty-dir'
  | 'kept-real-file'
  | 'missing-source'
  | 'other-link'
  | 'real-data'
  | 'failed'

export interface SharedLinkOutcome {
  name: string
  status: SharedLinkStatus
}

export interface SharedHistoryResult {
  /** True when every session directory of this home resolves to the real default home. */
  shareable: boolean
  links: SharedLinkOutcome[]
}

export interface LinkSharedHistoryOptions {
  harness: HarnessType
  /** Home of this instance (CODEX_HOME or CLAUDE_CONFIG_DIR for the instance). */
  instanceHome: string
  /** Real default home of the harness, which owns the shared history. */
  realHome: string
  platform?: NodeJS.Platform
  /** Creates a link. Defaults to `fs.symlinkSync`. Injected by tests. */
  link?: LinkFn
}

/** Expands a leading `~` and resolves relative paths. Returns undefined for blank input. */
export function normalizeHomePath(input: string | null | undefined, home: string = homedir()): string | undefined {
  const trimmed = input?.trim()
  if (!trimmed) return undefined
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
  return resolve(trimmed)
}

/**
 * The real default home of a harness, honouring an inherited CODEX_HOME or
 * CLAUDE_CONFIG_DIR. That is the directory the harness itself uses by default.
 */
export function realHomeFor(
  harness: HarnessType,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): string {
  if (harness === 'codex') {
    return normalizeHomePath(env.CODEX_HOME, home) ?? join(home, '.codex')
  }
  return normalizeHomePath(env.CLAUDE_CONFIG_DIR, home) ?? join(home, '.claude')
}

/** Home directory of an instance: its stored path, or the real default home for the implicit instance. */
export function instanceHomeFor(
  harness: HarnessType,
  storedHomePath: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): string {
  return normalizeHomePath(storedHomePath, home) ?? realHomeFor(harness, env, home)
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function isEmptyDirectory(path: string): boolean {
  try {
    return readdirSync(path).length === 0
  } catch {
    return false
  }
}

/** True when the symlink at `link` resolves to `target`. */
function linkPointsTo(link: string, target: string): boolean {
  try {
    const raw = readlinkSync(link)
    const resolved = isAbsolute(raw) ? resolve(raw) : resolve(dirname(link), raw)
    return resolved === resolve(target)
  } catch {
    return false
  }
}

/** Root-level SQLite databases of a Codex home (the main files, not their -wal or -shm companions). */
function listRootDatabases(home: string): string[] {
  try {
    return readdirSync(home).filter((name) => CODEX_ROOT_DATABASE.test(name)).sort()
  } catch {
    return []
  }
}

/** Credential file that marks a folder as already signed in to a harness. */
const CREDENTIAL_FILE: Record<HarnessType, string> = {
  codex: 'auth.json',
  'claude-code': '.credentials.json'
}

/** Default config-folder name of a harness, without an inherited override. */
const DEFAULT_FOLDER_PREFIX: Record<HarnessType, string> = {
  codex: '.codex',
  'claude-code': '.claude'
}

/** Turns a folder-name suffix into a human label, e.g. "_work" → "Work", "" → "Detected". */
function labelFromFolderSuffix(dirName: string, prefix: string): string {
  const rest = dirName.slice(prefix.length).replace(/^[-_.]+/, '')
  if (!rest) return 'Detected'
  return rest
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Finds folders next to the user's home directory that already hold a login for
 * this harness (its credential file) but are not the harness's current default
 * home and are not already a stored instance. Read-only: never reads or copies
 * the credential file's contents, only checks that it exists. This is how a
 * user who ran `CODEX_HOME=~/.codex_work codex login` (or the Claude equivalent)
 * outside 20x gets offered that folder instead of having to retype its path.
 *
 * Claude Code may keep its login in the OS keychain instead of
 * `.credentials.json`; a folder like that is not detected here and still needs
 * to be added by hand.
 */
export function detectHarnessInstanceCandidates(
  harness: HarnessType,
  options: {
    env?: Record<string, string | undefined>
    home?: string
    /** Home paths of instances already stored, so they are not offered again. */
    existingHomePaths?: readonly string[]
  } = {}
): DetectedHarnessCandidate[] {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const real = resolve(realHomeFor(harness, env, home))
  const existing = new Set(
    (options.existingHomePaths ?? [])
      .map((path) => normalizeHomePath(path, home))
      .filter((path): path is string => Boolean(path))
      .map((path) => resolve(path))
  )
  const prefix = DEFAULT_FOLDER_PREFIX[harness]
  const credentialFile = CREDENTIAL_FILE[harness]

  let entries: string[]
  try {
    entries = readdirSync(home)
  } catch {
    return []
  }

  const candidates: DetectedHarnessCandidate[] = []
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    const full = resolve(join(home, name))
    if (full === real || existing.has(full)) continue
    if (isSymlink(full) || !isRealDirectory(full)) continue
    if (!existsSync(join(full, credentialFile))) continue
    candidates.push({ home_path: full, suggested_label: labelFromFolderSuffix(name, prefix) })
  }
  return candidates.sort((a, b) => a.home_path.localeCompare(b.home_path))
}

/**
 * Why a folder cannot be an account home, or null when it can. The folder must be
 * absolute (or start with ~). It must not be the home folder, the default home of
 * the harness, or an ancestor of that default home (for example "/").
 */
export function instanceHomeError(
  input: string,
  harness: HarnessType,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): string | null {
  const raw = input.trim()
  if (!raw) return 'Choose a folder for this account.'
  if (!(raw.startsWith('~') || isAbsolute(raw))) return 'Use an absolute folder path, or one that starts with ~.'
  const folder = resolve(normalizeHomePath(raw, home) ?? raw)
  if (folder === resolve(home)) return 'That is your home folder. Choose a separate folder for this account.'
  const real = resolve(realHomeFor(harness, env, home))
  if (folder === real) return 'That folder is the default home of this harness. Use the built-in account instead.'
  const prefix = folder.endsWith(sep) ? folder : folder + sep
  if (real.startsWith(prefix) || folder === parse(folder).root) {
    return 'That folder contains the default home of this harness. Choose a separate folder for this account.'
  }
  return null
}

const defaultLink: LinkFn = (target, path, type) => {
  symlinkSync(target, path, type)
}

/**
 * Links the session history of an instance home to the real default home.
 * Idempotent. Returns whether the history is shared. A non-shareable home keeps
 * its own directories, and nothing in it is deleted or replaced except empty
 * real directories.
 */
export function linkSharedHistory(options: LinkSharedHistoryOptions): SharedHistoryResult {
  const home = resolve(options.instanceHome)
  const real = resolve(options.realHome)
  const links: SharedLinkOutcome[] = []
  if (home === real) return { shareable: true, links }

  const platform = options.platform ?? process.platform
  const link = options.link ?? defaultLink
  const dirType = directoryLinkType(platform)
  let shareable = true

  mkdirSync(home, { recursive: true })
  mkdirSync(real, { recursive: true })

  const linkDirectory = (name: string): void => {
    const target = join(real, name)
    const path = join(home, name)
    mkdirSync(target, { recursive: true })

    if (isSymlink(path)) {
      if (linkPointsTo(path, target)) {
        links.push({ name, status: 'already-linked' })
      } else {
        // Points somewhere else: its sessions are not in the default home.
        links.push({ name, status: 'other-link' })
        shareable = false
      }
      return
    }
    if (isRealDirectory(path)) {
      if (isEmptyDirectory(path)) {
        rmdirSync(path)
      } else {
        links.push({ name, status: 'real-data' })
        shareable = false
        return
      }
    } else if (existsSync(path)) {
      // A real file where a directory link belongs. Not replaced.
      links.push({ name, status: 'real-data' })
      shareable = false
      return
    }
    try {
      link(target, path, dirType)
      links.push({ name, status: 'linked' })
    } catch {
      links.push({ name, status: 'failed' })
      shareable = false
    }
  }

  const linkFile = (name: string): void => {
    const target = join(real, name)
    const path = join(home, name)
    if (isSymlink(path)) {
      links.push({ name, status: linkPointsTo(path, target) ? 'already-linked' : 'kept-real-file' })
      return
    }
    if (existsSync(path)) {
      links.push({ name, status: 'kept-real-file' })
      return
    }
    if (!existsSync(target)) {
      links.push({ name, status: 'missing-source' })
      return
    }
    try {
      link(target, path, 'file')
      links.push({ name, status: 'linked' })
    } catch {
      // Files are settings, not history: a missing link does not stop sharing.
      links.push({ name, status: 'failed' })
    }
  }

  const copyOnce = (name: string): void => {
    const target = join(real, name)
    const path = join(home, name)
    if (existsSync(path) || !existsSync(target)) return
    try {
      copyFileSync(target, path)
      links.push({ name, status: 'copied' })
    } catch {
      links.push({ name, status: 'failed' })
    }
  }

  if (options.harness === 'codex') {
    for (const name of CODEX_SHARED_DIRECTORIES) linkDirectory(name)
    for (const name of CODEX_SHARED_FILES) linkFile(name)
    for (const name of CODEX_COPIED_ONCE_FILES) copyOnce(name)
    for (const name of listRootDatabases(real)) linkFile(name)
  } else {
    for (const name of CLAUDE_SHARED_DIRECTORIES) linkDirectory(name)
  }

  return { shareable, links }
}
