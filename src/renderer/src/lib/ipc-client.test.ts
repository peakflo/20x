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

describe('browserRecordingApi', () => {
  it('handles an older preload without recording methods', async () => {
    vi.stubGlobal('window', { electronAPI: { browser: {} } })
    const { browserRecordingApi } = await import('./ipc-client')

    await expect(browserRecordingApi.status('panel-1')).resolves.toEqual({ recording: null })
    await expect(browserRecordingApi.start('panel-1')).resolves.toEqual({ error: 'Browser recording is unavailable.' })
    await expect(browserRecordingApi.stop('panel-1')).resolves.toEqual({ error: 'Browser recording is unavailable.' })
  })
})
