/**
 * Harness maintenance service: version checks and user-triggered updates for
 * installed harness CLIs (Claude Code, Codex, OpenCode, Pi; Cursor shows as
 * "Updates with 20x" since it's moving onto a bundled SDK).
 *
 * Functional module (like `agent-installer/`), not a class — module-level
 * state holds the npm/brew caches, per-installer update locks and the last
 * computed statuses.
 */

import { spawn } from 'child_process'
import { existsSync, accessSync, constants as fsConstants, realpathSync } from 'fs'
import {
  detectInstalledAgents,
  getPiCommandCandidates
} from '../agent-installer/detect.js'
import { detectInstaller, resolveBinaryPath, type InstallerDetectionResult } from './installer-detect'
import { NpmLatestVersionCache, fetchLatestNpmVersion, type MaintenanceCacheStore, type FetchLike } from './npm-registry'
import { fetchBrewLatestVersion, type BrewExecLike } from './homebrew'
import { HARNESS_KEYS, HARNESS_VERSION_REQUIREMENTS, resolveNpmPackageName } from '../../shared/harness-versions'
import {
  computeMaintenanceStatus,
  harnessUpdateChecksEnabled,
  HARNESS_UPDATE_CHECKS_SETTING_KEY,
  HARNESS_UPDATE_CHECK_INTERVAL_MS,
  type HarnessKey,
  type HarnessMaintenanceStatus,
  type HarnessUpdateAllResult,
  type HarnessUpdateResult,
  type HarnessUpdateRunState
} from '../../shared/harness-maintenance'

/** Maps a harness key to the probe key `detectInstalledAgents()` returns. */
const DETECT_KEY: Record<HarnessKey, 'claudeCode' | 'codex' | 'opencode' | 'cursor' | 'pi'> = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor',
  pi: 'pi'
}

/** CLI command name probed for each harness (used to resolve the real binary path). */
const CLI_COMMAND: Record<HarnessKey, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor-agent',
  pi: 'pi'
}

export interface MaintenanceDb {
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
}

let npmCache: NpmLatestVersionCache | null = null
function getNpmCache(db: MaintenanceDb): NpmLatestVersionCache {
  if (!npmCache) {
    const store: MaintenanceCacheStore = { get: (k) => db.getSetting(k), set: (k, v) => db.setSetting(k, v) }
    npmCache = new NpmLatestVersionCache(store)
  }
  return npmCache
}

/** Test-only: forces a fresh cache instance on the next call. */
export function resetNpmCacheForTests(): void {
  npmCache = null
}

async function resolvePiBinaryPath(): Promise<string | null> {
  for (const candidate of await getPiCommandCandidates()) {
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate)
      } catch {
        return candidate
      }
    }
  }
  return resolveBinaryPath('pi')
}

function resolveHarnessBinaryPath(harness: HarnessKey): Promise<string | null> {
  return harness === 'pi' ? resolvePiBinaryPath() : resolveBinaryPath(CLI_COMMAND[harness])
}

export interface ComputeStatusOptions {
  fresh?: boolean
  checksEnabled: boolean
  cache: NpmLatestVersionCache
  hasActiveSession?: (harness: HarnessKey) => boolean
  /** Test-only injection points — production code uses the real fetch/brew. */
  fetchImpl?: FetchLike
  brewExec?: BrewExecLike
}

/**
 * Computes one harness's maintenance status. Current installed version comes
 * from the existing `detectInstalledAgents()` probes; latest-version lookups
 * (npm registry, or Homebrew when the binary is Homebrew-owned) only run when
 * `checksEnabled` — the setting gates all network calls, not installer
 * detection (which is pure local path matching, needed for "Update now" to
 * work even with checks off).
 */
export async function computeHarnessStatus(
  harness: HarnessKey,
  detected: { installed: boolean; version: string | null },
  opts: ComputeStatusOptions
): Promise<HarnessMaintenanceStatus> {
  const checkedAt = new Date().toISOString()
  const hasActiveSession = opts.hasActiveSession?.(harness)

  if (!detected.installed) {
    return {
      harness,
      installed: false,
      binaryPath: null,
      version: null,
      latestVersion: null,
      status: 'not_installed',
      installer: 'unknown',
      canUpdate: false,
      updateCommand: null,
      checkedAt,
      hasActiveSession
    }
  }

  const version = detected.version

  if (harness === 'cursor') {
    // Another subtask moves Cursor onto @cursor/sdk, pinned in 20x's own
    // package.json — Cursor then updates with 20x, not here. Until that
    // lands, the standalone `cursor-agent` CLI is what actually runs, so
    // there is no one-click update for it (manual-only, shown as bundled).
    const binaryPath = await resolveBinaryPath(CLI_COMMAND.cursor)
    return {
      harness,
      installed: true,
      binaryPath,
      version,
      latestVersion: null,
      status: 'up_to_date',
      installer: 'bundled',
      canUpdate: false,
      updateCommand: null,
      checkedAt,
      hasActiveSession
    }
  }

  const binaryPath = await resolveHarnessBinaryPath(harness)
  const npmPackage = resolveNpmPackageName(harness, version)
  const requirement = HARNESS_VERSION_REQUIREMENTS[harness]

  const detection: InstallerDetectionResult = binaryPath
    ? resolveUpdateAction(harness, binaryPath, npmPackage)
    : { installer: 'unknown', updateCommand: null, updateArgv: null, lockKey: null }

  let latestVersion: string | null = null
  let error: string | undefined
  if (opts.checksEnabled && binaryPath) {
    try {
      if (detection.installer === 'homebrew-formula' || detection.installer === 'homebrew-cask') {
        const name = extractHomebrewName(binaryPath)
        if (name) latestVersion = await fetchBrewLatestVersion(name, detection.installer === 'homebrew-cask' ? 'cask' : 'formula', opts.brewExec)
      }
      if (latestVersion == null && npmPackage) {
        latestVersion = await fetchLatestNpmVersion(npmPackage, opts.cache, { fresh: opts.fresh, fetchImpl: opts.fetchImpl })
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  const status = computeMaintenanceStatus({ installed: true, version, latestVersion, requirement })

  return {
    harness,
    installed: true,
    binaryPath,
    version,
    latestVersion,
    status,
    installer: detection.installer,
    canUpdate: detection.updateArgv != null,
    updateCommand: detection.updateCommand,
    checkedAt,
    error,
    hasActiveSession
  }
}

function extractHomebrewName(realPath: string): string | null {
  const match = /\/(cellar|caskroom)\/([^/]+)\//i.exec(realPath.replace(/\\/g, '/'))
  return match ? match[2] : null
}

/**
 * The installer/lock-key/update-command for a resolved binary, with Pi's
 * self-update override applied. Used everywhere an update action is decided
 * (status computation, and both the initial and re-confirmed resolution
 * inside `runHarnessUpdate`) so the lock key acquired up front always matches
 * the one re-checked after the lock — otherwise a legitimate update aborts
 * with a false "installation changed".
 *
 * Pi's own updater is documented to cover its own installer and npm/pnpm/
 * yarn/bun globals itself, so prefer `pi update --self` whenever the binary
 * isn't version-manager-pinned (manual-only stays manual: the version there
 * is pinned in that manager's config, not something `pi update` should touch).
 */
function resolveUpdateAction(harness: HarnessKey, binaryPath: string, npmPackageName: string | null): InstallerDetectionResult {
  const detection = detectInstaller(harness, binaryPath, npmPackageName)
  if (harness === 'pi' && detection.installer !== 'manual' && detection.installer !== 'unknown') {
    return {
      installer: detection.installer,
      updateCommand: 'pi update --self',
      updateArgv: { cmd: binaryPath, args: ['update', '--self'] },
      lockKey: 'native:pi'
    }
  }
  return detection
}

let lastStatuses: HarnessMaintenanceStatus[] | null = null

export interface MaintenanceOptions {
  fresh?: boolean
  hasActiveSession?: (harness: HarnessKey) => boolean
  fetchImpl?: FetchLike
  brewExec?: BrewExecLike
}

/**
 * Computes the current status of every harness. Current-version probes
 * (`detectInstalledAgents()`) always run — they're local and cheap; only the
 * latest-version network lookups are gated by the setting.
 */
export async function refreshHarnessStatuses(db: MaintenanceDb, opts: MaintenanceOptions = {}): Promise<HarnessMaintenanceStatus[]> {
  const checksEnabled = harnessUpdateChecksEnabled(db.getSetting(HARNESS_UPDATE_CHECKS_SETTING_KEY))
  const cache = getNpmCache(db)
  const detected = await detectInstalledAgents()
  const statuses = await Promise.all(
    HARNESS_KEYS.map((harness) =>
      computeHarnessStatus(harness, detected[DETECT_KEY[harness]], {
        fresh: opts.fresh,
        checksEnabled,
        cache,
        hasActiveSession: opts.hasActiveSession,
        fetchImpl: opts.fetchImpl,
        brewExec: opts.brewExec
      })
    )
  )
  lastStatuses = statuses
  return statuses
}

/** Returns the last computed statuses, computing them once if this is the first call. */
export async function getHarnessStatuses(db: MaintenanceDb, opts: MaintenanceOptions = {}): Promise<HarnessMaintenanceStatus[]> {
  if (lastStatuses) return lastStatuses
  return refreshHarnessStatuses(db, opts)
}

// ── Per-installer update lock ──────────────────────────────────────────────

const lockQueues = new Map<string, Promise<unknown>>()

function runWithLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = lockQueues.get(key) ?? Promise.resolve()
  const settled = prior.catch(() => undefined)
  const run = settled.then(fn)
  lockQueues.set(key, run.catch(() => undefined))
  return run
}

/** Test-only: clears pending lock state between tests. */
export function resetLocksForTests(): void {
  lockQueues.clear()
}

// ── Running an update ──────────────────────────────────────────────────────

const UPDATE_TIMEOUT_MS = 5 * 60 * 1000
const OUTPUT_CAP_BYTES = 10000

export interface SpawnLike {
  (cmd: string, args: string[]): {
    stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void }
    stderr: { on(event: 'data', cb: (chunk: Buffer) => void): void }
    on(event: 'error', cb: (err: Error) => void): void
    on(event: 'close', cb: (code: number | null) => void): void
    kill(): void
  }
}

const defaultSpawn: SpawnLike = (cmd, args) => spawn(cmd, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

export interface UpdateDeps {
  spawnImpl?: SpawnLike
  hasActiveSession?: (harness: HarnessKey) => boolean
  fetchImpl?: FetchLike
  brewExec?: BrewExecLike
}

function isPrefixWritable(prefix: string): boolean {
  try {
    accessSync(prefix, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Runs one harness update. Always user-triggered — never call this from a timer. */
export async function runHarnessUpdate(
  db: MaintenanceDb,
  harness: HarnessKey,
  onProgress: (chunk: string) => void,
  deps: UpdateDeps = {}
): Promise<HarnessUpdateResult> {
  const startedAt = new Date().toISOString()
  const checksEnabled = harnessUpdateChecksEnabled(db.getSetting(HARNESS_UPDATE_CHECKS_SETTING_KEY))
  const cache = getNpmCache(db)
  const statusOpts = { checksEnabled, cache, hasActiveSession: deps.hasActiveSession, fetchImpl: deps.fetchImpl, brewExec: deps.brewExec }

  const detected = await detectInstalledAgents()
  const initialStatus = await computeHarnessStatus(harness, detected[DETECT_KEY[harness]], statusOpts)

  if (!initialStatus.canUpdate || !initialStatus.binaryPath) {
    const run: HarnessUpdateRunState = {
      harness,
      status: 'failed',
      message: initialStatus.installed ? 'This install has no one-click update. Use the command shown, or your package manager.' : 'Harness is not installed.',
      startedAt,
      finishedAt: new Date().toISOString()
    }
    return { harness, run, newStatus: initialStatus }
  }

  const initialDetection = resolveUpdateAction(harness, initialStatus.binaryPath, resolveNpmPackageName(harness, initialStatus.version))
  const lockKey = initialDetection.lockKey ?? `native:${harness}`

  return runWithLock(lockKey, async () => {
    onProgress('Checking for the latest version\n')

    // Re-resolve at click time: the install may have changed between the
    // user seeing the button and the lock actually being acquired.
    const reDetected = await detectInstalledAgents()
    const reStatus = await computeHarnessStatus(harness, reDetected[DETECT_KEY[harness]], { ...statusOpts, fresh: true })
    if (!reStatus.binaryPath) {
      const run: HarnessUpdateRunState = { harness, status: 'failed', message: 'Harness is not installed.', startedAt, finishedAt: new Date().toISOString() }
      return { harness, run, newStatus: reStatus }
    }
    const reDetection = resolveUpdateAction(harness, reStatus.binaryPath, resolveNpmPackageName(harness, reStatus.version))
    if ((reDetection.lockKey ?? `native:${harness}`) !== lockKey || !reStatus.canUpdate) {
      const run: HarnessUpdateRunState = { harness, status: 'failed', message: 'Installation changed — refresh and try again.', startedAt, finishedAt: new Date().toISOString() }
      return { harness, run, newStatus: reStatus }
    }

    const argv = reDetection.updateArgv
    if (!argv) {
      const run: HarnessUpdateRunState = { harness, status: 'failed', message: 'No update command available.', startedAt, finishedAt: new Date().toISOString() }
      return { harness, run, newStatus: reStatus }
    }

    // The writable-prefix check only makes sense for an actual `npm install -g
    // --prefix <dir> ...` argv — not merely because the underlying installer
    // happens to be npm-global while Pi's self-update override replaced the
    // argv with `pi update --self`.
    const prefixIndex = argv.args.indexOf('--prefix')
    if (prefixIndex !== -1) {
      const prefix = argv.args[prefixIndex + 1]
      if (prefix && !isPrefixWritable(prefix)) {
        const run: HarnessUpdateRunState = {
          harness,
          status: 'failed',
          message: `The npm global install location isn't writable. Run manually: ${reDetection.updateCommand}`,
          startedAt,
          finishedAt: new Date().toISOString()
        }
        return { harness, run, newStatus: reStatus }
      }
    }

    onProgress(`Running ${argv.cmd} ${argv.args.join(' ')}\n`)
    const spawnResult = await spawnUpdate(argv.cmd, argv.args, onProgress, deps.spawnImpl ?? defaultSpawn)

    if (!spawnResult.success) {
      const run: HarnessUpdateRunState = {
        harness,
        status: 'failed',
        message: spawnResult.timedOut ? 'Update timed out.' : `Update command exited with code ${spawnResult.code}.`,
        output: spawnResult.output,
        startedAt,
        finishedAt: new Date().toISOString()
      }
      return { harness, run, newStatus: reStatus }
    }

    onProgress('Verifying the installed version\n')
    if (npmPackageFor(harness, reStatus.version)) cache.clear(npmPackageFor(harness, reStatus.version)!)
    const verifiedDetected = await detectInstalledAgents()
    const newStatus = await computeHarnessStatus(harness, verifiedDetected[DETECT_KEY[harness]], { ...statusOpts, fresh: true })

    const unchanged = !newStatus.installed || newStatus.version === reStatus.version
    const run: HarnessUpdateRunState = {
      harness,
      status: unchanged ? 'unchanged' : 'succeeded',
      message: unchanged
        ? 'The version did not change. It may already have been up to date, or the update needs a manual step.'
        : (newStatus.hasActiveSession ? 'Updated. Restart running tasks to use the new version.' : 'Updated.'),
      output: spawnResult.output,
      startedAt,
      finishedAt: new Date().toISOString()
    }
    return { harness, run, newStatus }
  })
}

function npmPackageFor(harness: HarnessKey, version: string | null): string | null {
  return resolveNpmPackageName(harness, version)
}

function spawnUpdate(cmd: string, args: string[], onProgress: (chunk: string) => void, spawnImpl: SpawnLike): Promise<{ success: boolean; code: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawnImpl(cmd, args)
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, UPDATE_TIMEOUT_MS)

    const append = (chunk: Buffer): void => {
      const text = chunk.toString()
      if (output.length < OUTPUT_CAP_BYTES) output += text
      onProgress(text)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ success: false, code: null, timedOut: false, output: `${output}\n${err.message}` })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ success: !timedOut && code === 0, code, timedOut, output })
    })
  })
}

/** Updates every harness with `canUpdate`, sequentially per installer lock. Manual-only harnesses are skipped. */
export async function runUpdateAll(
  db: MaintenanceDb,
  onProgress: (harness: HarnessKey, chunk: string) => void,
  deps: UpdateDeps = {}
): Promise<HarnessUpdateAllResult> {
  const statuses = await refreshHarnessStatuses(db, { hasActiveSession: deps.hasActiveSession, fetchImpl: deps.fetchImpl, brewExec: deps.brewExec })
  const results: HarnessUpdateResult[] = []
  const skipped: HarnessKey[] = []

  for (const status of statuses) {
    if (!status.canUpdate) {
      skipped.push(status.harness)
      continue
    }
    const result = await runHarnessUpdate(db, status.harness, (chunk) => onProgress(status.harness, chunk), deps)
    results.push(result)
  }

  return { results, skipped }
}

// ── Periodic checks ─────────────────────────────────────────────────────────

let periodicTimer: NodeJS.Timeout | null = null

export function startPeriodicHarnessChecks(db: MaintenanceDb, onUpdated: (statuses: HarnessMaintenanceStatus[]) => void): void {
  stopPeriodicHarnessChecks()
  periodicTimer = setInterval(() => {
    if (!harnessUpdateChecksEnabled(db.getSetting(HARNESS_UPDATE_CHECKS_SETTING_KEY))) return
    void refreshHarnessStatuses(db).then(onUpdated)
  }, HARNESS_UPDATE_CHECK_INTERVAL_MS)
}

export function stopPeriodicHarnessChecks(): void {
  if (periodicTimer) clearInterval(periodicTimer)
  periodicTimer = null
}
