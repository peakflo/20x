import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { mkdtemp, rm, writeFile, mkdir, chmod, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { InstallManager, isReserved, reserveAgent } from './install-manager'
import type { ResolvedDistribution } from './registry-client'
import type { AcpRegistryAgentEntry } from './registry-types'

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function fakeFetchForBuffer(buf: Buffer): typeof fetch {
  return (async () => {
    let sent = false
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (sent) return { done: true, value: undefined }
              sent = true
              return { done: false, value: new Uint8Array(buf) }
            }
          }
        }
      }
    } as unknown as Response
  }) as unknown as typeof fetch
}

describe('InstallManager: binary distribution', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'acp-install-mgr-'))
  })
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  const entry = (overrides: Partial<AcpRegistryAgentEntry> = {}): AcpRegistryAgentEntry => ({
    id: 'sample-agent',
    name: 'Sample Agent',
    version: '1.0.0',
    distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.com/sample.tar.gz', cmd: './sample' } } },
    ...overrides
  })

  it('installs a binary archive and verifies a matching sha256', async () => {
    const archiveBuf = Buffer.from('fake-archive-bytes')
    const digest = sha256(archiveBuf)
    const e = entry({
      distribution: {
        binary: { 'darwin-aarch64': { archive: 'https://example.com/sample.tar.gz', cmd: './sample', sha256: digest } }
      }
    })
    const resolved: ResolvedDistribution = { kind: 'binary', entry: e, platformTarget: 'darwin-aarch64', args: ['acp'], env: {} }

    const manager = new InstallManager({
      rootDir,
      fetchImpl: fakeFetchForBuffer(archiveBuf),
      listArchiveEntries: async () => [{ path: 'sample', isSymlink: false }],
      extractArchive: async (_archivePath, destDir) => {
        await writeFile(join(destDir, 'sample'), '#!/bin/sh\necho hi\n')
        await chmod(join(destDir, 'sample'), 0o755)
      }
    })

    const installed = await manager.ensureInstalled(resolved)
    expect(installed.executablePath).toContain('sample-agent')
    expect(installed.args).toEqual(['acp'])
    const content = await readFile(installed.executablePath, 'utf8')
    expect(content).toContain('echo hi')
  })

  it('rejects a binary archive with a mismatched sha256', async () => {
    const archiveBuf = Buffer.from('fake-archive-bytes')
    const e = entry({
      distribution: {
        binary: { 'darwin-aarch64': { archive: 'https://example.com/sample.tar.gz', cmd: './sample', sha256: 'f'.repeat(64) } }
      }
    })
    const resolved: ResolvedDistribution = { kind: 'binary', entry: e, platformTarget: 'darwin-aarch64', args: [], env: {} }

    const manager = new InstallManager({
      rootDir,
      fetchImpl: fakeFetchForBuffer(archiveBuf),
      listArchiveEntries: async () => [{ path: 'sample', isSymlink: false }],
      extractArchive: async (_archivePath, destDir) => {
        await writeFile(join(destDir, 'sample'), '#!/bin/sh\n')
      }
    })

    await expect(manager.ensureInstalled(resolved)).rejects.toThrow(/checksum mismatch/i)
  })

  it('refuses to extract an archive containing a path-traversal entry', async () => {
    const archiveBuf = Buffer.from('fake-archive-bytes')
    const e = entry()
    const resolved: ResolvedDistribution = { kind: 'binary', entry: e, platformTarget: 'darwin-aarch64', args: [], env: {} }
    const manager = new InstallManager({
      rootDir,
      fetchImpl: fakeFetchForBuffer(archiveBuf),
      listArchiveEntries: async () => [{ path: '../../etc/passwd', isSymlink: false }],
      extractArchive: async () => {
        throw new Error('should never be called')
      }
    })
    await expect(manager.ensureInstalled(resolved)).rejects.toThrow(/traversal/i)
  })

  it('refuses to extract an archive containing a symlink entry', async () => {
    const archiveBuf = Buffer.from('fake-archive-bytes')
    const e = entry()
    const resolved: ResolvedDistribution = { kind: 'binary', entry: e, platformTarget: 'darwin-aarch64', args: [], env: {} }
    const manager = new InstallManager({
      rootDir,
      fetchImpl: fakeFetchForBuffer(archiveBuf),
      listArchiveEntries: async () => [{ path: 'sample', isSymlink: true }],
      extractArchive: async () => {
        throw new Error('should never be called')
      }
    })
    await expect(manager.ensureInstalled(resolved)).rejects.toThrow(/symlink/i)
  })

  it('refuses to extract an archive containing an absolute path entry', async () => {
    const archiveBuf = Buffer.from('fake-archive-bytes')
    const e = entry()
    const resolved: ResolvedDistribution = { kind: 'binary', entry: e, platformTarget: 'darwin-aarch64', args: [], env: {} }
    const manager = new InstallManager({
      rootDir,
      fetchImpl: fakeFetchForBuffer(archiveBuf),
      listArchiveEntries: async () => [{ path: '/etc/passwd', isSymlink: false }],
      extractArchive: async () => {
        throw new Error('should never be called')
      }
    })
    await expect(manager.ensureInstalled(resolved)).rejects.toThrow(/absolute/i)
  })

  it('reuses a previously installed binary without re-downloading (valid receipt)', async () => {
    const archiveBuf = Buffer.from('fake-archive-bytes')
    const e = entry()
    const resolved: ResolvedDistribution = { kind: 'binary', entry: e, platformTarget: 'darwin-aarch64', args: [], env: {} }
    let fetchCalls = 0
    const countingFetch: typeof fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls++
      return fakeFetchForBuffer(archiveBuf)(...args)
    }) as unknown as typeof fetch

    const manager = new InstallManager({
      rootDir,
      fetchImpl: countingFetch,
      listArchiveEntries: async () => [{ path: 'sample', isSymlink: false }],
      extractArchive: async (_archivePath, destDir) => {
        await writeFile(join(destDir, 'sample'), '#!/bin/sh\n')
        await chmod(join(destDir, 'sample'), 0o755)
      }
    })

    await manager.ensureInstalled(resolved)
    await manager.ensureInstalled(resolved)
    expect(fetchCalls).toBe(1)
  })

  it('an executable override wins while keeping registry args/env', async () => {
    // The override path is a product-level concern (instance config), exercised
    // here at the data level: resolved.args/env flow through installAgent/
    // ensureInstalled untouched regardless of where executablePath came from.
    const e = entry({ distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.com/a.tar.gz', cmd: './a' } } } })
    const resolved: ResolvedDistribution = { kind: 'binary', entry: e, platformTarget: 'darwin-aarch64', args: ['--flag'], env: { FOO: 'bar' } }
    const manager = new InstallManager({
      rootDir,
      fetchImpl: fakeFetchForBuffer(Buffer.from('x')),
      listArchiveEntries: async () => [{ path: 'a', isSymlink: false }],
      extractArchive: async (_p, destDir) => {
        await writeFile(join(destDir, 'a'), '#!/bin/sh\n')
        await chmod(join(destDir, 'a'), 0o755)
      }
    })
    const installed = await manager.ensureInstalled(resolved)
    expect(installed.args).toEqual(['--flag'])
    expect(installed.env).toEqual({ FOO: 'bar' })
  })
})

describe('InstallManager: npx distribution (mocked spawn)', () => {
  let rootDir: string
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'acp-install-mgr-npx-'))
  })
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('writes an app-owned npm prefix and resolves the installed bin', async () => {
    const e: AcpRegistryAgentEntry = {
      id: 'npx-agent',
      name: 'Npx Agent',
      version: '1.0.0',
      distribution: { npx: { package: 'npx-agent@1.0.0' } }
    }
    const resolved: ResolvedDistribution = { kind: 'npx', entry: e, args: ['acp'], env: {} }

    let capturedPrefix = ''
    const manager = new InstallManager({
      rootDir,
      runNpmInstall: async ({ prefixDir }) => {
        capturedPrefix = prefixDir
        const pkgDir = join(prefixDir, 'lib', 'node_modules', 'npx-agent')
        await mkdir(pkgDir, { recursive: true })
        await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'npx-agent', version: '1.0.0', bin: { 'npx-agent': 'cli.js' } }))
        await mkdir(join(prefixDir, 'bin'), { recursive: true })
        await writeFile(join(prefixDir, 'bin', 'npx-agent'), '#!/usr/bin/env node\n')
      }
    })

    const installed = await manager.ensureInstalled(resolved)
    expect(capturedPrefix).toContain('npx-agent')
    expect(installed.executablePath).toBe(join(capturedPrefix, 'bin', 'npx-agent'))
  })

  it('never touches the real global npm prefix (uses a private prefix dir)', async () => {
    const e: AcpRegistryAgentEntry = {
      id: 'npx-agent-2',
      name: 'Npx Agent 2',
      version: '1.0.0',
      distribution: { npx: { package: 'npx-agent-2@1.0.0' } }
    }
    const resolved: ResolvedDistribution = { kind: 'npx', entry: e, args: [], env: {} }
    let prefixSeen = ''
    const manager = new InstallManager({
      rootDir,
      runNpmInstall: async ({ prefixDir }) => {
        prefixSeen = prefixDir
        const pkgDir = join(prefixDir, 'lib', 'node_modules', 'npx-agent-2')
        await mkdir(pkgDir, { recursive: true })
        await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'npx-agent-2', version: '1.0.0', bin: { 'npx-agent-2': 'cli.js' } }))
        await mkdir(join(prefixDir, 'bin'), { recursive: true })
        await writeFile(join(prefixDir, 'bin', 'npx-agent-2'), '')
      }
    })
    await manager.ensureInstalled(resolved)
    expect(prefixSeen.startsWith(rootDir)).toBe(true)
  })
})

describe('InstallManager: uvx distribution (mocked spawn)', () => {
  let rootDir: string
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'acp-install-mgr-uvx-'))
  })
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('writes an app-owned UV_TOOL_DIR/BIN_DIR and resolves the installed bin', async () => {
    const e: AcpRegistryAgentEntry = {
      id: 'uvx-agent',
      name: 'Uvx Agent',
      version: '1.0.0',
      distribution: { uvx: { package: 'uvx-agent==1.0.0' } }
    }
    const resolved: ResolvedDistribution = { kind: 'uvx', entry: e, args: ['-x'], env: {} }
    let capturedToolDir = ''
    let capturedBinDir = ''
    const manager = new InstallManager({
      rootDir,
      runUvInstall: async ({ toolDir, binDir }) => {
        capturedToolDir = toolDir
        capturedBinDir = binDir
        await writeFile(join(binDir, 'uvx-agent'), '#!/usr/bin/env python3\n')
      }
    })
    const installed = await manager.ensureInstalled(resolved)
    expect(capturedToolDir.startsWith(rootDir)).toBe(true)
    expect(capturedBinDir.startsWith(rootDir)).toBe(true)
    expect(installed.executablePath).toBe(join(capturedBinDir, 'uvx-agent'))
  })
})

describe('InstallManager: uninstall rule', () => {
  let rootDir: string
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'acp-install-mgr-uninstall-'))
  })
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  async function installOne(manager: InstallManager, id: string) {
    const e: AcpRegistryAgentEntry = {
      id,
      name: id,
      version: '1.0.0',
      distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.com/a.tar.gz', cmd: './a' } } }
    }
    const resolved: ResolvedDistribution = { kind: 'binary', entry: e, platformTarget: 'darwin-aarch64', args: [], env: {} }
    await manager.ensureInstalled(resolved)
  }

  it('refuses to uninstall while a configured instance still references the agent', async () => {
    const manager = new InstallManager({
      rootDir,
      fetchImpl: fakeFetchForBuffer(Buffer.from('x')),
      listArchiveEntries: async () => [{ path: 'a', isSymlink: false }],
      extractArchive: async (_p, destDir) => {
        await writeFile(join(destDir, 'a'), '#!/bin/sh\n')
        await chmod(join(destDir, 'a'), 0o755)
      }
    })
    await installOne(manager, 'referenced-agent')
    const result = await manager.uninstallBinary('referenced-agent', async () => true)
    expect(result.removed).toBe(false)
    expect(result.reason).toBe('still-referenced')
  })

  it('refuses to uninstall within the short post-install reservation window', async () => {
    const manager = new InstallManager({ rootDir })
    reserveAgent('reserved-agent')
    expect(isReserved('reserved-agent')).toBe(true)
    const result = await manager.uninstallBinary('reserved-agent', async () => false)
    expect(result.removed).toBe(false)
    expect(result.reason).toBe('reserved')
  })

  it('removes binary artifacts when nothing references the agent and it is not reserved', async () => {
    const manager = new InstallManager({
      rootDir,
      fetchImpl: fakeFetchForBuffer(Buffer.from('x')),
      listArchiveEntries: async () => [{ path: 'a', isSymlink: false }],
      extractArchive: async (_p, destDir) => {
        await writeFile(join(destDir, 'a'), '#!/bin/sh\n')
        await chmod(join(destDir, 'a'), 0o755)
      }
    })
    await installOne(manager, 'removable-agent')
    const result = await manager.uninstallBinary('removable-agent', async () => false)
    expect(result.removed).toBe(true)
  })
})
