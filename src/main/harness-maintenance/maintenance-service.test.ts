import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BrewExecLike } from './homebrew'

const { detectInstalledAgentsMock, resolveBinaryPathMock } = vi.hoisted(() => ({
  detectInstalledAgentsMock: vi.fn(),
  resolveBinaryPathMock: vi.fn()
}))

vi.mock('../agent-installer/detect.js', () => ({
  detectInstalledAgents: detectInstalledAgentsMock,
  getPiCommandCandidates: vi.fn(async () => [])
}))

vi.mock('./installer-detect', async () => {
  const actual = await vi.importActual<typeof import('./installer-detect')>('./installer-detect')
  return { ...actual, resolveBinaryPath: resolveBinaryPathMock }
})

import {
  computeHarnessStatus,
  resetLocksForTests,
  resetNpmCacheForTests,
  runHarnessUpdate,
  runUpdateAll,
  type SpawnLike
} from './maintenance-service'
import type { FetchLike } from './npm-registry'

function makeDb() {
  const store = new Map<string, string>()
  return { getSetting: (k: string) => store.get(k), setSetting: (k: string, v: string) => store.set(k, v), store }
}

function fakeFetch(version: string | null): FetchLike {
  return vi.fn(async () => ({ ok: version != null, json: async () => ({ version }) }))
}

/** No real `brew` is on PATH-lookups in these tests — this keeps any accidental homebrew-path match fast and offline. */
const noBrew: BrewExecLike = vi.fn(async () => { throw new Error('brew not available in tests') })

/** A real, writable directory to use as an npm-global prefix (so the "writable?" check passes in CI/sandboxes). */
function writableNpmPackagePath(pkg: string, binName: string): { path: string; cleanup: () => void } {
  const prefix = mkdtempSync(join(tmpdir(), 'harness-maintenance-test-'))
  return {
    path: join(prefix, 'lib', 'node_modules', pkg, 'bin', binName),
    cleanup: () => rmSync(prefix, { recursive: true, force: true })
  }
}

const NO_OP_DETECTED = {
  claudeCode: { installed: false, version: null },
  codex: { installed: false, version: null },
  opencode: { installed: false, version: null },
  cursor: { installed: false, version: null },
  pi: { installed: false, version: null }
}

beforeEach(() => {
  resetNpmCacheForTests()
  resetLocksForTests()
  detectInstalledAgentsMock.mockReset()
  resolveBinaryPathMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('computeHarnessStatus', () => {
  it('reports not_installed without any network calls', async () => {
    const fetchImpl = fakeFetch('9.9.9')
    const status = await computeHarnessStatus('codex', { installed: false, version: null }, {
      checksEnabled: true,
      cache: new (await import('./npm-registry')).NpmLatestVersionCache(),
      fetchImpl
    })
    expect(status.status).toBe('not_installed')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('skips network calls entirely when checks are disabled', async () => {
    resolveBinaryPathMock.mockResolvedValue('/usr/local/lib/node_modules/@openai/codex/bin/codex.js')
    const fetchImpl = fakeFetch('9.9.9')
    // Above the bundled "recommended" floor so below_recommended doesn't mask the unknown/offline case under test.
    const status = await computeHarnessStatus('codex', { installed: true, version: '0.25.0' }, {
      checksEnabled: false,
      cache: new (await import('./npm-registry')).NpmLatestVersionCache(),
      fetchImpl
    })
    expect(status.latestVersion).toBeNull()
    expect(status.status).toBe('unknown')
    expect(fetchImpl).not.toHaveBeenCalled()
    // canUpdate/updateCommand are still derived locally, independent of the setting.
    expect(status.canUpdate).toBe(true)
  })

  it('reports behind_latest when checks are enabled and a newer npm version exists', async () => {
    resolveBinaryPathMock.mockResolvedValue('/usr/local/lib/node_modules/@openai/codex/bin/codex.js')
    const fetchImpl = fakeFetch('9.9.9')
    const status = await computeHarnessStatus('codex', { installed: true, version: '0.25.0' }, {
      checksEnabled: true,
      cache: new (await import('./npm-registry')).NpmLatestVersionCache(),
      fetchImpl,
      brewExec: noBrew
    })
    expect(status.latestVersion).toBe('9.9.9')
    expect(status.status).toBe('behind_latest')
    expect(status.installer).toBe('npm-global')
  })

  it('applies the OpenCode major-version guard: a 1.x install only checks the 1.x package', async () => {
    resolveBinaryPathMock.mockResolvedValue('/usr/local/lib/node_modules/opencode-ai/bin/opencode')
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      expect(url).toContain('opencode-ai')
      expect(url).not.toContain('%40opencode%2Fcli') // never checks the 2.x package for a 1.x install
      return { ok: true, json: async () => ({ version: '1.20.0' }) }
    })
    await computeHarnessStatus('opencode', { installed: true, version: '1.18.33' }, {
      checksEnabled: true,
      cache: new (await import('./npm-registry')).NpmLatestVersionCache(),
      fetchImpl
    })
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('treats Cursor as bundled/manual-only (no network, no update)', async () => {
    resolveBinaryPathMock.mockResolvedValue('/usr/local/bin/cursor-agent')
    const fetchImpl = fakeFetch('9.9.9')
    const status = await computeHarnessStatus('cursor', { installed: true, version: '1.0.0' }, {
      checksEnabled: true,
      cache: new (await import('./npm-registry')).NpmLatestVersionCache(),
      fetchImpl
    })
    expect(status.installer).toBe('bundled')
    expect(status.canUpdate).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports unsupported below the bundled Pi minimum, even with checks disabled', async () => {
    resolveBinaryPathMock.mockResolvedValue('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/bin/pi')
    const status = await computeHarnessStatus('pi', { installed: true, version: '0.70.0' }, {
      checksEnabled: false,
      cache: new (await import('./npm-registry')).NpmLatestVersionCache()
    })
    expect(status.status).toBe('unsupported')
  })

  it("updates a package-manager-owned Pi install through that package manager, not pi update --self", async () => {
    // pi update --self is unreliable in practice (a real crash was reproduced on this
    // exact install shape — see maintenance-service.ts's resolveUpdateAction comment),
    // so npm/pnpm/yarn/bun-owned installs go through the package manager instead,
    // the same way 20x's own installer installs Pi (--ignore-scripts included).
    resolveBinaryPathMock.mockResolvedValue('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/bin/pi')
    const status = await computeHarnessStatus('pi', { installed: true, version: '0.84.0' }, {
      checksEnabled: false,
      cache: new (await import('./npm-registry')).NpmLatestVersionCache()
    })
    expect(status.installer).toBe('npm-global')
    expect(status.updateCommand).toBe('npm install -g --ignore-scripts --prefix /usr/local @earendil-works/pi-coding-agent@latest')
    expect(status.canUpdate).toBe(true)
  })

  it('inserts --ignore-scripts for a pnpm-owned Pi install', async () => {
    resolveBinaryPathMock.mockResolvedValue('/Users/dev/Library/pnpm/global/5/node_modules/.bin/pi')
    const status = await computeHarnessStatus('pi', { installed: true, version: '0.84.0' }, {
      checksEnabled: false,
      cache: new (await import('./npm-registry')).NpmLatestVersionCache()
    })
    expect(status.installer).toBe('pnpm-global')
    expect(status.updateCommand).toBe('pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent@latest')
  })

  it('inserts --ignore-scripts after "add" for a yarn-owned Pi install', async () => {
    resolveBinaryPathMock.mockResolvedValue('/Users/dev/.config/yarn/global/node_modules/.bin/pi')
    const status = await computeHarnessStatus('pi', { installed: true, version: '0.84.0' }, {
      checksEnabled: false,
      cache: new (await import('./npm-registry')).NpmLatestVersionCache()
    })
    expect(status.installer).toBe('yarn-global')
    expect(status.updateCommand).toBe('yarn global add --ignore-scripts @earendil-works/pi-coding-agent@latest')
  })

  it('does not add --ignore-scripts to a Homebrew-owned Pi update (the flag is npm/pnpm/yarn/bun-specific)', async () => {
    resolveBinaryPathMock.mockResolvedValue('/opt/homebrew/Cellar/pi/0.84.0/bin/pi')
    const status = await computeHarnessStatus('pi', { installed: true, version: '0.84.0' }, {
      checksEnabled: false,
      cache: new (await import('./npm-registry')).NpmLatestVersionCache(),
      brewExec: vi.fn(async () => { throw new Error('not called in this test') })
    })
    expect(status.installer).toBe('homebrew-formula')
    expect(status.updateCommand).toBe('brew upgrade pi')
  })

  it('leaves a version-manager-pinned Pi install manual-only, same as any other harness', async () => {
    // detectInstaller has no native-path pattern for Pi, so `pi update --self` is
    // currently unreachable in practice — 20x's own installer always installs Pi
    // through npm. mise/asdf/volta/nvm-pinned installs correctly stay manual-only.
    resolveBinaryPathMock.mockResolvedValue('/Users/dev/.asdf/installs/pi/0.84.0/bin/pi')
    const status = await computeHarnessStatus('pi', { installed: true, version: '0.84.0' }, {
      checksEnabled: false,
      cache: new (await import('./npm-registry')).NpmLatestVersionCache()
    })
    expect(status.installer).toBe('manual')
    expect(status.canUpdate).toBe(false)
  })
})

describe('runHarnessUpdate', () => {
  function spawnSucceeds(): SpawnLike {
    return vi.fn(() => {
      const handlers: Record<string, (...args: unknown[]) => void> = {}
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, cb: (...args: unknown[]) => void) => {
          handlers[event] = cb
          if (event === 'close') setTimeout(() => cb(0), 0)
        },
        kill: () => {}
      }
    }) as unknown as SpawnLike
  }

  function spawnFails(code: number): SpawnLike {
    return vi.fn(() => ({
      stdout: { on: () => {} },
      stderr: { on: (_: string, cb: (chunk: Buffer) => void) => cb(Buffer.from('boom')) },
      on: (event: string, cb: (...args: unknown[]) => void) => { if (event === 'close') setTimeout(() => cb(code), 0) },
      kill: () => {}
    })) as unknown as SpawnLike
  }

  it('fails fast with a manual message when the harness has no update action', async () => {
    const db = makeDb()
    detectInstalledAgentsMock.mockResolvedValue({ ...NO_OP_DETECTED, codex: { installed: true, version: '0.1.0' } })
    resolveBinaryPathMock.mockResolvedValue('/Users/dev/.asdf/installs/codex/0.1.0/bin/codex')
    const result = await runHarnessUpdate(db, 'codex', () => {}, { fetchImpl: fakeFetch(null), brewExec: noBrew })
    expect(result.run.status).toBe('failed')
    expect(result.run.message).toMatch(/no one-click update/i)
  })

  it('aborts with "Installation changed" when the resolved path changes between checks', async () => {
    const db = makeDb()
    detectInstalledAgentsMock.mockResolvedValue({ ...NO_OP_DETECTED, codex: { installed: true, version: '0.1.0' } })
    const npmPath = writableNpmPackagePath('@openai/codex', 'codex.js')
    try {
      resolveBinaryPathMock
        .mockResolvedValueOnce(npmPath.path)
        .mockResolvedValueOnce('/opt/homebrew/Cellar/codex/0.1.0/bin/codex')
      const result = await runHarnessUpdate(db, 'codex', () => {}, { spawnImpl: spawnSucceeds(), fetchImpl: fakeFetch(null), brewExec: noBrew })
      expect(result.run.status).toBe('failed')
      expect(result.run.message).toMatch(/installation changed/i)
    } finally {
      npmPath.cleanup()
    }
  })

  it('runs the update, re-detects, and reports succeeded on a version bump', async () => {
    const db = makeDb()
    detectInstalledAgentsMock
      .mockResolvedValueOnce({ ...NO_OP_DETECTED, codex: { installed: true, version: '0.1.0' } })
      .mockResolvedValueOnce({ ...NO_OP_DETECTED, codex: { installed: true, version: '0.1.0' } })
      .mockResolvedValueOnce({ ...NO_OP_DETECTED, codex: { installed: true, version: '0.2.0' } })
    const npmPath = writableNpmPackagePath('@openai/codex', 'codex.js')
    try {
      resolveBinaryPathMock.mockResolvedValue(npmPath.path)
      const progress: string[] = []
      const result = await runHarnessUpdate(db, 'codex', (c) => progress.push(c), { spawnImpl: spawnSucceeds(), fetchImpl: fakeFetch(null), brewExec: noBrew })
      expect(result.run.status).toBe('succeeded')
      expect(result.newStatus.version).toBe('0.2.0')
      expect(progress.some((p) => p.includes('npm install'))).toBe(true)
    } finally {
      npmPath.cleanup()
    }
  })

  it('reports unchanged when the version did not move after a successful run', async () => {
    const db = makeDb()
    detectInstalledAgentsMock.mockResolvedValue({ ...NO_OP_DETECTED, codex: { installed: true, version: '0.1.0' } })
    const npmPath = writableNpmPackagePath('@openai/codex', 'codex.js')
    try {
      resolveBinaryPathMock.mockResolvedValue(npmPath.path)
      const result = await runHarnessUpdate(db, 'codex', () => {}, { spawnImpl: spawnSucceeds(), fetchImpl: fakeFetch(null), brewExec: noBrew })
      expect(result.run.status).toBe('unchanged')
    } finally {
      npmPath.cleanup()
    }
  })

  it('reports failed with captured output when the update command exits non-zero', async () => {
    const db = makeDb()
    detectInstalledAgentsMock.mockResolvedValue({ ...NO_OP_DETECTED, codex: { installed: true, version: '0.1.0' } })
    const npmPath = writableNpmPackagePath('@openai/codex', 'codex.js')
    try {
      resolveBinaryPathMock.mockResolvedValue(npmPath.path)
      const result = await runHarnessUpdate(db, 'codex', () => {}, { spawnImpl: spawnFails(1), fetchImpl: fakeFetch(null), brewExec: noBrew })
      expect(result.run.status).toBe('failed')
      expect(result.run.output).toContain('boom')
    } finally {
      npmPath.cleanup()
    }
  })

  it('fails with a manual-update message when the npm global prefix is not writable', async () => {
    const db = makeDb()
    detectInstalledAgentsMock.mockResolvedValue({ ...NO_OP_DETECTED, codex: { installed: true, version: '0.1.0' } })
    // A path under a prefix that doesn't exist on disk — accessSync throws, so it's treated as non-writable.
    resolveBinaryPathMock.mockResolvedValue('/this/path/does/not/exist/lib/node_modules/@openai/codex/bin/codex.js')
    const spawnImpl = spawnSucceeds()
    const result = await runHarnessUpdate(db, 'codex', () => {}, { spawnImpl, fetchImpl: fakeFetch(null), brewExec: noBrew })
    expect(result.run.status).toBe('failed')
    expect(result.run.message).toMatch(/isn't writable/i)
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('serializes two updates that share an installer lock', async () => {
    const db = makeDb()
    detectInstalledAgentsMock.mockResolvedValue({
      ...NO_OP_DETECTED,
      codex: { installed: true, version: '0.1.0' },
      opencode: { installed: true, version: '1.0.0' }
    })
    resolveBinaryPathMock.mockImplementation(async (cmd: string) =>
      cmd === 'codex'
        ? '/opt/homebrew/Cellar/codex/0.1.0/bin/codex'
        : '/opt/homebrew/Cellar/opencode/1.0.0/bin/opencode'
    )
    const order: string[] = []
    const slowSpawn: SpawnLike = vi.fn(() => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') setTimeout(() => cb(0), 15)
      },
      kill: () => {}
    })) as unknown as SpawnLike

    const first = runHarnessUpdate(db, 'codex', () => order.push('codex-progress'), { spawnImpl: slowSpawn, fetchImpl: fakeFetch(null), brewExec: noBrew }).then(() => order.push('codex-done'))
    const second = runHarnessUpdate(db, 'opencode', () => order.push('opencode-progress'), { spawnImpl: slowSpawn, fetchImpl: fakeFetch(null), brewExec: noBrew }).then(() => order.push('opencode-done'))
    await Promise.all([first, second])
    // Both share the "homebrew" lock, so one fully finishes before the other starts.
    const codexDoneIndex = order.indexOf('codex-done')
    const opencodeDoneIndex = order.indexOf('opencode-done')
    const codexProgressIndex = order.indexOf('codex-progress')
    const opencodeProgressIndex = order.indexOf('opencode-progress')
    expect(Math.min(codexDoneIndex, opencodeDoneIndex)).toBeLessThan(Math.max(codexProgressIndex, opencodeProgressIndex))
  })
})

describe('runUpdateAll', () => {
  it('skips manual-only harnesses and updates the rest', async () => {
    const db = makeDb()
    detectInstalledAgentsMock.mockResolvedValue({
      ...NO_OP_DETECTED,
      codex: { installed: true, version: '0.1.0' },
      opencode: { installed: true, version: '1.0.0' }
    })
    resolveBinaryPathMock.mockImplementation(async (cmd: string) =>
      cmd === 'codex'
        ? '/usr/local/lib/node_modules/@openai/codex/bin/codex.js'
        : cmd === 'opencode'
          ? '/Users/dev/.asdf/installs/opencode/1.0.0/bin/opencode' // manual-only
          : null
    )
    const spawnImpl: SpawnLike = vi.fn(() => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, cb: (...args: unknown[]) => void) => { if (event === 'close') setTimeout(() => cb(0), 0) },
      kill: () => {}
    })) as unknown as SpawnLike

    const result = await runUpdateAll(db, () => {}, { spawnImpl, fetchImpl: fakeFetch(null), brewExec: noBrew })
    expect(result.skipped).toContain('opencode')
    expect(result.skipped).toContain('cursor') // not installed at all
    expect(result.results.map((r) => r.harness)).toContain('codex')
  })
})
