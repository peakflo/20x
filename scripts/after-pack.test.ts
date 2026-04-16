import afterPack from './after-pack'
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

describe('after-pack', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('cleans non-target claude-agent-sdk binaries from mac app bundle resources', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'after-pack-'))
    tempDirs.push(tempDir)

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
