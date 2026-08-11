import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { stat } from 'fs/promises'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  VoiceTtsModelManager,
  describeDownloadFailure,
  extractTarBz2,
  sha256OfFile,
  stripRoot,
} from './voice-tts-model-manager'
import { findTtsManifestEntry } from './voice-tts-manifest'

/**
 * The manager writes a downloaded archive into the user's application data, so
 * the two things that matter are: nothing is unpacked unless the checksum
 * matches, and no entry can write outside the model directory.
 */

/** A two-file `.tar.bz2` built for this test, wrapped in one directory. */
const FIXTURE_TAR_BZ2 = [
  'QlpoOTFBWSZTWf9V/FwAAc3//f+8I4BQA//ifmf98P7v//BAgABALgAABAAEAAQASFADPgAAADjJgmhkMjIyaGgDQZGEA0Gj',
  'TIYhoAcZME0MhkZGTQ0AaDIwgGg0aZDENADjJgmhkMjIyaGgDQZGEA0GjTIYhoAcZME0MhkZGTQ0AaDIwgGg0aZDENAAqSQR',
  'qaT0mU9MU8k9TZA0htIADNTGiMTBNM1NPKcZoOUnjJ7z0O/St2zzrdB7DfddRcdUlfE3Dx6l8ek2DZPgLA3iiTslGwbZiXAb',
  'RQZUS4oi8UE/g3Sx8xQTY4uKuLuVpr6LX5o2wm8SxJHTKO6UTQQowLD4lOIpebx7jj1u908ROcUcRRNwTgJRK2KqqqpTWJym',
  'CbRNuunja6rs1rMG2cBpPCdrzZjMPQnqTMdyX+sm+OAn9zznIdLCqVUqhtJsaQm6WLAmgn4koTk3/F3+Tl8l3n5eDyaCd3SJ',
  'YmvC6pRLoTtqJ2OG7r4SYkxX7OOF6q+oyMsr2BOMtGYlYEuKyJt6mBM5b/jG7PlhnLEz3qwk8HDfgZ8+dKKzHKfoW6xrsCZk',
  '0Vp6UTVqpMMjIvdLNZqk3jJMgyrE05qJV+a1sUtlYlTC4wxMNfPGpnLF9tThJi8xsnVOU8phuH0nhLvQV/I8JbsHWFt4yOYu',
  'S47xxz06T0lH5ncMxeXmoZXlapeWPLOyWJ5Hbo/o3kYk5ifYTOTEntTaHrNL7zInqM49xrD2JpJmPbNftk5D1Eo8BR1j3pzE',
  '95O6apOHVrAnim4TPJSiqq/CjqJkcJMjE3TOTSTYT4TEl5LE2jMT5SxMJJiTaS0kynyE6pPGmgmYlEoTdJumdcTOLJNYmJLi',
  'a8vTmJom/KzpoJsGz1K1BrkxGtOYnTOsTaJ1ztHwJo1dfgcS3RazeNY1hrzbJuk4znG4Nkc4o+JROgc46BcH/i7kinChIf6r',
  '+Lg=',
].join('')

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '20x-tts-models-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('stripRoot', () => {
  it('drops the single wrapping directory', () => {
    expect(stripRoot('kokoro-int8-en-v0_19/model.int8.onnx')).toBe('model.int8.onnx')
    expect(stripRoot('root/espeak-ng-data/en_dict')).toBe(join('espeak-ng-data', 'en_dict'))
  })

  it('refuses an entry that climbs out of the directory', () => {
    expect(stripRoot('root/../../etc/passwd')).toBeNull()
    expect(stripRoot('../evil')).toBeNull()
  })

  it('refuses an absolute entry', () => {
    expect(stripRoot('/etc/passwd')).toBeNull()
    expect(stripRoot('C:\\Windows\\system32')).toBeNull()
  })

  it('skips the wrapping directory itself', () => {
    expect(stripRoot('root/')).toBeNull()
    expect(stripRoot('root')).toBeNull()
  })
})

describe('install', () => {
  it('refuses a voice whose checksum is not recorded', async () => {
    const manager = new VoiceTtsModelManager({ rootDir: root })
    await expect(manager.install('not-a-voice')).rejects.toThrow(/Unknown voice model/)
  })

  it('refuses bytes that do not match the recorded checksum', async () => {
    const manager = new VoiceTtsModelManager({
      rootDir: root,
      fetchImpl: (async () =>
        new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch,
    })
    await expect(manager.install('kitten-nano-en-v0_2')).rejects.toThrow(/did not match its checksum/)
    // Nothing usable is left behind.
    expect(await manager.resolve('kitten-nano-en-v0_2')).toBeNull()
  })

  it('reports a voice as not installed until every file is there', async () => {
    const manager = new VoiceTtsModelManager({ rootDir: root })
    const dir = join(root, 'kitten-nano-en-v0_2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'model.fp16.onnx'), 'x')
    expect(await manager.resolve('kitten-nano-en-v0_2')).toBeNull()

    writeFileSync(join(dir, 'voices.bin'), 'x')
    writeFileSync(join(dir, 'tokens.txt'), 'x')
    mkdirSync(join(dir, 'espeak-ng-data'), { recursive: true })
    const resolved = await manager.resolve('kitten-nano-en-v0_2')
    expect(resolved?.family).toBe('kitten')
    expect(resolved?.model).toBe(join(dir, 'model.fp16.onnx'))
    expect(resolved?.dataDir).toBe(join(dir, 'espeak-ng-data'))
  })

  it('lists a voice with its size, licence and speaker count', async () => {
    const manager = new VoiceTtsModelManager({ rootDir: root })
    const states = await manager.list('kokoro-en-v0_19')
    const kokoro = states.find((s) => s.id === 'kokoro-en-v0_19')
    expect(kokoro?.active).toBe(true)
    expect(kokoro?.installed).toBe(false)
    expect(kokoro?.downloadable).toBe(true)
    expect(kokoro?.speakerCount).toBe(8)
    expect(kokoro?.license).toBe('Apache-2.0')
  })

  it('gives the disk space back when a voice is deleted', async () => {
    const manager = new VoiceTtsModelManager({ rootDir: root })
    const dir = join(root, 'kitten-nano-en-v0_2')
    mkdirSync(join(dir, 'espeak-ng-data'), { recursive: true })
    writeFileSync(join(dir, 'model.fp16.onnx'), 'x')
    await manager.remove('kitten-nano-en-v0_2')
    expect(existsSync(dir)).toBe(false)
  })
})

describe('extractTarBz2', () => {
  it('unpacks a real bzip2 archive and drops the wrapping directory', async () => {
    const archive = join(root, 'fixture.tar.bz2')
    writeFileSync(archive, Buffer.from(FIXTURE_TAR_BZ2, 'base64'))
    const target = join(root, 'out')

    await extractTarBz2(archive, target)

    expect(readFileSync(join(target, 'tokens.txt'), 'utf8')).toBe('a b c')
    expect(readFileSync(join(target, 'espeak-ng-data', 'en_dict'), 'utf8')).toBe('dict')
    // The wrapping directory is gone, so the worker reads a fixed layout.
    expect(existsSync(join(target, 'wrapper'))).toBe(false)
  })
})

describe('sha256OfFile', () => {
  it('hashes a file the same way the catalogue records it', async () => {
    const file = join(root, 'x.bin')
    writeFileSync(file, 'abc')
    expect(await sha256OfFile(file)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})

describe('a dropped connection', () => {
  /**
   * A download this size drops part of the way through. Measured in the
   * Electron main process, the 26 MB archive dropped at 19.5 MB and at 8.8 MB
   * on consecutive attempts, through both network stacks. A single-shot fetch
   * reports that to the user as "TypeError: terminated".
   */
  const PART = 'kitten-nano-en-v0_2.tar.bz2.part'

  function dropped(bytes: number, status: number): Response {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes))
        },
        pull(controller) {
          controller.error(
            Object.assign(new TypeError('terminated'), { cause: new Error('other side closed') })
          )
        },
      }),
      { status }
    )
  }

  /** The offset a request asks to resume from, or 0 for a whole file. */
  function rangeOffset(headers: Record<string, string> | undefined): number {
    const value = headers?.Range
    return value ? Number(/^bytes=(\d+)-$/.exec(value)?.[1] ?? -1) : 0
  }

  async function partSize(): Promise<number> {
    return (await stat(join(root, PART)).catch(() => null))?.size ?? 0
  }

  it('asks for the rest, never for the whole file again', async () => {
    const asked: number[] = []
    const onDisk: number[] = []
    const manager = new VoiceTtsModelManager({
      rootDir: root,
      retry: { attempts: 3, baseDelayMs: 1 },
      fetchImpl: (async (_url: string, init: { headers: Record<string, string> }) => {
        asked.push(rangeOffset(init.headers))
        onDisk.push(await partSize())
        return dropped(1024, asked.length === 1 ? 200 : 206)
      }) as unknown as typeof fetch,
    })

    await expect(manager.install('kitten-nano-en-v0_2')).rejects.toThrow()

    expect(asked).toHaveLength(3)
    // The first attempt takes the whole file; each later one resumes from
    // exactly what is already on disk.
    expect(asked[0]).toBe(0)
    expect(asked[1]).toBe(onDisk[1])
    expect(asked[2]).toBe(onDisk[2])
  })

  it('tells the user in words, never as "TypeError: terminated"', async () => {
    const manager = new VoiceTtsModelManager({
      rootDir: root,
      retry: { attempts: 2, baseDelayMs: 1 },
      fetchImpl: (async () => dropped(512, 206)) as unknown as typeof fetch,
    })

    await expect(manager.install('kitten-nano-en-v0_2')).rejects.toThrow(
      /could not be downloaded after 2 attempts: the connection closed early/
    )
    await expect(manager.install('kitten-nano-en-v0_2')).rejects.not.toThrow(/TypeError/)
  })

  it('completes as soon as an attempt gets through', async () => {
    const entry = findTtsManifestEntry('kitten-nano-en-v0_2')
    const payload = Buffer.from(FIXTURE_TAR_BZ2, 'base64')
    // The manifest checksum belongs to the real 26 MB archive, so this test
    // points the entry at the fixture. Every other step is the real code path.
    const original = { sha256: entry!.archive.sha256, sizeBytes: entry!.archive.sizeBytes }
    entry!.archive.sha256 = createHash('sha256').update(payload).digest('hex')
    entry!.archive.sizeBytes = payload.length

    let attempts = 0
    const manager = new VoiceTtsModelManager({
      rootDir: root,
      retry: { attempts: 4, baseDelayMs: 1 },
      fetchImpl: (async (_url: string, init: { headers: Record<string, string> }) => {
        attempts += 1
        // The server honours the range, exactly as the real one does.
        const from = rangeOffset(init.headers)
        if (attempts < 3) return dropped(32, from > 0 ? 206 : 200)
        return new Response(payload.subarray(from), { status: from > 0 ? 206 : 200 })
      }) as unknown as typeof fetch,
    })

    try {
      const state = await manager.install('kitten-nano-en-v0_2')

      expect(state.installed).toBe(true)
      expect(attempts).toBe(3)
      expect(readFileSync(join(root, 'kitten-nano-en-v0_2', 'tokens.txt'), 'utf8')).toBe('a b c')
      // The archive is not kept once it is unpacked.
      expect(existsSync(join(root, 'kitten-nano-en-v0_2.tar.bz2'))).toBe(false)
      expect(existsSync(join(root, PART))).toBe(false)
    } finally {
      entry!.archive.sha256 = original.sha256
      entry!.archive.sizeBytes = original.sizeBytes
    }
  })

  it('stops retrying when the user cancels', async () => {
    let attempts = 0
    const manager: VoiceTtsModelManager = new VoiceTtsModelManager({
      rootDir: root,
      retry: { attempts: 5, baseDelayMs: 1 },
      fetchImpl: (async () => {
        attempts += 1
        manager.cancel('kitten-nano-en-v0_2')
        return dropped(128, 206)
      }) as unknown as typeof fetch,
    })

    await expect(manager.install('kitten-nano-en-v0_2')).rejects.toThrow(/cancelled/)
    expect(attempts).toBe(1)
  })
})

describe('describeDownloadFailure', () => {
  it('turns a terminated fetch into a sentence', () => {
    const err = Object.assign(new TypeError('terminated'), { cause: new Error('other side closed') })
    expect(describeDownloadFailure(err)).toBe('the connection closed early (other side closed)')
  })

  it('keeps a reason that already reads well', () => {
    expect(describeDownloadFailure(new Error('the server answered 404'))).toBe('the server answered 404')
  })

  it('copes with something that is not an error at all', () => {
    expect(describeDownloadFailure('odd')).toBe('odd')
  })
})
