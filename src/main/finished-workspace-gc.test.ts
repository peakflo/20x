import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskStatus } from '../shared/constants'
import { gitChildEnv } from './git-child-env'
import { finishedWorkspaceIds, retireFinishedWorkspaces, type FinishedWorkspaceTask } from './finished-workspace-gc'
import { findWorkspacesWithLiveProcesses } from './workspace-node-modules-gc'

vi.mock('./workspace-node-modules-gc', () => ({ findWorkspacesWithLiveProcesses: vi.fn(() => new Set<string>()) }))

const roots: string[] = []
const old = '2020-01-01T00:00:00.000Z'
const recent = '2026-10-27T00:00:00.000Z'

function task(id: string, status: TaskStatus, parent_task_id: string | null = null, updated_at = old): FinishedWorkspaceTask {
  return { id, status, parent_task_id, updated_at }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitChildEnv(), encoding: 'utf8', stdio: 'pipe' })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(findWorkspacesWithLiveProcesses).mockReturnValue(new Set())
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('finished workspace retirement', () => {
  it('selects old completed tasks and review children of completed parents', () => {
    const tasks = [
      task('done', TaskStatus.Completed),
      task('child', TaskStatus.ReadyForReview, 'done'),
      task('open', TaskStatus.AgentWorking),
      task('review', TaskStatus.ReadyForReview),
      task('../outside', TaskStatus.Completed),
      task('new-parent', TaskStatus.Completed, null, recent),
      task('old-child-new-parent', TaskStatus.ReadyForReview, 'new-parent')
    ]
    expect(finishedWorkspaceIds(tasks, 7, Date.parse('2026-10-27T12:00:00.000Z'))).toEqual(['done', 'child'])
  })

  it('removes finished worktrees, separate clones, and local files while keeping outputs', async () => {
    const root = mkdtempSync(join(tmpdir(), '20x-finished-gc-'))
    roots.push(root)
    const base = join(root, 'base')
    const workspacesRoot = join(root, 'workspaces')
    mkdirSync(base)
    mkdirSync(workspacesRoot)
    git(base, 'init', '-q')
    git(base, 'config', 'user.email', 'test@example.com')
    git(base, 'config', 'user.name', 'Test')
    writeFileSync(join(base, 'file.txt'), 'original')
    git(base, 'add', 'file.txt')
    git(base, 'commit', '-qm', 'initial')
    writeFileSync(join(base, '.gitignore'), 'node_modules/\n')
    git(base, 'add', '.gitignore')
    git(base, 'commit', '-qm', 'ignore dependencies')
    for (const id of ['clean', 'dirty', 'ignored']) {
      const workspace = join(workspacesRoot, id)
      mkdirSync(workspace)
      mkdirSync(join(workspace, '.20x'))
      writeFileSync(join(workspace, '.20x', 'artifacts.json'), '{"version":1,"artifacts":[]}')
      writeFileSync(join(workspace, '.20x', 'old-log.txt'), 'remove me')
      mkdirSync(join(workspace, 'artifacts'))
      writeFileSync(join(workspace, 'artifacts', 'report.txt'), id)
      mkdirSync(join(workspace, 'outputs'))
      writeFileSync(join(workspace, 'outputs', 'result.csv'), id)
      writeFileSync(join(workspace, 'summary.md'), id)
      writeFileSync(join(workspace, 'AGENTS.md'), 'remove me')
      writeFileSync(join(workspace, 'local.dat'), 'remove me')
      git(base, 'worktree', 'add', '-q', join(workspace, 'repo'), '-b', id)
    }
    writeFileSync(join(workspacesRoot, 'dirty', 'repo', 'file.txt'), 'local edit')
    mkdirSync(join(workspacesRoot, 'ignored', 'repo', 'node_modules'))
    writeFileSync(join(workspacesRoot, 'ignored', 'repo', 'node_modules', 'local.txt'), 'ignored data')
    mkdirSync(join(workspacesRoot, 'dirty', 'repo', 'outputs'))
    writeFileSync(join(workspacesRoot, 'dirty', 'repo', 'outputs', 'report.txt'), 'keep me')
    mkdirSync(join(workspacesRoot, 'ignored', 'clone'))
    git(join(workspacesRoot, 'ignored', 'clone'), 'init', '-q')
    writeFileSync(join(workspacesRoot, 'ignored', 'clone', 'local.txt'), 'remove me')
    mkdirSync(join(workspacesRoot, 'ignored', 'clone', 'output'))
    writeFileSync(join(workspacesRoot, 'ignored', 'clone', 'output', 'final.pdf'), 'keep me')

    const progress: Array<[number, number]> = []
    const result = await retireFinishedWorkspaces({
      workspacesRoot,
      tasks: [task('clean', TaskStatus.Completed), task('dirty', TaskStatus.Completed), task('ignored', TaskStatus.Completed)],
      inactiveDays: 7,
      nowMs: Date.parse('2026-10-27T12:00:00.000Z'),
      onProgress: (current, total) => progress.push([current, total])
    })

    expect(result).toEqual({ workspaces: 3, errors: [] })
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]])
    for (const id of ['clean', 'dirty', 'ignored']) {
      const workspace = join(workspacesRoot, id)
      expect(readFileSync(join(workspace, 'artifacts', 'report.txt'), 'utf8')).toBe(id)
      expect(readFileSync(join(workspace, 'outputs', 'result.csv'), 'utf8')).toBe(id)
      expect(readFileSync(join(workspace, 'summary.md'), 'utf8')).toBe(id)
      expect(existsSync(join(workspace, 'local.dat'))).toBe(false)
      expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false)
      expect(existsSync(join(workspace, '.20x', 'artifacts.json'))).toBe(true)
      expect(existsSync(join(workspace, '.20x', 'old-log.txt'))).toBe(false)
      expect(existsSync(join(workspace, 'repo', '.git'))).toBe(false)
    }
    expect(existsSync(join(workspacesRoot, 'clean', 'repo'))).toBe(false)
    expect(readFileSync(join(workspacesRoot, 'dirty', 'repo', 'outputs', 'report.txt'), 'utf8')).toBe('keep me')
    expect(existsSync(join(workspacesRoot, 'dirty', 'repo', 'file.txt'))).toBe(false)
    expect(existsSync(join(workspacesRoot, 'ignored', 'repo', 'node_modules'))).toBe(false)
    expect(readFileSync(join(workspacesRoot, 'ignored', 'clone', 'output', 'final.pdf'), 'utf8')).toBe('keep me')
    expect(existsSync(join(workspacesRoot, 'ignored', 'clone', '.git'))).toBe(false)
    expect(existsSync(join(workspacesRoot, 'ignored', 'clone', 'local.txt'))).toBe(false)
    const worktrees = git(base, 'worktree', 'list', '--porcelain')
    expect(worktrees).not.toContain(join(workspacesRoot, 'dirty', 'repo'))
    expect(await retireFinishedWorkspaces({
      workspacesRoot,
      tasks: [task('clean', TaskStatus.Completed), task('dirty', TaskStatus.Completed), task('ignored', TaskStatus.Completed)],
      inactiveDays: 7,
      nowMs: Date.parse('2026-10-27T12:00:00.000Z')
    })).toEqual({ workspaces: 0, errors: [] })
  })

  it('ignores Git paths inherited from a different repository', async () => {
    const root = mkdtempSync(join(tmpdir(), '20x-finished-gc-'))
    roots.push(root)
    const other = join(root, 'other')
    const base = join(root, 'base')
    const workspace = join(root, 'workspaces', 'done')
    mkdirSync(other)
    mkdirSync(base)
    mkdirSync(workspace, { recursive: true })
    git(other, 'init', '-q')
    git(other, 'config', 'user.email', 'test@example.com')
    git(other, 'config', 'user.name', 'Test')
    writeFileSync(join(other, 'safe.txt'), 'unchanged')
    git(other, 'add', 'safe.txt')
    git(other, 'commit', '-qm', 'keep this commit')
    const otherHead = git(other, 'rev-parse', 'HEAD').trim()

    const otherGit = join(other, '.git')
    vi.stubEnv('GIT_DIR', otherGit)
    vi.stubEnv('GIT_INDEX_FILE', join(otherGit, 'index'))
    vi.stubEnv('GIT_WORK_TREE', other)
    vi.stubEnv('GIT_COMMON_DIR', otherGit)
    vi.stubEnv('GIT_OBJECT_DIRECTORY', join(otherGit, 'objects'))
    vi.stubEnv('GIT_PREFIX', 'unrelated/')

    git(base, 'init', '-q')
    git(base, 'config', 'user.email', 'test@example.com')
    git(base, 'config', 'user.name', 'Test')
    writeFileSync(join(base, 'file.txt'), 'fixture')
    git(base, 'add', 'file.txt')
    git(base, 'commit', '-qm', 'fixture commit')
    git(base, 'worktree', 'add', '-q', join(workspace, 'repo'), '-b', 'fixture')

    expect(await retireFinishedWorkspaces({
      workspacesRoot: join(root, 'workspaces'),
      tasks: [task('done', TaskStatus.Completed)],
      inactiveDays: 7,
      nowMs: Date.parse('2026-10-27T12:00:00.000Z')
    })).toEqual({ workspaces: 1, errors: [] })
    expect(existsSync(join(workspace, 'repo'))).toBe(false)
    expect(git(other, 'rev-parse', 'HEAD').trim()).toBe(otherHead)
    expect(git(other, 'status', '--porcelain').trim()).toBe('')
  })

  it('keeps a workspace that has a live process', async () => {
    const root = mkdtempSync(join(tmpdir(), '20x-finished-gc-'))
    roots.push(root)
    const workspace = join(root, 'busy')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'local.dat'), 'keep while busy')
    vi.mocked(findWorkspacesWithLiveProcesses).mockReturnValue(new Set(['busy']))
    expect(await retireFinishedWorkspaces({
      workspacesRoot: root, tasks: [task('busy', TaskStatus.Completed)], inactiveDays: 7,
      nowMs: Date.parse('2026-10-27T12:00:00.000Z')
    })).toEqual({ workspaces: 0, errors: [] })
    expect(readFileSync(join(workspace, 'local.dat'), 'utf8')).toBe('keep while busy')
  })

  it('recovers a staged output before removing the rest of a workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), '20x-finished-gc-'))
    roots.push(root)
    const workspace = join(root, 'done')
    mkdirSync(join(workspace, '.20x', 'retire-staging', 'repo', 'outputs'), { recursive: true })
    writeFileSync(join(workspace, '.20x', 'retire-staging', 'repo', 'outputs', 'final.txt'), 'saved')
    mkdirSync(join(workspace, 'repo'))
    writeFileSync(join(workspace, 'repo', 'scratch.txt'), 'remove')
    expect(await retireFinishedWorkspaces({
      workspacesRoot: root, tasks: [task('done', TaskStatus.Completed)], inactiveDays: 7,
      nowMs: Date.parse('2026-10-27T12:00:00.000Z')
    })).toEqual({ workspaces: 1, errors: [] })
    expect(readFileSync(join(workspace, 'repo', 'outputs', 'final.txt'), 'utf8')).toBe('saved')
    expect(existsSync(join(workspace, 'repo', 'scratch.txt'))).toBe(false)
    expect(existsSync(join(workspace, '.20x', 'retire-staging'))).toBe(false)
  })

  it('does not follow a workspace symlink outside the workspace root', async () => {
    const root = mkdtempSync(join(tmpdir(), '20x-finished-gc-'))
    roots.push(root)
    mkdirSync(join(root, 'outside'))
    writeFileSync(join(root, 'outside', 'local.dat'), 'keep')
    symlinkSync(join(root, 'outside'), join(root, 'done'))
    const result = await retireFinishedWorkspaces({
      workspacesRoot: root, tasks: [task('done', TaskStatus.Completed)], inactiveDays: 7,
      nowMs: Date.parse('2026-10-27T12:00:00.000Z')
    })
    expect(result.workspaces).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(readFileSync(join(root, 'outside', 'local.dat'), 'utf8')).toBe('keep')
  })

  it('does not retire workspaces when process liveness is unknown', async () => {
    vi.mocked(findWorkspacesWithLiveProcesses).mockReturnValue(null)
    const result = await retireFinishedWorkspaces({
      workspacesRoot: '/missing', tasks: [task('done', TaskStatus.Completed)], inactiveDays: 7,
      nowMs: Date.parse('2026-10-27T12:00:00.000Z')
    })
    expect(result.workspaces).toBe(0)
    expect(result.errors).toEqual(['Could not check running workspace processes; finished workspace retirement was skipped'])
  })

  it('rejects an invalid retention period', async () => {
    const result = await retireFinishedWorkspaces({
      workspacesRoot: '/missing', tasks: [task('done', TaskStatus.Completed)], inactiveDays: 0
    })
    expect(result.workspaces).toBe(0)
    expect(result.errors).toHaveLength(1)
  })
})
