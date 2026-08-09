import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { VoiceModelManager, sha256OfFile } from './voice-model-manager'
import { VOICE_MODEL_MANIFEST, isManifestVerified } from './voice-model-manifest'
import type { VoiceModelManifestEntry } from '../../shared/voice'

const CONTENT = Buffer.from('a tiny stand-in for a speech model file')
const DIGEST = createHash('sha256').update(CONTENT).digest('hex')

function verifiedEntry(): VoiceModelManifestEntry {
  const file = (name: string) => ({
    name,
    url: `https://example.invalid/${name}`,
    sha256: DIGEST,
    sizeBytes: CONTENT.length,
  })
  return {
    id: 'test-model',
    label: 'Test model',
    languages: ['en'],
    license: 'Apache-2.0',
    licenseUrl: 'https://example.invalid/license',
    minMemoryBytes: 1,
    files: [file('encoder.onnx'), file('decoder.onnx'), file('joiner.onnx'), file('tokens.txt')],
    roles: {
      encoder: 'encoder.onnx',
      decoder: 'decoder.onnx',
      joiner: 'joiner.onnx',
      tokens: 'tokens.txt',
    },
  }
}

let root: string
let added: VoiceModelManifestEntry | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'voice-models-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  if (added) {
    VOICE_MODEL_MANIFEST.splice(VOICE_MODEL_MANIFEST.indexOf(added), 1)
    added = null
  }
})

function addToManifest(entry: VoiceModelManifestEntry): VoiceModelManifestEntry {
  VOICE_MODEL_MANIFEST.push(entry)
  added = entry
  return entry
}

describe('voice model manifest', () => {
  it('marks an entry without a recorded checksum as not downloadable', () => {
    for (const entry of VOICE_MODEL_MANIFEST) {
      const verified = entry.files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256))
      expect(isManifestVerified(entry)).toBe(verified)
    }
  })
})

describe('VoiceModelManager', () => {
  it('refuses to download a model that has no recorded checksum', async () => {
    const entry = addToManifest({
      ...verifiedEntry(),
      id: 'unverified',
      files: verifiedEntry().files.map((f) => ({ ...f, sha256: '' })),
    })
    const fetchImpl = vi.fn()
    const manager = new VoiceModelManager({ rootDir: root, fetchImpl: fetchImpl as never })

    await expect(manager.install(entry.id)).rejects.toThrow(/checksum/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('downloads, verifies, and reports the model as installed', async () => {
    const entry = addToManifest(verifiedEntry())
    const fetchImpl = vi.fn(async () => new Response(CONTENT, { status: 200 }))
    const manager = new VoiceModelManager({ rootDir: root, fetchImpl: fetchImpl as never })

    await manager.install(entry.id)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(await manager.isInstalled(entry)).toBe(true)
    // The partial file is renamed, never left behind.
    await expect(stat(join(root, entry.id, 'encoder.onnx.part'))).rejects.toThrow()
  })

  it('deletes a file whose checksum does not match', async () => {
    const entry = addToManifest(verifiedEntry())
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('the wrong bytes'), { status: 200 }))
    const manager = new VoiceModelManager({ rootDir: root, fetchImpl: fetchImpl as never })

    await expect(manager.install(entry.id)).rejects.toThrow(/checksum mismatch/i)
    expect(await manager.isInstalled(entry)).toBe(false)
    await expect(stat(join(root, entry.id, 'encoder.onnx'))).rejects.toThrow()
  })

  it('gives the disk space back when a model is deleted', async () => {
    const entry = addToManifest(verifiedEntry())
    const manager = new VoiceModelManager({
      rootDir: root,
      fetchImpl: (async () => new Response(CONTENT, { status: 200 })) as never,
    })
    await manager.install(entry.id)
    await manager.remove(entry.id)
    expect(await manager.isInstalled(entry)).toBe(false)
    await expect(stat(join(root, entry.id))).rejects.toThrow()
  })

  it('removes every model at once', async () => {
    const entry = addToManifest(verifiedEntry())
    const manager = new VoiceModelManager({
      rootDir: root,
      fetchImpl: (async () => new Response(CONTENT, { status: 200 })) as never,
    })
    await manager.install(entry.id)
    await manager.removeAll()
    await expect(stat(root)).rejects.toThrow()
  })

  it('resolves a model directory installed by hand', async () => {
    const custom = join(root, 'hand-installed')
    await mkdir(custom, { recursive: true })
    await writeFile(join(custom, 'encoder-epoch-99.int8.onnx'), CONTENT)
    await writeFile(join(custom, 'decoder-epoch-99.onnx'), CONTENT)
    await writeFile(join(custom, 'joiner-epoch-99.int8.onnx'), CONTENT)
    await writeFile(join(custom, 'tokens.txt'), CONTENT)

    const manager = new VoiceModelManager({ rootDir: root })
    const resolved = await manager.resolve('nothing-installed', custom)
    expect(resolved).not.toBeNull()
    expect(resolved?.encoder).toContain('encoder-epoch-99.int8.onnx')
    expect(resolved?.tokens).toContain('tokens.txt')
  })

  it('reports nothing when the directory is incomplete', async () => {
    const custom = join(root, 'incomplete')
    await mkdir(custom, { recursive: true })
    await writeFile(join(custom, 'encoder.onnx'), CONTENT)

    const manager = new VoiceModelManager({ rootDir: root })
    expect(await manager.resolve('nothing-installed', custom)).toBeNull()
  })

  it('lists a model with its size, licence, and language', async () => {
    const entry = addToManifest(verifiedEntry())
    const manager = new VoiceModelManager({ rootDir: root })
    const listed = (await manager.list()).find((m) => m.id === entry.id)
    expect(listed).toMatchObject({
      label: 'Test model',
      license: 'Apache-2.0',
      languages: ['en'],
      installed: false,
      downloadable: true,
      sizeBytes: CONTENT.length * 4,
    })
  })
})

describe('sha256OfFile', () => {
  it('matches the digest of the bytes on disk', async () => {
    const path = join(root, 'sample.bin')
    await writeFile(path, CONTENT)
    expect(await sha256OfFile(path)).toBe(DIGEST)
  })
})
