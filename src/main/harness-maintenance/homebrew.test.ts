import { describe, expect, it, vi } from 'vitest'
import { fetchBrewLatestVersion, type BrewExecLike } from './homebrew'

describe('fetchBrewLatestVersion', () => {
  it('reads the stable version for a formula', async () => {
    const brewExec: BrewExecLike = vi.fn(async () => ({
      stdout: JSON.stringify({ formulae: [{ versions: { stable: '1.2.3' } }], casks: [] })
    }))
    const version = await fetchBrewLatestVersion('opencode', 'formula', brewExec)
    expect(version).toBe('1.2.3')
    expect(brewExec).toHaveBeenCalledWith('brew', ['info', '--json=v2', 'opencode'], { timeout: 10000 })
  })

  it('reads the version for a cask and strips the build-number suffix', async () => {
    const brewExec: BrewExecLike = vi.fn(async () => ({
      stdout: JSON.stringify({ formulae: [], casks: [{ version: '1.2.3,456' }] })
    }))
    const version = await fetchBrewLatestVersion('cursor', 'cask', brewExec)
    expect(version).toBe('1.2.3')
  })

  it('returns null when brew is not on PATH (ENOENT)', async () => {
    const brewExec: BrewExecLike = vi.fn(async () => { throw new Error('ENOENT') })
    const version = await fetchBrewLatestVersion('opencode', 'formula', brewExec)
    expect(version).toBeNull()
  })

  it('returns null when brew times out', async () => {
    const brewExec: BrewExecLike = vi.fn(async () => { throw new Error('timed out') })
    const version = await fetchBrewLatestVersion('opencode', 'formula', brewExec)
    expect(version).toBeNull()
  })

  it('returns null when the expected formula/cask entry is missing', async () => {
    const brewExec: BrewExecLike = vi.fn(async () => ({ stdout: JSON.stringify({ formulae: [], casks: [] }) }))
    expect(await fetchBrewLatestVersion('opencode', 'formula', brewExec)).toBeNull()
  })

  it('returns null on malformed JSON output', async () => {
    const brewExec: BrewExecLike = vi.fn(async () => ({ stdout: 'not json' }))
    expect(await fetchBrewLatestVersion('opencode', 'formula', brewExec)).toBeNull()
  })
})
