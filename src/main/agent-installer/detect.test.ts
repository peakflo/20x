import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { hasEnvNodeShebang, isVersionAtLeast, MINIMUM_PI_VERSION, probeCommand } from './detect.js'

describe('Pi version support', () => {
  it('accepts the minimum and newer versions', () => {
    expect(isVersionAtLeast(MINIMUM_PI_VERSION, MINIMUM_PI_VERSION)).toBe(true)
    expect(isVersionAtLeast('0.84.3', MINIMUM_PI_VERSION)).toBe(true)
    expect(isVersionAtLeast('1.0.0', MINIMUM_PI_VERSION)).toBe(true)
  })

  it('rejects versions older than the supported RPC runtime', () => {
    expect(isVersionAtLeast('0.80.4', MINIMUM_PI_VERSION)).toBe(false)
    expect(isVersionAtLeast('0.79.9', MINIMUM_PI_VERSION)).toBe(false)
  })
})

describe('probeCommand', () => {
  let root: string
  const originalPath = process.env.PATH

  function writeExec(file: string, body: string): void {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
    chmodSync(file, 0o755)
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), '20x-detect-')))
  })

  afterEach(() => {
    process.env.PATH = originalPath
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it.skipIf(process.platform === 'win32')('reports a missing command as not installed without an error', async () => {
    process.env.PATH = join(root, 'empty')
    expect(await probeCommand('definitely-not-a-real-cli-20x', ['--version'])).toEqual({ installed: false, version: null })
  })

  it.skipIf(process.platform === 'win32')('reports found-but-failing commands with path and stderr snippet', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bin = join(root, 'bin')
    writeExec(join(bin, 'brokencli'), '#!/bin/sh\necho "dyld: Library not loaded" >&2\nexit 3\n')
    process.env.PATH = `${bin}:/usr/bin:/bin`
    const result = await probeCommand('brokencli', ['--version'])
    expect(result.installed).toBe(false)
    expect(result.path).toBe(join(bin, 'brokencli'))
    expect(result.error).toContain('dyld: Library not loaded')
  })

  it.skipIf(process.platform === 'win32')('retries an `env node` script with the node of its own install prefix', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Broken node first on PATH (e.g. a Homebrew node with a missing dylib).
    const brokenBin = join(root, 'homebrew', 'bin')
    writeExec(join(brokenBin, 'node'), '#!/bin/sh\necho "dyld: Library not loaded: libicui18n" >&2\nexit 134\n')
    // nvm-style prefix with a working node and an npm-installed script.
    const prefix = join(root, 'nvm', 'versions', 'node', 'v22.14.0')
    writeExec(join(prefix, 'bin', 'node'), '#!/bin/sh\n# fake node: $1 is the script\necho "codex-cli 0.50.0"\n')
    const script = join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    writeExec(script, '#!/usr/bin/env node\nconsole.log("x")\n')
    const localBin = join(root, '.local', 'bin')
    mkdirSync(localBin, { recursive: true })
    symlinkSync(script, join(localBin, 'codex'))
    process.env.PATH = `${brokenBin}:${localBin}:/usr/bin:/bin`

    const result = await probeCommand('codex', ['--version'])
    expect(result).toMatchObject({ installed: true, version: '0.50.0', via: join(prefix, 'bin', 'node') })
    // The working node is moved to the front of PATH so launches use it too.
    expect(process.env.PATH?.split(':')[0]).toBe(join(prefix, 'bin'))
  })

  it('detects `#!/usr/bin/env node` shebangs only', () => {
    const a = join(root, 'a.js')
    const b = join(root, 'b.sh')
    writeFileSync(a, '#!/usr/bin/env node\n')
    writeFileSync(b, '#!/bin/sh\n')
    expect(hasEnvNodeShebang(a)).toBe(true)
    expect(hasEnvNodeShebang(b)).toBe(false)
  })
})
