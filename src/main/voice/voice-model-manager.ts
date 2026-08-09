/**
 * On-demand speech model storage (design §5.10).
 *
 * Rules:
 *  - Download only after the user agrees, and only when the manifest carries a
 *    verified SHA-256 for every file.
 *  - Verify each file before it becomes visible. A partial file is written to a
 *    `.part` name and is renamed only after the checksum matches.
 *  - An interrupted download resumes from the bytes already on disk.
 *  - The user can delete a model and get the disk space back.
 *  - A model directory is versioned by model ID, so an app update never
 *    silently changes the model in use.
 */

import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { mkdir, rm, stat, rename, readdir, open } from 'fs/promises'
import { join } from 'path'
import { totalmem, freemem } from 'os'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import type { VoiceModelManifestEntry, VoiceModelState } from '../../shared/voice'
import {
  VOICE_MODEL_MANIFEST,
  findManifestEntry,
  isManifestVerified,
  manifestSizeBytes,
} from './voice-model-manifest'

export interface ResolvedModel {
  id: string
  dir: string
  encoder: string
  decoder: string
  joiner: string
  tokens: string
}

export interface VoiceModelManagerOptions {
  /** Root directory for downloaded models — normally `<userData>/voice-models`. */
  rootDir: string
  /** Injected for tests. */
  fetchImpl?: typeof fetch
  onProgress?: (state: VoiceModelState) => void
}

export class VoiceModelManager {
  private installing = new Map<string, number>()
  private errors = new Map<string, string>()
  private aborts = new Map<string, AbortController>()

  constructor(private options: VoiceModelManagerOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  modelDir(id: string): string {
    return join(this.options.rootDir, id)
  }

  async list(): Promise<VoiceModelState[]> {
    const states: VoiceModelState[] = []
    for (const entry of VOICE_MODEL_MANIFEST) {
      states.push({
        id: entry.id,
        label: entry.label,
        license: entry.license,
        languages: entry.languages,
        installed: await this.isInstalled(entry),
        installing: this.installing.has(entry.id),
        progress: this.installing.get(entry.id) ?? 0,
        sizeBytes: manifestSizeBytes(entry),
        downloadable: isManifestVerified(entry),
        ...(this.errors.has(entry.id) ? { error: this.errors.get(entry.id) } : {}),
      })
    }
    return states
  }

  async isInstalled(entry: VoiceModelManifestEntry): Promise<boolean> {
    const dir = this.modelDir(entry.id)
    for (const file of entry.files) {
      const info = await stat(join(dir, file.name)).catch(() => null)
      if (!info || !info.isFile() || info.size === 0) return false
    }
    return true
  }

  /**
   * Returns the paths the worker needs, or null when nothing usable is present.
   * A hand-installed directory wins over the catalogue so that a user is never
   * blocked by a pending checksum.
   */
  async resolve(modelId: string, customDir?: string): Promise<ResolvedModel | null> {
    if (customDir) {
      const resolved = await this.resolveCustomDir(customDir)
      if (resolved) return resolved
    }
    const entry = findManifestEntry(modelId)
    if (!entry) return null
    if (!(await this.isInstalled(entry))) return null
    const dir = this.modelDir(entry.id)
    return {
      id: entry.id,
      dir,
      encoder: join(dir, entry.roles.encoder),
      decoder: join(dir, entry.roles.decoder),
      joiner: join(dir, entry.roles.joiner),
      tokens: join(dir, entry.roles.tokens),
    }
  }

  /**
   * Accepts a directory that holds an encoder, a decoder, a joiner and a tokens
   * file, whatever their exact names are. This matches the layout of an
   * unpacked sherpa-onnx model release.
   */
  private async resolveCustomDir(dir: string): Promise<ResolvedModel | null> {
    const names = await readdir(dir).catch(() => null)
    if (!names) return null
    const pick = (needle: string, ext: string): string | undefined =>
      names.find((n) => n.toLowerCase().includes(needle) && n.toLowerCase().endsWith(ext))
    const encoder = pick('encoder', '.onnx')
    const decoder = pick('decoder', '.onnx')
    const joiner = pick('joiner', '.onnx')
    const tokens = names.find((n) => n.toLowerCase() === 'tokens.txt')
    if (!encoder || !decoder || !joiner || !tokens) return null
    return {
      id: 'custom',
      dir,
      encoder: join(dir, encoder),
      decoder: join(dir, decoder),
      joiner: join(dir, joiner),
      tokens: join(dir, tokens),
    }
  }

  /** Downloads and verifies one catalogue entry. */
  async install(id: string): Promise<VoiceModelState> {
    const entry = findManifestEntry(id)
    if (!entry) throw new Error(`Unknown voice model: ${id}`)
    if (!isManifestVerified(entry)) {
      throw new Error(
        `The checksum for "${entry.label}" is not recorded yet. ` +
          'Install the model by hand and set the custom model directory in Voice settings.'
      )
    }
    const needed = manifestSizeBytes(entry)
    if (freemem() < entry.minMemoryBytes && totalmem() < entry.minMemoryBytes) {
      throw new Error(`"${entry.label}" needs about ${Math.round(entry.minMemoryBytes / 1e9)} GB of memory.`)
    }

    const dir = this.modelDir(entry.id)
    await mkdir(dir, { recursive: true })
    const controller = new AbortController()
    this.aborts.set(entry.id, controller)
    this.errors.delete(entry.id)
    this.installing.set(entry.id, 0)
    this.emit(entry)

    let done = 0
    try {
      for (const file of entry.files) {
        const target = join(dir, file.name)
        const existing = await stat(target).catch(() => null)
        if (existing?.isFile() && (await sha256OfFile(target)) === file.sha256) {
          done += file.sizeBytes
          this.installing.set(entry.id, Math.min(1, done / needed))
          this.emit(entry)
          continue
        }
        await this.downloadFile(file.url, target, file.sha256, controller.signal, (bytes) => {
          this.installing.set(entry.id, Math.min(1, (done + bytes) / needed))
          this.emit(entry)
        })
        done += file.sizeBytes
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.errors.set(entry.id, message)
      this.installing.delete(entry.id)
      this.aborts.delete(entry.id)
      this.emit(entry)
      throw err
    }

    this.installing.delete(entry.id)
    this.aborts.delete(entry.id)
    this.emit(entry)
    const states = await this.list()
    return states.find((s) => s.id === entry.id) as VoiceModelState
  }

  cancel(id: string): void {
    this.aborts.get(id)?.abort()
    this.aborts.delete(id)
    this.installing.delete(id)
  }

  /** Removes the files and the directory of one model. */
  async remove(id: string): Promise<void> {
    this.cancel(id)
    await rm(this.modelDir(id), { recursive: true, force: true })
    this.errors.delete(id)
  }

  /** Removes every downloaded model (the "Delete models" control). */
  async removeAll(): Promise<void> {
    for (const entry of VOICE_MODEL_MANIFEST) this.cancel(entry.id)
    await rm(this.options.rootDir, { recursive: true, force: true })
    this.errors.clear()
  }

  private async downloadFile(
    url: string,
    target: string,
    expectedSha256: string,
    signal: AbortSignal,
    onBytes: (bytes: number) => void
  ): Promise<void> {
    const partial = `${target}.part`
    const already = (await stat(partial).catch(() => null))?.size ?? 0
    const headers: Record<string, string> = already > 0 ? { Range: `bytes=${already}-` } : {}

    const response = await this.fetchImpl(url, { headers, signal })
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status}) for ${url}`)
    }
    // The server ignored the range request, so start again from zero.
    const append = already > 0 && response.status === 206
    if (!append && already > 0) await rm(partial, { force: true })

    let received = append ? already : 0
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      onBytes(received)
    })
    await pipeline(source, createWriteStream(partial, { flags: append ? 'a' : 'w' }))

    const digest = await sha256OfFile(partial)
    if (digest !== expectedSha256) {
      await rm(partial, { force: true })
      throw new Error(`Checksum mismatch for ${url}`)
    }
    await rename(partial, target)
  }

  private emit(entry: VoiceModelManifestEntry): void {
    this.options.onProgress?.({
      id: entry.id,
      label: entry.label,
      license: entry.license,
      languages: entry.languages,
      installed: false,
      installing: this.installing.has(entry.id),
      progress: this.installing.get(entry.id) ?? 0,
      sizeBytes: manifestSizeBytes(entry),
      downloadable: isManifestVerified(entry),
      ...(this.errors.has(entry.id) ? { error: this.errors.get(entry.id) } : {}),
    })
  }
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
