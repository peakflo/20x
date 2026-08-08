import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('worktreeApi.readFile', () => {
  it('reports that Electron must restart when an older preload is still active', async () => {
    vi.stubGlobal('window', { electronAPI: { worktree: {} } })
    const { worktreeApi } = await import('./ipc-client')

    await expect(worktreeApi.readFile('task-1', null, 'AGENTS.md'))
      .rejects.toThrow('Restart 20x to enable workspace file previews.')
  })
})
