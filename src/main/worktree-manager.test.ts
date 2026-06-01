import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'

const { execFileMock, existsSyncMock, mkdirSyncMock } = vi.hoisted(() => {
  const execFileMock = vi.fn()
  const existsSyncMock = vi.fn()
  const mkdirSyncMock = vi.fn()
  const customPromisify = Symbol.for('nodejs.util.promisify.custom')

  execFileMock[customPromisify] = (...args: unknown[]) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const callback = (error: Error | null, stdout = '', stderr = '') => {
        if (error) {
          reject(error)
          return
        }

        resolve({ stdout, stderr })
      }

      execFileMock(...args, callback)
    })
  }

  return { execFileMock, existsSyncMock, mkdirSyncMock }
})

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  rmSync: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/20x-user-data')
  }
}))

import { WorktreeManager } from './worktree-manager'

describe('WorktreeManager', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    existsSyncMock.mockReset()
    mkdirSyncMock.mockReset()
    existsSyncMock.mockReturnValue(false)
    execFileMock.mockImplementation((file: string, args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      const callback = typeof optionsOrCallback === 'function'
        ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
        : maybeCallback as (error: Error | null, stdout?: string, stderr?: string) => void

      if (file === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
        callback(null, '', '')
        return
      }

      if (file === 'git' && args[0] === 'fetch') {
        callback(null, '', '')
        return
      }

      if (file === 'git' && args[0] === 'branch') {
        callback(null, '', '')
        return
      }

      if (file === 'git' && args[0] === 'rev-parse') {
        callback(null, 'origin/main', '')
        return
      }

      if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        callback(null, '', '')
        return
      }

      callback(new Error(`Unexpected command: ${file} ${args.join(' ')}`))
    })
  })

  it('uses an explicit https clone URL for GitHub repos', async () => {
    const manager = new WorktreeManager()
    const bareRepoPath = path.join('/tmp/20x-user-data', 'repos', 'peakflo', '20x.git')

    await manager.setupWorkspaceForTask(
      'task-1',
      [{ fullName: 'peakflo/20x', defaultBranch: 'main', cloneUrl: 'https://github.com/peakflo/20x.git' }],
      'peakflo',
      'github'
    )

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['repo', 'clone', 'https://github.com/peakflo/20x.git', bareRepoPath, '--', '--bare'],
      expect.objectContaining({ timeout: 300000 }),
      expect.any(Function)
    )
  })

  it('falls back to a derived https clone URL when repo metadata omits one', async () => {
    const manager = new WorktreeManager()
    const bareRepoPath = path.join('/tmp/20x-user-data', 'repos', 'peakflo', 'upload-functions.git')

    await manager.setupWorkspaceForTask(
      'task-2',
      [{ fullName: 'peakflo/upload-functions', defaultBranch: 'main' }],
      'peakflo',
      'github'
    )

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['repo', 'clone', 'https://github.com/peakflo/upload-functions.git', bareRepoPath, '--', '--bare'],
      expect.objectContaining({ timeout: 300000 }),
      expect.any(Function)
    )
  })
})
