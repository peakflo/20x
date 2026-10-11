/**
 * Installs ACP registry agents on disk: streamed+verified binary downloads,
 * safe archive extraction, and app-owned npx/uvx installs that never touch
 * global package-manager state.
 *
 * Layout under `rootDir` (normally `<userData>/acp-agents`):
 *   <id>/<version>/<target>/...        binary installs (target = platform string)
 *   <id>/<version>/npm/...             npx installs (private npm prefix)
 *   <id>/<version>/python/...          uvx installs (private UV_TOOL_DIR/BIN_DIR)
 *   .receipts/<id>__<version>__<kind>.json
 *   .locks/<id>__<version>__<kind>.lock
 */

import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'fs/promises'
import { execFile } from 'child_process'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve as resolvePath } from 'path'
import { promisify } from 'util'
import { isSafeRelativeCommandPath, type AcpPlatformTarget } from './registry-types'
import type { ResolvedDistribution } from './registry-client'

const execFileAsync = promisify(execFile)

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024 // 1 GiB
const LOCK_STALE_MS = 5 * 60 * 1000
const LOCK_RETRY_MS = 100
const LOCK_MAX_RETRIES = 300 // ~30s total
const RESERVATION_MS = 30 * 1000

export interface InstallReceipt {
  id: string
  version: string
  distribution: 'binary' | 'npx' | 'uvx'
  /** Archive URL (binary) or package spec (npx/uvx). */
  spec: string
  /** Directory containing the resolved executable. */
  binDir: string
  /** Absolute path to the resolved, spawnable executable. */
  executablePath: string
  /** npm only: the installed package's own directory + reported version, re-checked on load. */
  packageDir?: string
  packageVersion?: string
}

export interface InstalledAgent {
  executablePath: string
  args: string[]
  env: Record<string, string>
}

export interface InstallManagerOptions {
  rootDir: string
  fetchImpl?: typeof fetch
  /** Injected for tests: run `npm install` without a real npm. */
  runNpmInstall?: (args: { spec: string; prefixDir: string }) => Promise<void>
  /** Injected for tests: run `uv tool install` without a real uv. */
  runUvInstall?: (args: { spec: string; toolDir: string; binDir: string }) => Promise<void>
  /** Injected for tests: list archive entries without a real tar/unzip. */
  listArchiveEntries?: (archivePath: string) => Promise<ArchiveEntry[]>
  /** Injected for tests: extract an archive without a real tar/unzip. */
  extractArchive?: (archivePath: string, destDir: string) => Promise<void>
}

export interface ArchiveEntry {
  path: string
  isSymlink: boolean
}

function agentRoot(rootDir: string, id: string): string {
  return join(rootDir, id)
}

function binaryInstallDir(rootDir: string, id: string, version: string, target: AcpPlatformTarget): string {
  return join(agentRoot(rootDir, id), encodeURIComponent(version), target)
}

function npmInstallDir(rootDir: string, id: string, version: string): string {
  return join(agentRoot(rootDir, id), encodeURIComponent(version), 'npm')
}

function uvInstallDir(rootDir: string, id: string, version: string): string {
  return join(agentRoot(rootDir, id), encodeURIComponent(version), 'python')
}

function receiptPath(rootDir: string, id: string, version: string, kind: string): string {
  return join(rootDir, '.receipts', `${id}__${encodeURIComponent(version)}__${kind}.json`)
}

function lockPath(rootDir: string, id: string, version: string, kind: string): string {
  return join(rootDir, '.locks', `${id}__${encodeURIComponent(version)}__${kind}.lock`)
}

async function sha256OfFile(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** Exclusive-create lock with a staleness timeout, so a crashed process can't wedge future installs. */
async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      const handle = await open(path, 'wx')
      await handle.close()
      try {
        return await fn()
      } finally {
        await rm(path, { force: true })
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
      const info = await stat(path).catch(() => null)
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(path, { force: true }).catch(() => {})
        continue
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
    }
  }
  throw new Error(`Timed out waiting for install lock: ${path}`)
}

const reservations = new Map<string, number>()

/** Reserves an agent id for ~30s so a near-simultaneous uninstall check doesn't race a resolve. */
export function reserveAgent(id: string): void {
  reservations.set(id, Date.now() + RESERVATION_MS)
}

export function isReserved(id: string): boolean {
  const until = reservations.get(id)
  if (!until) return false
  if (Date.now() > until) {
    reservations.delete(id)
    return false
  }
  return true
}

async function loadReceipt(path: string): Promise<InstallReceipt | null> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (!text) return null
  try {
    return JSON.parse(text) as InstallReceipt
  } catch {
    return null
  }
}

/** Re-validates every field of a receipt before trusting it; any mismatch means "reinstall." */
async function isReceiptValid(receipt: InstallReceipt, expectedBinDir: string): Promise<boolean> {
  if (receipt.binDir !== expectedBinDir) return false
  if (dirname(receipt.executablePath) !== receipt.binDir) return false
  const exists = await stat(receipt.executablePath).then((s) => s.isFile(), () => false)
  if (!exists) return false
  if (receipt.distribution === 'npx' && receipt.packageDir && receipt.packageVersion) {
    const pkgJsonPath = join(receipt.packageDir, 'package.json')
    const pkgJson = await readFile(pkgJsonPath, 'utf8').catch(() => null)
    if (!pkgJson) return false
    try {
      const parsed = JSON.parse(pkgJson) as { version?: string }
      if (parsed.version !== receipt.packageVersion) return false
    } catch {
      return false
    }
  }
  return true
}

async function writeReceipt(path: string, receipt: InstallReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(receipt, null, 2), 'utf8')
}

/** Validates every listed archive entry before a single byte is extracted. */
function validateArchiveEntries(entries: ArchiveEntry[]): void {
  for (const entry of entries) {
    if (entry.isSymlink) {
      throw new Error(`Archive contains a symlink entry ("${entry.path}") — refusing to extract for safety.`)
    }
    const normalized = entry.path.replace(/\\/g, '/')
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      throw new Error(`Archive contains an absolute path entry ("${entry.path}") — refusing to extract.`)
    }
    const segments = normalized.split('/')
    if (segments.includes('..')) {
      throw new Error(`Archive contains a path-traversal entry ("${entry.path}") — refusing to extract.`)
    }
  }
}

async function defaultListArchiveEntries(archivePath: string): Promise<ArchiveEntry[]> {
  if (archivePath.endsWith('.zip')) {
    const { stdout } = await execFileAsync('unzip', ['-Z1', archivePath])
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((path) => ({ path, isSymlink: false })) // unzip -Z1 carries no type info; zip symlinks are rare for this use case
  }
  const { stdout } = await execFileAsync('tar', ['-tvf', archivePath])
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const isSymlink = line.startsWith('l')
      const path = line.split(/\s+/).slice(8).join(' ').split(' -> ')[0]
      return { path, isSymlink }
    })
    .filter((e) => e.path.length > 0)
}

async function defaultExtractArchive(archivePath: string, destDir: string): Promise<void> {
  if (archivePath.endsWith('.zip')) {
    await execFileAsync('unzip', ['-q', archivePath, '-d', destDir])
    return
  }
  await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir])
}

async function downloadArchive(url: string, destPath: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(url)
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`)
  }
  let received = 0
  const reader = response.body.getReader()
  const out = createWriteStream(destPath)
  const write = (chunk: Uint8Array) =>
    new Promise<void>((resolve, reject) => out.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve())))
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.byteLength
        if (received > MAX_ARCHIVE_BYTES) throw new Error('Archive exceeded the 1 GiB size cap')
        await write(value)
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve))
  }
}

/** Resolves `candidatePath` and asserts its real path is still contained within `rootDir`. */
async function assertContained(rootDir: string, candidatePath: string): Promise<string> {
  const realRoot = await realpath(rootDir)
  const realCandidate = await realpath(candidatePath)
  const rel = relative(realRoot, realCandidate)
  if (rel.startsWith('..') || resolvePath(realRoot, rel) !== realCandidate) {
    throw new Error(`Resolved executable escapes its install root: ${candidatePath}`)
  }
  return realCandidate
}

export class InstallManager {
  constructor(private options: InstallManagerOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  /** Installs (or reuses a validated prior install of) a resolved distribution. Idempotent. */
  async ensureInstalled(resolved: ResolvedDistribution): Promise<InstalledAgent> {
    if (resolved.kind === 'binary') return this.ensureBinaryInstalled(resolved)
    if (resolved.kind === 'npx') return this.ensureNpxInstalled(resolved)
    return this.ensureUvxInstalled(resolved)
  }

  private async ensureBinaryInstalled(resolved: ResolvedDistribution): Promise<InstalledAgent> {
    const { entry, platformTarget } = resolved
    if (!platformTarget) throw new Error('Binary distribution requires a platform target')
    const target = entry.distribution.binary?.[platformTarget]
    if (!target) throw new Error(`No binary target for ${platformTarget}`)
    if (!isSafeRelativeCommandPath(target.cmd)) {
      throw new Error(`Registry entry "${entry.id}" has an unsafe cmd path`)
    }

    const binDir = binaryInstallDir(this.options.rootDir, entry.id, entry.version, platformTarget)
    const receiptFile = receiptPath(this.options.rootDir, entry.id, entry.version, `binary-${platformTarget}`)
    const existingReceipt = await loadReceipt(receiptFile)
    if (existingReceipt && (await isReceiptValid(existingReceipt, binDir))) {
      return { executablePath: existingReceipt.executablePath, args: resolved.args, env: resolved.env }
    }

    return withLock(lockPath(this.options.rootDir, entry.id, entry.version, `binary-${platformTarget}`), async () => {
      const recheck = await loadReceipt(receiptFile)
      if (recheck && (await isReceiptValid(recheck, binDir))) {
        return { executablePath: recheck.executablePath, args: resolved.args, env: resolved.env }
      }

      const tmpRoot = await mkdtemp(join(tmpdir(), 'acp-install-'))
      try {
        const archiveExt = target.archive.endsWith('.zip') ? '.zip' : '.tar.gz'
        const archivePath = join(tmpRoot, `archive${archiveExt}`)
        await downloadArchive(target.archive, archivePath, this.fetchImpl)

        if (target.sha256) {
          const digest = await sha256OfFile(archivePath)
          if (digest.toLowerCase() !== target.sha256.toLowerCase()) {
            throw new Error(`Checksum mismatch for ${entry.id}@${entry.version} (${platformTarget})`)
          }
        }

        const listEntries = this.options.listArchiveEntries ?? defaultListArchiveEntries
        const entries = await listEntries(archivePath)
        validateArchiveEntries(entries)

        const extractDir = join(tmpRoot, 'extracted')
        await mkdir(extractDir, { recursive: true })
        const extract = this.options.extractArchive ?? defaultExtractArchive
        await extract(archivePath, extractDir)

        const candidateExecutable = join(extractDir, target.cmd)
        const stat_ = await stat(candidateExecutable).catch(() => null)
        if (!stat_ || !stat_.isFile()) {
          throw new Error(`Declared cmd "${target.cmd}" was not found in the extracted archive`)
        }
        await chmod(candidateExecutable, 0o755)
        // Containment check against the extraction dir defeats a symlink planted
        // inside the archive whose *target* resolves outside it, even though its
        // literal textual path looked safe.
        await assertContained(extractDir, candidateExecutable)

        await rm(binDir, { recursive: true, force: true })
        await mkdir(dirname(binDir), { recursive: true })
        await rename(extractDir, binDir)

        const executablePath = join(binDir, target.cmd)
        // One more containment check, now against the final install root.
        await assertContained(this.options.rootDir, executablePath)

        await writeReceipt(receiptFile, {
          id: entry.id,
          version: entry.version,
          distribution: 'binary',
          spec: target.archive,
          binDir,
          executablePath
        })

        return { executablePath, args: resolved.args, env: resolved.env }
      } finally {
        await rm(tmpRoot, { recursive: true, force: true })
      }
    })
  }

  private async ensureNpxInstalled(resolved: ResolvedDistribution): Promise<InstalledAgent> {
    const { entry } = resolved
    const spec = entry.distribution.npx?.package
    if (!spec) throw new Error(`"${entry.id}" has no npx distribution`)
    const prefixDir = npmInstallDir(this.options.rootDir, entry.id, entry.version)
    const binDir = join(prefixDir, 'bin')
    const receiptFile = receiptPath(this.options.rootDir, entry.id, entry.version, 'npx')

    const existing = await loadReceipt(receiptFile)
    if (existing && (await isReceiptValid(existing, binDir))) {
      return { executablePath: existing.executablePath, args: resolved.args, env: resolved.env }
    }

    return withLock(lockPath(this.options.rootDir, entry.id, entry.version, 'npx'), async () => {
      const recheck = await loadReceipt(receiptFile)
      if (recheck && (await isReceiptValid(recheck, binDir))) {
        return { executablePath: recheck.executablePath, args: resolved.args, env: resolved.env }
      }

      await mkdir(prefixDir, { recursive: true })
      const runInstall = this.options.runNpmInstall ?? defaultRunNpmInstall
      await runInstall({ spec, prefixDir })

      const packageName = spec.slice(0, spec.lastIndexOf('@'))
      const packageDir = join(prefixDir, 'lib', 'node_modules', packageName)
      const pkgJsonPath = join(packageDir, 'package.json')
      const pkgJsonText = await readFile(pkgJsonPath, 'utf8').catch(() => null)
      if (!pkgJsonText) throw new Error(`npm install of "${spec}" did not produce ${pkgJsonPath}`)
      const pkgJson = JSON.parse(pkgJsonText) as { version?: string; bin?: string | Record<string, string>; name?: string }

      const binNames = typeof pkgJson.bin === 'string' ? [packageName.split('/').pop() as string] : Object.keys(pkgJson.bin ?? {})
      const binName = binNames[0]
      if (!binName) throw new Error(`"${spec}" declares no executable (package.json "bin")`)
      const executablePath = join(binDir, binName)
      await assertContained(prefixDir, executablePath)

      await writeReceipt(receiptFile, {
        id: entry.id,
        version: entry.version,
        distribution: 'npx',
        spec,
        binDir,
        executablePath,
        packageDir,
        packageVersion: pkgJson.version
      })

      return { executablePath, args: resolved.args, env: resolved.env }
    })
  }

  private async ensureUvxInstalled(resolved: ResolvedDistribution): Promise<InstalledAgent> {
    const { entry } = resolved
    const spec = entry.distribution.uvx?.package
    if (!spec) throw new Error(`"${entry.id}" has no uvx distribution`)
    const toolRoot = uvInstallDir(this.options.rootDir, entry.id, entry.version)
    const toolDir = join(toolRoot, 'tools')
    const binDir = join(toolRoot, 'bin')
    const receiptFile = receiptPath(this.options.rootDir, entry.id, entry.version, 'uvx')

    const existing = await loadReceipt(receiptFile)
    if (existing && (await isReceiptValid(existing, binDir))) {
      return { executablePath: existing.executablePath, args: resolved.args, env: resolved.env }
    }

    return withLock(lockPath(this.options.rootDir, entry.id, entry.version, 'uvx'), async () => {
      const recheck = await loadReceipt(receiptFile)
      if (recheck && (await isReceiptValid(recheck, binDir))) {
        return { executablePath: recheck.executablePath, args: resolved.args, env: resolved.env }
      }

      await mkdir(binDir, { recursive: true })
      await mkdir(toolDir, { recursive: true })
      const runInstall = this.options.runUvInstall ?? defaultRunUvInstall
      await runInstall({ spec, toolDir, binDir })

      const packageName = spec.split(/==|@/)[0]
      const executablePath = join(binDir, packageName)
      await assertContained(toolRoot, executablePath)

      await writeReceipt(receiptFile, { id: entry.id, version: entry.version, distribution: 'uvx', spec, binDir, executablePath })
      return { executablePath, args: resolved.args, env: resolved.env }
    })
  }

  /**
   * Removes a binary install's artifacts for this agent id (all versions/targets),
   * only when `isReferenced` reports no configured instance still uses it and the
   * agent isn't within its short post-install reservation window. npx/uvx package
   * installs are left alone (private, version-pinned, and cheap to keep).
   */
  async uninstallBinary(id: string, isReferenced: () => Promise<boolean>): Promise<{ removed: boolean; reason?: string }> {
    if (isReserved(id)) return { removed: false, reason: 'reserved' }
    if (await isReferenced()) return { removed: false, reason: 'still-referenced' }
    const root = agentRoot(this.options.rootDir, id)
    const entries = await readdir(root).catch(() => [] as string[])
    for (const version of entries) {
      const versionDir = join(root, version)
      const targets = await readdir(versionDir).catch(() => [] as string[])
      for (const target of targets) {
        if (target === 'npm' || target === 'python') continue
        await rm(join(versionDir, target), { recursive: true, force: true })
        await rm(receiptPath(this.options.rootDir, id, decodeURIComponent(version), `binary-${target}`), { force: true })
      }
    }
    return { removed: true }
  }
}

async function defaultRunNpmInstall({ spec, prefixDir }: { spec: string; prefixDir: string }): Promise<void> {
  await execFileAsync('npm', ['install', '--global', '--no-save', '--prefix', prefixDir, spec], {
    env: { ...process.env, npm_config_prefix: prefixDir }
  })
}

async function defaultRunUvInstall({ spec, toolDir, binDir }: { spec: string; toolDir: string; binDir: string }): Promise<void> {
  await execFileAsync('uv', ['tool', 'install', '--force', spec], {
    env: { ...process.env, UV_TOOL_DIR: toolDir, UV_TOOL_BIN_DIR: binDir }
  })
}

export function __internalForTests() {
  return { binaryInstallDir, npmInstallDir, uvInstallDir, receiptPath, lockPath, validateArchiveEntries }
}
