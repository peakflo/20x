import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  currentPlatformTarget,
  fallbackIconUrl,
  isSafeRelativeCommandPath,
  validateAgentEntry,
  validateRegistryIndex
} from './registry-types'

const sample = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'registry.sample.json'), 'utf8')
)

describe('validateRegistryIndex', () => {
  it('parses the real public ACP registry snapshot without dropping any entry', () => {
    const { index, droppedCount } = validateRegistryIndex(sample)
    expect(droppedCount).toBe(0)
    expect(index.agents.length).toBe(sample.agents.length)
    const ids = index.agents.map((a) => a.id)
    expect(ids).toContain('devin')
    expect(ids).toContain('mistral-vibe')
    expect(ids).toContain('cursor')
  })

  it('throws on a document with no agents array', () => {
    expect(() => validateRegistryIndex({ version: '1.0.0' })).toThrow()
    expect(() => validateRegistryIndex(null)).toThrow()
    expect(() => validateRegistryIndex('nope')).toThrow()
  })

  it('drops entries individually instead of failing the whole registry', () => {
    const bad = {
      version: '1.0.0',
      agents: [
        { id: 'ok-agent', name: 'OK', version: '1.0.0', distribution: { npx: { package: 'ok-agent@1.0.0' } } },
        { id: 'BAD ID', name: 'Bad', version: '1.0.0', distribution: { npx: { package: 'bad@1.0.0' } } },
        { id: 'no-dist', name: 'NoDist', version: '1.0.0', distribution: {} }
      ]
    }
    const { index, droppedCount } = validateRegistryIndex(bad)
    expect(droppedCount).toBe(2)
    expect(index.agents).toHaveLength(1)
    expect(index.agents[0].id).toBe('ok-agent')
  })
})

describe('validateAgentEntry', () => {
  it('rejects a binary cmd that tries to escape via traversal or an absolute path', () => {
    const base = {
      id: 'evil',
      name: 'Evil',
      version: '1.0.0',
      distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.com/a.tar.gz', cmd: '../../etc/passwd' } } }
    }
    expect(validateAgentEntry(base)).toBeNull()
    expect(
      validateAgentEntry({
        ...base,
        distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.com/a.tar.gz', cmd: '/bin/sh' } } }
      })
    ).toBeNull()
    expect(
      validateAgentEntry({
        ...base,
        distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.com/a.tar.gz', cmd: 'C:\\evil.exe' } } }
      })
    ).toBeNull()
  })

  it('rejects an https URL with embedded credentials', () => {
    const entry = {
      id: 'ok',
      name: 'OK',
      version: '1.0.0',
      distribution: {
        binary: {
          'darwin-aarch64': { archive: 'https://user:pass@evil.example.com/a.tar.gz', cmd: './ok' }
        }
      }
    }
    expect(validateAgentEntry(entry)).toBeNull()
  })

  it('rejects a non-HTTPS archive URL', () => {
    const entry = {
      id: 'ok',
      name: 'OK',
      version: '1.0.0',
      distribution: { binary: { 'darwin-aarch64': { archive: 'http://example.com/a.tar.gz', cmd: './ok' } } }
    }
    expect(validateAgentEntry(entry)).toBeNull()
  })

  it('rejects npx/uvx package specs that are not pinned to an exact version', () => {
    const npxFloating = {
      id: 'ok',
      name: 'OK',
      version: '1.0.0',
      distribution: { npx: { package: 'some-agent@^1.0.0' } }
    }
    expect(validateAgentEntry(npxFloating)).toBeNull()
    const npxLatest = {
      id: 'ok',
      name: 'OK',
      version: '1.0.0',
      distribution: { npx: { package: 'some-agent@latest' } }
    }
    expect(validateAgentEntry(npxLatest)).toBeNull()
    const uvxFloating = {
      id: 'ok',
      name: 'OK',
      version: '1.0.0',
      distribution: { uvx: { package: 'some-agent' } }
    }
    expect(validateAgentEntry(uvxFloating)).toBeNull()
  })

  it('accepts a pinned npx spec and a pinned uvx spec', () => {
    const npx = {
      id: 'ok1',
      name: 'OK',
      version: '1.0.0',
      distribution: { npx: { package: '@scope/some-agent@1.2.3' } }
    }
    expect(validateAgentEntry(npx)?.distribution.npx?.package).toBe('@scope/some-agent@1.2.3')
    const uvx = {
      id: 'ok2',
      name: 'OK',
      version: '1.0.0',
      distribution: { uvx: { package: 'some-agent==1.2.3' } }
    }
    expect(validateAgentEntry(uvx)?.distribution.uvx?.package).toBe('some-agent==1.2.3')
  })

  it('rejects an icon URL that does not point at the known registry CDN', () => {
    const entry = {
      id: 'ok',
      name: 'OK',
      version: '1.0.0',
      icon: 'https://evil.example.com/fake-icon.svg',
      distribution: { npx: { package: 'ok@1.0.0' } }
    }
    expect(validateAgentEntry(entry)?.icon).toBe(fallbackIconUrl('ok'))
  })

  it('rejects an invalid id shape', () => {
    for (const id of ['', 'UPPER', '-leading-dash', '_leading', 'has space', 'has/slash']) {
      expect(
        validateAgentEntry({ id, name: 'x', version: '1.0.0', distribution: { npx: { package: 'x@1.0.0' } } })
      ).toBeNull()
    }
  })

  it('caps authors/args/env array sizes', () => {
    const tooManyAuthors = {
      id: 'ok',
      name: 'OK',
      version: '1.0.0',
      authors: Array.from({ length: 100 }, (_, i) => `author-${i}`),
      distribution: { npx: { package: 'ok@1.0.0' } }
    }
    expect(validateAgentEntry(tooManyAuthors)).toBeNull()
  })
})

describe('isSafeRelativeCommandPath', () => {
  it('accepts a normal relative cmd', () => {
    expect(isSafeRelativeCommandPath('./agent')).toBe(true)
    expect(isSafeRelativeCommandPath('bin/agent')).toBe(true)
  })
  it('rejects traversal, absolute paths and drive letters', () => {
    expect(isSafeRelativeCommandPath('../agent')).toBe(false)
    expect(isSafeRelativeCommandPath('a/../../b')).toBe(false)
    expect(isSafeRelativeCommandPath('/usr/bin/agent')).toBe(false)
    expect(isSafeRelativeCommandPath('C:\\agent.exe')).toBe(false)
  })
})

describe('currentPlatformTarget', () => {
  it('maps supported platform/arch pairs', () => {
    expect(currentPlatformTarget('darwin', 'arm64')).toBe('darwin-aarch64')
    expect(currentPlatformTarget('darwin', 'x64')).toBe('darwin-x86_64')
    expect(currentPlatformTarget('linux', 'arm64')).toBe('linux-aarch64')
    expect(currentPlatformTarget('win32', 'x64')).toBe('windows-x86_64')
  })
  it('returns null for unsupported platform/arch pairs', () => {
    expect(currentPlatformTarget('freebsd', 'x64')).toBeNull()
    expect(currentPlatformTarget('darwin', 'ia32')).toBeNull()
  })
})
