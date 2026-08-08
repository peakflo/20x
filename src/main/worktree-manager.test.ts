import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'

const { execFileMock, existsSyncMock, mkdirSyncMock, readFileSyncMock, realpathSyncMock, readdirMock, statSyncMock } = vi.hoisted(() => {
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

  return {
    execFileMock,
    existsSyncMock,
    mkdirSyncMock,
    readFileSyncMock: vi.fn(),
    realpathSyncMock: vi.fn(),
    readdirMock: vi.fn(),
    statSyncMock: vi.fn()
  }
})

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  readFileSync: readFileSyncMock,
  realpathSync: realpathSyncMock,
  rmSync: vi.fn(),
  statSync: statSyncMock
}))

vi.mock('fs/promises', () => ({
  readdir: readdirMock
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
    readFileSyncMock.mockReset()
    realpathSyncMock.mockReset()
    readdirMock.mockReset().mockRejectedValue(new Error('Workspace unavailable'))
    statSyncMock.mockReset()
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

  it('returns tracked and untracked files for the complete worktree inventory', async () => {
    existsSyncMock.mockReturnValue(true)
    execFileMock.mockImplementation((file: string, args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      const callback = typeof optionsOrCallback === 'function'
        ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
        : maybeCallback as (error: Error | null, stdout?: string, stderr?: string) => void
      const command = `${file} ${args.join(' ')}`

      if (command.includes('ls-files --cached --others --exclude-standard -z')) {
        callback(null, 'src/changed.ts\0README.md\0src/untracked.ts\0', '')
      } else if (command.includes('symbolic-ref --short refs/remotes/origin/HEAD')) {
        callback(null, 'origin/main\n', '')
      } else if (command.includes('merge-base HEAD origin/main')) {
        callback(null, 'base-sha\n', '')
      } else if (command.includes('diff --no-color base-sha')) {
        callback(null, '', '')
      } else if (command.includes('ls-files --others --exclude-standard -z')) {
        callback(null, '', '')
      } else if (command.includes('rev-parse --abbrev-ref HEAD')) {
        callback(null, 'feature/all-files\n', '')
      } else if (command.includes('rev-parse --verify --quiet origin/feature/all-files')) {
        callback(null, 'remote-sha\n', '')
      } else if (command.includes('remote get-url origin')) {
        callback(null, 'https://example.com/repo.git\n', '')
      } else {
        callback(new Error(`Unexpected command: ${command}`))
      }
    })

    const manager = new WorktreeManager()
    const result = await manager.getTaskChanges('task-3', [{ fullName: 'peakflo/20x' }])

    expect(result.find((entry) => entry.repo === 'peakflo/20x')?.allFiles).toEqual(['README.md', 'src/changed.ts', 'src/untracked.ts'])
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      expect.objectContaining({ maxBuffer: 64 * 1024 * 1024 }),
      expect.any(Function)
    )
  })

  it('returns files outside linked repositories as a task workspace tree', async () => {
    const workspacePath = path.join('/tmp/20x-user-data', 'workspaces', 'task-4')
    existsSyncMock.mockImplementation((candidate: string) => candidate === workspacePath)

    const directory = (name: string) => ({ name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false })
    const file = (name: string) => ({ name, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false })
    readdirMock.mockImplementation(async (candidate: string) => {
      if (candidate === workspacePath) return [directory('.agents'), directory('.opencode'), file('AGENTS.md'), directory('attachments'), directory('20x')]
      if (candidate === path.join(workspacePath, '.agents')) return [directory('skills')]
      if (candidate === path.join(workspacePath, '.agents', 'skills')) return [directory('ui')]
      if (candidate === path.join(workspacePath, '.agents', 'skills', 'ui')) return [file('SKILL.md')]
      if (candidate === path.join(workspacePath, '.opencode')) return [directory('node_modules'), directory('plugins'), file('package.json')]
      if (candidate === path.join(workspacePath, 'attachments')) return [file('spec.pdf')]
      return []
    })

    const result = await new WorktreeManager().getTaskChanges('task-4', [{ fullName: 'peakflo/20x' }])
    const workspace = result.find((entry) => entry.workspace)

    expect(workspace?.allFiles).toEqual([
      '.agents/skills/ui/SKILL.md',
      'AGENTS.md',
      'attachments/spec.pdf'
    ])
    expect(workspace?.allFiles).not.toContain('20x')
    expect(workspace?.allFiles?.some((filePath) => filePath.startsWith('.opencode/')) ?? false).toBe(false)
  })

  it('returns the workspace and repository inventory without computing a diff', async () => {
    const workspacePath = path.join('/tmp/20x-user-data', 'workspaces', 'task-fast-files')
    const repoPath = path.join(workspacePath, '20x')
    existsSyncMock.mockImplementation((candidate: string) => candidate === workspacePath || candidate === repoPath)
    readdirMock.mockImplementation(async (candidate: string) => candidate === workspacePath
      ? [{ name: 'AGENTS.md', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }]
      : [])
    execFileMock.mockImplementation((_file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (args.includes('ls-files')) callback(null, 'README.md\0src/index.ts\0', '')
      else callback(new Error(`Unexpected command: ${args.join(' ')}`))
    })

    const result = await new WorktreeManager().getTaskFiles('task-fast-files', [{ fullName: 'peakflo/20x' }])

    expect(result).toEqual([
      { repo: 'Task workspace', allFiles: ['AGENTS.md'], workspace: true },
      { repo: 'peakflo/20x', allFiles: ['README.md', 'src/index.ts'] }
    ])
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('reads selected files lazily and rejects paths resolving outside the task workspace', () => {
    const workspacePath = path.join('/tmp/20x-user-data', 'workspaces', 'task-5')
    const repoPath = path.join(workspacePath, '20x')
    const filePath = path.join(repoPath, 'src', 'index.ts')
    realpathSyncMock.mockImplementation((candidate: string) => candidate)
    statSyncMock.mockReturnValue({ isFile: () => true, size: 18 })
    readFileSyncMock.mockReturnValue(Buffer.from('export const ok = 1'))

    const manager = new WorktreeManager()
    expect(manager.readTaskFile('task-5', 'peakflo/20x', 'src/index.ts')).toEqual({
      content: 'export const ok = 1',
      size: 18,
      binary: false,
      truncated: false
    })
    expect(readFileSyncMock).toHaveBeenCalledWith(filePath)

    realpathSyncMock.mockImplementation((candidate: string) => candidate.endsWith('escape.ts') ? '/tmp/outside/escape.ts' : candidate)
    expect(manager.readTaskFile('task-5', 'peakflo/20x', '../escape.ts')).toBeNull()
    expect(manager.readTaskFile('task-5', 'peakflo/20x', 'src/escape.ts')).toBeNull()
  })
})
