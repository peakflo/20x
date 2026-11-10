import { describe, expect, it, vi } from 'vitest'

vi.mock('child_process', () => ({
  execFile: vi.fn((_file, _args, _options, callback) => callback(null, '/Users/test/Library/pnpm/store/v3\n', ''))
}))

import { execFile } from 'child_process'
import { configureSharedPnpmStore, pnpmStoreRoot } from './pnpm-store'

describe('shared pnpm store', () => {
  it('uses the existing versioned store path as one shared base', async () => {
    const env: NodeJS.ProcessEnv = {}
    expect(await configureSharedPnpmStore('/tmp/20x', env)).toBe('/Users/test/Library/pnpm/store')
    expect(env.npm_config_store_dir).toBe('/Users/test/Library/pnpm/store')
    expect(execFile).toHaveBeenCalledWith('pnpm', ['store', 'path'], expect.objectContaining({ cwd: '/tmp/20x' }), expect.any(Function))
  })

  it('keeps a store path that the user set', async () => {
    const env: NodeJS.ProcessEnv = { npm_config_store_dir: '/custom/store' }
    vi.mocked(execFile).mockClear()
    expect(await configureSharedPnpmStore('/tmp/20x', env)).toBe('/custom/store')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('rejects paths that cannot be used as a shared store base', () => {
    expect(pnpmStoreRoot('warning\n/Users/test/Library/pnpm/store/v3\n')).toBe('/Users/test/Library/pnpm/store')
    expect(pnpmStoreRoot('relative/store/v3')).toBeNull()
    expect(pnpmStoreRoot('/Users/test/Library/pnpm/store')).toBeNull()
  })
})
