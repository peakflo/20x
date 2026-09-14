import afterPack from './after-pack'
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'

async function exists(targetPath: string) {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

const tempDirs: string[] = []

async function makeApp(tempDir: string) {
  const appPath = join(tempDir, '20x.app')
  const framework = join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework')
  await mkdir(framework, { recursive: true })
  // A V1 fuse wire, including a future fuse that must stay unchanged.
  await writeFile(join(framework, 'Electron Framework'), Buffer.concat([
    Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
    Buffer.from([1, 9]),
    Buffer.from('101100011'),
  ]))
  return appPath
}

function context(appOutDir: string) {
  return { appOutDir, electronPlatformName: 'darwin', arch: 1,
    packager: { appInfo: { productFilename: '20x' } } }
}

describe('after-pack', () => {
  it('disables only RunAsNode even when there are no unpacked cleanup roots', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'after-pack-fuses-'))
    tempDirs.push(tempDir)
    const appPath = await makeApp(tempDir)
    const before = await getCurrentFuseWire(appPath)
    await afterPack(context(tempDir))
    expect(await getCurrentFuseWire(appPath)).toEqual({
      ...before, [FuseV1Options.RunAsNode]: 0x30,
    })
  })

  it('fails packaging when the macOS framework cannot be read', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'after-pack-missing-'))
    tempDirs.push(tempDir)
    await expect(afterPack(context(tempDir))).rejects.toThrow()
  })

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('cleans non-target claude-agent-sdk binaries from mac app bundle resources', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'after-pack-'))
    tempDirs.push(tempDir)

    await makeApp(tempDir)

    const unpackedRoot = join(
      tempDir,
      '20x.app',
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk'
    )

    await mkdir(join(unpackedRoot, 'vendor', 'ripgrep', 'x64-darwin'), { recursive: true })
    await mkdir(join(unpackedRoot, 'vendor', 'ripgrep', 'x64-linux'), { recursive: true })
    await mkdir(join(unpackedRoot, 'vendor', 'audio-capture', 'x64-darwin'), { recursive: true })
    await mkdir(join(unpackedRoot, 'vendor', 'audio-capture', 'x64-win32'), { recursive: true })
    await writeFile(join(unpackedRoot, 'cli.js'), 'console.log("remove me")')
    await writeFile(join(unpackedRoot, 'resvg.wasm'), 'remove me')

    await afterPack({
      appOutDir: tempDir,
      electronPlatformName: 'darwin',
      arch: 1,
      packager: {
        appInfo: {
          productFilename: '20x'
        }
      }
    })

    expect(await exists(join(unpackedRoot, 'vendor', 'ripgrep', 'x64-darwin'))).toBe(true)
    expect(await exists(join(unpackedRoot, 'vendor', 'audio-capture', 'x64-darwin'))).toBe(true)
    expect(await exists(join(unpackedRoot, 'vendor', 'ripgrep', 'x64-linux'))).toBe(false)
    expect(await exists(join(unpackedRoot, 'vendor', 'audio-capture', 'x64-win32'))).toBe(false)
    expect(await exists(join(unpackedRoot, 'cli.js'))).toBe(false)
    expect(await exists(join(unpackedRoot, 'resvg.wasm'))).toBe(false)
  })
})
