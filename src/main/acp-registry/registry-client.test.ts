import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createRegistryClient,
  filterInstallableOnThisPlatform,
  resolveDistribution,
  searchAgents,
  __resetRunnerCacheForTests
} from './registry-client'
import type { AcpRegistryAgentEntry, AcpRegistryIndex } from './registry-types'

function fakeResponse(body: string, opts: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: async () => body,
    body: null
  } as unknown as Response
}

const validRegistryJson = JSON.stringify({
  version: '1.0.0',
  agents: [
    {
      id: 'sample-agent',
      name: 'Sample Agent',
      version: '1.0.0',
      description: 'A sample ACP agent for tests',
      distribution: {
        binary: {
          'darwin-aarch64': { archive: 'https://example.com/sample.tar.gz', cmd: './sample', sha256: 'a'.repeat(64) }
        },
        npx: { package: 'sample-agent@1.0.0' },
        uvx: { package: 'sample-agent==1.0.0' }
      }
    },
    {
      id: 'npx-only-agent',
      name: 'Npx Only Agent',
      version: '2.0.0',
      distribution: { npx: { package: 'npx-only-agent@2.0.0' } }
    }
  ]
})

describe('RegistryClient', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'acp-registry-test-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('fetches, validates, and writes an on-disk cache on success', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls++
      return fakeResponse(validRegistryJson)
    }
    const client = createRegistryClient({ cacheDir, fetchImpl })
    const result = await client.load()
    expect(result.source).toBe('network')
    expect(result.index.agents).toHaveLength(2)
    expect(calls).toBe(1)

    const cached = await readFile(join(cacheDir, 'registry-cache.json'), 'utf8')
    expect(JSON.parse(cached).agents).toHaveLength(2)
  })

  it('falls back to the on-disk cache when the network fetch fails', async () => {
    const goodFetch = async () => fakeResponse(validRegistryJson)
    const client1 = createRegistryClient({ cacheDir, fetchImpl: goodFetch })
    await client1.load()

    const failingFetch = async () => {
      throw new Error('network down')
    }
    const client2 = createRegistryClient({ cacheDir, fetchImpl: failingFetch })
    const result = await client2.load({ forceRefetch: true })
    expect(result.source).toBe('cache')
    expect(result.index.agents).toHaveLength(2)
  })

  it('throws when the network fails and there is no cache', async () => {
    const failingFetch = async () => {
      throw new Error('network down')
    }
    const client = createRegistryClient({ cacheDir, fetchImpl: failingFetch })
    await expect(client.load({ forceRefetch: true })).rejects.toThrow(/unavailable/i)
  })

  it('rejects an HTTP error response and falls back to cache', async () => {
    const goodFetch = async () => fakeResponse(validRegistryJson)
    const client1 = createRegistryClient({ cacheDir, fetchImpl: goodFetch })
    await client1.load()

    const errorFetch = async () => fakeResponse('', { ok: false, status: 500 })
    const client2 = createRegistryClient({ cacheDir, fetchImpl: errorFetch })
    const result = await client2.load({ forceRefetch: true })
    expect(result.source).toBe('cache')
  })

  it('enforces the 1 MiB response cap', async () => {
    const huge = 'x'.repeat(1024 * 1024 + 1)
    const fetchImpl = async () => fakeResponse(huge)
    const client = createRegistryClient({ cacheDir, fetchImpl })
    await expect(client.load({ forceRefetch: true })).rejects.toThrow(/unavailable/i)
  })

  it('loadCachedOnly never touches the network', async () => {
    let networkCalls = 0
    const fetchImpl = async () => {
      networkCalls++
      return fakeResponse(validRegistryJson)
    }
    const client = createRegistryClient({ cacheDir, fetchImpl })
    const empty = await client.loadCachedOnly()
    expect(empty).toBeNull()
    expect(networkCalls).toBe(0)

    await client.load()
    const cached = await client.loadCachedOnly()
    expect(cached?.index.agents).toHaveLength(2)
    expect(networkCalls).toBe(1)
  })
})

describe('searchAgents', () => {
  const index: AcpRegistryIndex = {
    version: '1.0.0',
    agents: [
      { id: 'devin', name: 'Devin', version: '1.0.0', description: 'autonomous engineer', distribution: { npx: { package: 'devin@1.0.0' } } },
      { id: 'mistral-vibe', name: 'Mistral Vibe', version: '1.0.0', description: 'coding agent by Mistral', distribution: { npx: { package: 'mistral-vibe@1.0.0' } } },
      { id: 'other', name: 'Other Agent', version: '1.0.0', description: 'mentions devin in passing', distribution: { npx: { package: 'other@1.0.0' } } }
    ]
  }

  it('returns everything for an empty query', () => {
    expect(searchAgents(index, '')).toHaveLength(3)
  })

  it('ranks name/id matches above description-only matches', () => {
    const results = searchAgents(index, 'devin')
    expect(results[0].id).toBe('devin')
    expect(results.map((r) => r.id)).toContain('other')
  })

  it('matches case-insensitively', () => {
    expect(searchAgents(index, 'MISTRAL')[0].id).toBe('mistral-vibe')
  })
})

describe('resolveDistribution', () => {
  const entry = (overrides: Partial<AcpRegistryAgentEntry['distribution']>): AcpRegistryAgentEntry => ({
    id: 'agent',
    name: 'Agent',
    version: '1.0.0',
    distribution: overrides
  })

  beforeEach(() => __resetRunnerCacheForTests())

  it('prefers binary over npx/uvx when all three are available', async () => {
    const e = entry({
      binary: { 'darwin-aarch64': { archive: 'https://example.com/a.tar.gz', cmd: './a' } },
      npx: { package: 'agent@1.0.0' },
      uvx: { package: 'agent==1.0.0' }
    })
    const result = await resolveDistribution(e, { platformTarget: 'darwin-aarch64', hasNpm: async () => true, hasUv: async () => true })
    expect(result.kind).toBe('binary')
  })

  it('falls back to npx when no binary target matches the platform', async () => {
    const e = entry({ npx: { package: 'agent@1.0.0' } })
    const result = await resolveDistribution(e, { platformTarget: 'linux-x86_64', hasNpm: async () => true })
    expect(result.kind).toBe('npx')
  })

  it('falls back to uvx when npx runner is unavailable and uvx is', async () => {
    const e = entry({ npx: { package: 'agent@1.0.0' }, uvx: { package: 'agent==1.0.0' } })
    const result = await resolveDistribution(e, { hasNpm: async () => false, hasUv: async () => true })
    expect(result.kind).toBe('uvx')
  })

  it('reports no-distribution-for-platform when nothing matches', async () => {
    const e = entry({ binary: { 'windows-x86_64': { archive: 'https://example.com/a.zip', cmd: 'a.exe' } } })
    const result = await resolveDistribution(e, { platformTarget: 'darwin-aarch64', hasNpm: async () => false, hasUv: async () => false })
    expect(result.kind).toBe('no-distribution-for-platform')
  })

  it('reports unsupported-platform when the current machine has no platform target', async () => {
    const e = entry({ npx: { package: 'agent@1.0.0' } })
    const result = await resolveDistribution(e, { platformTarget: null, hasNpm: async () => false })
    expect(result.kind).toBe('unsupported-platform')
  })

  it('returns runner-unavailable when a specific distribution is forced but its runner is missing', async () => {
    const e = entry({ uvx: { package: 'agent==1.0.0' } })
    const result = await resolveDistribution(e, { preferred: 'uvx', hasUv: async () => false })
    expect(result.kind).toBe('runner-unavailable')
    expect((result as { missingRunner?: string }).missingRunner).toBe('uv')
  })
})

describe('filterInstallableOnThisPlatform', () => {
  it('hides npx entries when npm is missing', async () => {
    const agents: AcpRegistryAgentEntry[] = [
      { id: 'npx-agent', name: 'Npx Agent', version: '1.0.0', distribution: { npx: { package: 'npx-agent@1.0.0' } } },
      {
        id: 'binary-agent',
        name: 'Binary Agent',
        version: '1.0.0',
        distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.com/a.tar.gz', cmd: './a' } } }
      }
    ]
    const installable = await filterInstallableOnThisPlatform(agents, {
      platformTarget: 'darwin-aarch64',
      hasNpm: async () => false,
      hasUv: async () => false
    })
    expect(installable.map((a) => a.id)).toEqual(['binary-agent'])
  })
})
