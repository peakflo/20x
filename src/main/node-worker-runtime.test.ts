import { describe, expect, it } from 'vitest'
import { nodeWorkerRuntime } from './node-worker-runtime'

describe('nodeWorkerRuntime', () => {
  it('uses standalone Node on macOS and removes an inherited Electron mode', () => {
    const environment = { PATH: '/usr/local/bin', ELECTRON_RUN_AS_NODE: '1' }
    expect(nodeWorkerRuntime('darwin', '/Applications/20x.app/Contents/MacOS/20x', environment))
      .toEqual({ execPath: 'node', env: { PATH: '/usr/local/bin' } })
    expect(environment.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it.each(['linux', 'win32'] as const)('keeps the existing worker runtime on %s', (platform) => {
    expect(nodeWorkerRuntime(platform, '/electron', { PATH: '/bin' })).toEqual({
      execPath: '/electron', env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' },
    })
  })
})
