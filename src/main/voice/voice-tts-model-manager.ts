/**
 * On-demand speech-synthesis model storage (design §5.10).
 *
 * The rules match `VoiceModelManager`, which does the same job for speech
 * recognition:
 *  - download only after the user agrees, and only when the manifest carries a
 *    verified SHA-256,
 *  - verify before anything becomes visible,
 *  - resume an interrupted download,
 *  - let the user delete a model and get the disk space back,
 *  - keep one directory per model ID, so an app update never silently changes
 *    the voice in use.
 *
 * The one difference is the shape of the download. A voice needs an
 * `espeak-ng-data` directory of about 355 files, so the catalogue points at the
 * published archive. The archive is checksummed as a whole and is extracted
 * only after that value matches.
 */

import { createHash } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, rm, stat, rename, open } from 'fs/promises'
import { dirname, join, sep } from 'path'
import { totalmem, freemem } from 'os'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import bz2 from 'unbzip2-stream'
import { extract as tarExtract } from 'tar-stream'
import type { VoiceTtsModelManifestEntry, VoiceTtsModelState } from '../../shared/voice-tts'
import {
  VOICE_TTS_MODEL_MANIFEST,
  findTtsManifestEntry,
  isTtsManifestVerified,
} from './voice-tts-manifest'

export interface ResolvedTtsModel {
  id: string
  family: 'kokoro' | 'kitten'
  dir: string
  model: string
  voices: string
  tokens: string
  dataDir: string
  sampleRate: number
}

export interface VoiceTtsModelManagerOptions {
  /** Normally `<userData>/voice-tts-models`. */
  rootDir: string
  fetchImpl?: typeof fetch
  onProgress?: (state: VoiceTtsModelState) => void
  /** How a dropped download is retried. Narrowed in tests so they stay quick. */
  retry?: { attempts?: number; baseDelayMs?: number }
}

/** The download is most of the wait; extraction is the rest. */
const DOWNLOAD_SHARE = 0.9

/**
 * How many times a dropped download is resumed before the user is told.
 *
 * Each attempt continues from the bytes already on disk, so this is a budget
 * for interruptions and not for repeated whole downloads.
 */
export const VOICE_TTS_DOWNLOAD_ATTEMPTS = 6

export class VoiceTtsModelManager {
  private installing = new Map<string, number>()
  private errors = new Map<string, string>()
  private aborts = new Map<string, AbortController>()

  constructor(private options: VoiceTtsModelManagerOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  private get attempts(): number {
    return Math.max(1, this.options.retry?.attempts ?? VOICE_TTS_DOWNLOAD_ATTEMPTS)
  }

  private get baseDelayMs(): number {
    return this.options.retry?.baseDelayMs ?? 500
  }

  modelDir(id: string): string {
    return join(this.options.rootDir, id)
  }

  async list(activeId?: string): Promise<VoiceTtsModelState[]> {
    const states: VoiceTtsModelState[] = []
    for (const entry of VOICE_TTS_MODEL_MANIFEST) {
      states.push(this.describe(entry, activeId, await this.isInstalled(entry)))
    }
    return states
  }

  async isInstalled(entry: VoiceTtsModelManifestEntry): Promise<boolean> {
    const dir = this.modelDir(entry.id)
    for (const relative of [entry.files.model, entry.files.voices, entry.files.tokens]) {
      const info = await stat(join(dir, relative)).catch(() => null)
      if (!info?.isFile() || info.size === 0) return false
    }
    const data = await stat(join(dir, entry.files.dataDir)).catch(() => null)
    return Boolean(data?.isDirectory())
  }

  /** The paths the worker needs, or null when the model is not on disk. */
  async resolve(id: string): Promise<ResolvedTtsModel | null> {
    const entry = findTtsManifestEntry(id)
    if (!entry) return null
    if (!(await this.isInstalled(entry))) return null
    const dir = this.modelDir(entry.id)
    return {
      id: entry.id,
      family: entry.family,
      dir,
      model: join(dir, entry.files.model),
      voices: join(dir, entry.files.voices),
      tokens: join(dir, entry.files.tokens),
      dataDir: join(dir, entry.files.dataDir),
      sampleRate: entry.sampleRate,
    }
  }

  /** Downloads, verifies and extracts one catalogue entry. */
  async install(id: string): Promise<VoiceTtsModelState> {
    const entry = findTtsManifestEntry(id)
    if (!entry) throw new Error(`Unknown voice model: ${id}`)
    if (!isTtsManifestVerified(entry)) {
      throw new Error(`The checksum for "${entry.label}" is not recorded yet.`)
    }
    if (freemem() < entry.minMemoryBytes && totalmem() < entry.minMemoryBytes) {
      throw new Error(`"${entry.label}" needs about ${Math.round(entry.minMemoryBytes / 1e9)} GB of memory.`)
    }

    await mkdir(this.options.rootDir, { recursive: true })
    const controller = new AbortController()
    this.aborts.set(entry.id, controller)
    this.errors.delete(entry.id)
    this.setProgress(entry, 0)

    const archivePath = join(this.options.rootDir, `${entry.id}.tar.bz2`)
    const stagingDir = join(this.options.rootDir, `${entry.id}.incomplete`)
    const finalDir = this.modelDir(entry.id)

    try {
      await this.download(entry, archivePath, controller.signal)
      await rm(stagingDir, { recursive: true, force: true })
      await extractTarBz2(archivePath, stagingDir, controller.signal, (done, total) => {
        this.setProgress(entry, DOWNLOAD_SHARE + (1 - DOWNLOAD_SHARE) * Math.min(1, done / Math.max(1, total)))
      })
      // The old directory only goes when the new one is complete, so a failed
      // update never leaves the user without a voice.
      await rm(finalDir, { recursive: true, force: true })
      await rename(stagingDir, finalDir)
      await rm(archivePath, { force: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      this.errors.set(entry.id, message)
      this.installing.delete(entry.id)
      this.aborts.delete(entry.id)
      this.emit(entry)
      throw err
    }

    this.installing.delete(entry.id)
    this.aborts.delete(entry.id)
    // The closing report says the voice is installed. Reporting `false` here
    // would make a finished download look like one that had gone back to the
    // beginning.
    this.emit(entry, true)
    return this.describe(entry, entry.id, true)
  }

  cancel(id: string): void {
    this.aborts.get(id)?.abort()
    this.aborts.delete(id)
    this.installing.delete(id)
  }

  async remove(id: string): Promise<void> {
    this.cancel(id)
    await rm(this.modelDir(id), { recursive: true, force: true })
    await rm(join(this.options.rootDir, `${id}.tar.bz2`), { force: true })
    await rm(join(this.options.rootDir, `${id}.tar.bz2.part`), { force: true })
    this.errors.delete(id)
  }

  async removeAll(): Promise<void> {
    for (const entry of VOICE_TTS_MODEL_MANIFEST) this.cancel(entry.id)
    await rm(this.options.rootDir, { recursive: true, force: true })
    this.errors.clear()
  }

  // ── Internals ─────────────────────────────────────────────

  /**
   * Fetches the archive, resuming a part file, and checks the SHA-256.
   *
   * A connection that drops part of the way through is normal on a download
   * this size, and it is what a single-shot fetch reports to the user as
   * "TypeError: terminated". Measured in the Electron main process, the same
   * 26 MB archive dropped at 19.5 MB and at 8.8 MB on consecutive attempts,
   * through both network stacks, while the same request from plain Node
   * completed.
   *
   * So a drop is treated as ordinary. The bytes already on disk are kept, the
   * next attempt asks for the rest with a `Range` header, and only a download
   * that fails repeatedly reaches the user — as a sentence rather than as a
   * `TypeError`.
   */
  private async download(
    entry: VoiceTtsModelManifestEntry,
    target: string,
    signal: AbortSignal
  ): Promise<void> {
    const existing = await stat(target).catch(() => null)
    if (existing?.isFile() && (await sha256OfFile(target)) === entry.archive.sha256) {
      this.setProgress(entry, DOWNLOAD_SHARE)
      return
    }

    const partial = `${target}.part`
    let lastFailure = ''

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      if (signal.aborted) throw new Error('The download was cancelled.')
      try {
        const resumed = await this.downloadOnce(entry, partial, signal)

        if ((await sha256OfFile(partial)) === entry.archive.sha256) {
          await rename(partial, target)
          this.setProgress(entry, DOWNLOAD_SHARE)
          return
        }
        // The assembled bytes are wrong, so they go.
        await rm(partial, { force: true })
        // A download taken in one piece that still does not match is not a
        // network problem: those are the bytes the server serves. Retrying
        // would download 100 MB again to reach the same answer.
        if (!resumed) {
          throw new Error(`The download of "${entry.label}" did not match its checksum.`)
        }
        // A resumed one may have been stitched together wrongly, so the next
        // attempt starts from zero.
        lastFailure = 'the downloaded bytes did not match the recorded checksum'
      } catch (err) {
        if (err instanceof Error && err.message.includes('did not match its checksum')) throw err
        if (signal.aborted) throw new Error('The download was cancelled.')
        lastFailure = describeDownloadFailure(err)
      }

      if (attempt < this.attempts) {
        // Back off a little, so a server that is refusing is not hammered.
        await delay(Math.min(8 * this.baseDelayMs, this.baseDelayMs * 2 ** (attempt - 1)), signal)
      }
    }

    throw new Error(
      `“${entry.label}” could not be downloaded after ${this.attempts} attempts: ${lastFailure}. ` +
        'Check the network connection and try again; what has already been downloaded is kept.'
    )
  }

  /**
   * One attempt. Appends to the part file when the server allows it.
   *
   * Returns true when it carried on from bytes that were already on disk.
   */
  private async downloadOnce(
    entry: VoiceTtsModelManifestEntry,
    partial: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const already = (await stat(partial).catch(() => null))?.size ?? 0
    // Nothing left to ask for: the previous attempt finished the bytes and
    // only the checksum is outstanding.
    if (already >= entry.archive.sizeBytes) return already > 0

    const headers: Record<string, string> = already > 0 ? { Range: `bytes=${already}-` } : {}
    const response = await this.fetchImpl(entry.archive.url, { headers, signal })
    if (!response.ok || !response.body) {
      throw new Error(`the server answered ${response.status}`)
    }
    // The server ignored the range request, so start again from zero.
    const append = already > 0 && response.status === 206
    if (!append && already > 0) await rm(partial, { force: true })

    let received = append ? already : 0
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      this.setProgress(entry, DOWNLOAD_SHARE * Math.min(1, received / entry.archive.sizeBytes))
    })
    await pipeline(source, createWriteStream(partial, { flags: append ? 'a' : 'w' }))
    return append
  }

  private setProgress(entry: VoiceTtsModelManifestEntry, progress: number): void {
    this.installing.set(entry.id, Math.min(1, Math.max(0, progress)))
    this.emit(entry)
  }

  private describe(
    entry: VoiceTtsModelManifestEntry,
    activeId: string | undefined,
    installed: boolean
  ): VoiceTtsModelState {
    return {
      id: entry.id,
      label: entry.label,
      description: entry.description,
      license: entry.license,
      licenseUrl: entry.licenseUrl,
      languages: entry.languages,
      installed,
      active: entry.id === activeId,
      installing: this.installing.has(entry.id),
      progress: this.installing.get(entry.id) ?? 0,
      sizeBytes: entry.archive.sizeBytes,
      unpackedBytes: entry.archive.unpackedBytes,
      downloadable: isTtsManifestVerified(entry),
      speakerCount: entry.speakers.length,
      ...(this.errors.has(entry.id) ? { error: this.errors.get(entry.id) } : {}),
    }
  }

  private emit(entry: VoiceTtsModelManifestEntry, installed = false): void {
    this.options.onProgress?.(this.describe(entry, undefined, installed))
  }
}

/**
 * Turns a network failure into words.
 *
 * `fetch` reports a dropped connection as `TypeError: terminated`, which tells
 * the user nothing at all. The real reason sits in `cause`.
 */
export function describeDownloadFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  const causeText =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  if (err.message === 'terminated' || /terminated|socket|closed|reset|ECONNRESET/i.test(causeText)) {
    return `the connection closed early${causeText ? ` (${causeText})` : ''}`
  }
  return causeText ? `${err.message} (${causeText})` : err.message
}

/** Waits, and gives up early when the user cancels. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

// ── Archive extraction ──────────────────────────────────────

/**
 * Unpacks a `.tar.bz2` into `targetDir`, dropping the single top directory the
 * publisher wraps everything in.
 *
 * Every entry name is checked before anything is written. A name that climbs
 * out of `targetDir`, an absolute name, and every entry that is not a plain
 * file or a directory are refused, so a tampered archive cannot write outside
 * the model directory.
 */
export async function extractTarBz2(
  archivePath: string,
  targetDir: string,
  signal?: AbortSignal,
  onProgress?: (bytesWritten: number, totalBytes: number) => void
): Promise<void> {
  const totalBytes = (await stat(archivePath)).size
  await mkdir(targetDir, { recursive: true })

  const extract = tarExtract()
  let written = 0

  const done = new Promise<void>((resolve, reject) => {
    extract.on('error', reject)
    extract.on('finish', resolve)
    extract.on('entry', (header, stream, next) => {
      void (async () => {
        try {
          if (signal?.aborted) throw new Error('The install was cancelled.')
          const relative = stripRoot(header.name)
          if (relative === null || (header.type !== 'file' && header.type !== 'directory')) {
            stream.resume()
            return
          }
          const destination = join(targetDir, relative)
          if (header.type === 'directory') {
            await mkdir(destination, { recursive: true })
            stream.resume()
            return
          }
          await mkdir(dirname(destination), { recursive: true })
          await pipeline(stream, createWriteStream(destination))
          written += header.size ?? 0
          onProgress?.(written, totalBytes)
        } catch (err) {
          extract.destroy(err instanceof Error ? err : new Error(String(err)))
        } finally {
          next()
        }
      })()
    })
  })

  await pipeline(createReadStream(archivePath), bz2(), extract)
  await done
}

/**
 * Removes the first path segment and refuses anything that could escape the
 * target directory. Returns null when the entry must be skipped.
 */
export function stripRoot(name: string): string | null {
  const normalised = name.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalised || normalised.startsWith('/') || /^[A-Za-z]:/.test(normalised)) return null
  const parts = normalised.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.some((part) => part === '..')) return null
  parts.shift()
  if (parts.length === 0) return null
  return parts.join(sep)
}

export async function sha256OfFile(path: string): Promise<string> {
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
