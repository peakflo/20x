import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskStatus } from '../shared/constants'
import { finishedWorkspaceIds, retireFinishedWorktrees, type FinishedWorkspaceTask } from './finished-workspace-gc'
import { findWorkspacesWithLiveProcesses } from './workspace-node-modules-gc'

vi.mock('./workspace-node-modules-gc', () => ({ findWorkspacesWithLiveProcesses: vi.fn(() => new Set<string>()) }))

const roots: string[] = []
const old = '2020-01-01T00:00:00.000Z'
const recent = '2026-10-27T00:00:00.000Z'

function task(id: string, status: TaskStatus, parent_task_id: string | null = null, updated_at = old): FinishedWorkspaceTask {
  return { id, status, parent_task_id, updated_at }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

afterEach(() => {
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

  it('retires only clean worktrees and keeps task artifacts and local edits', async () => {
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
    for (const id of ['clean', 'dirty']) {
      const workspace = join(workspacesRoot, id)
      mkdirSync(workspace)
      mkdirSync(join(workspace, 'artifacts'))
      writeFileSync(join(workspace, 'artifacts', 'report.txt'), id)
      git(base, 'worktree', 'add', '-q', join(workspace, 'repo'), '-b', id)
    }
    writeFileSync(join(workspacesRoot, 'dirty', 'repo', 'file.txt'), 'local edit')

    const result = await retireFinishedWorktrees({
      workspacesRoot,
      tasks: [task('clean', TaskStatus.Completed), task('dirty', TaskStatus.Completed)],
      inactiveDays: 7,
      nowMs: Date.parse('2026-10-27T12:00:00.000Z')
    })

    expect(result).toEqual({ worktrees: 1, errors: [] })
    expect(existsSync(join(workspacesRoot, 'clean', 'repo'))).toBe(false)
    expect(readFileSync(join(workspacesRoot, 'clean', 'artifacts', 'report.txt'), 'utf8')).toBe('clean')
    expect(readFileSync(join(workspacesRoot, 'dirty', 'repo', 'file.txt'), 'utf8')).toBe('local edit')
  })

  it('does not retire worktrees when process liveness is unknown', async () => {
    vi.mocked(findWorkspacesWithLiveProcesses).mockReturnValue(null)
    const result = await retireFinishedWorktrees({
      workspacesRoot: '/missing', tasks: [task('done', TaskStatus.Completed)], inactiveDays: 7,
      nowMs: Date.parse('2026-10-27T12:00:00.000Z')
    })
    expect(result).toEqual({ worktrees: 0, errors: [] })
  })
})
