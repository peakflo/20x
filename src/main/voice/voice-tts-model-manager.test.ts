import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { VoiceTtsModelManager, extractTarBz2, sha256OfFile, stripRoot } from './voice-tts-model-manager'

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
