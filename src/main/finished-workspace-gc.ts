import { execFile } from 'child_process'
import { promisify } from 'util'
import { lstat, readdir } from 'fs/promises'
import { join } from 'path'
import { TaskStatus } from '../shared/constants'
import { findWorkspacesWithLiveProcesses } from './workspace-node-modules-gc'

const execFileAsync = promisify(execFile)
const DAY_MS = 24 * 60 * 60 * 1000

export interface FinishedWorkspaceTask {
  id: string
  status: string
  parent_task_id: string | null
  updated_at: string
}

export interface FinishedWorkspaceResult {
  worktrees: number
  errors: string[]
}

/** Review subtasks under completed parents are finished for disk cleanup.
 * Their stored status is left alone so source sync and review history remain intact. */
export function finishedWorkspaceIds(tasks: readonly FinishedWorkspaceTask[], inactiveDays: number, nowMs = Date.now()): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const cutoff = nowMs - inactiveDays * DAY_MS
  return tasks.filter((task) => {
    if (!task.id || task.id === '.' || task.id === '..' || /[\\/\0]/.test(task.id)) return false
    const parent = task.parent_task_id ? byId.get(task.parent_task_id) : undefined
    const finished = task.status === TaskStatus.Completed ||
      (task.status === TaskStatus.ReadyForReview && parent?.status === TaskStatus.Completed)
    if (!finished) return false
    const lastUpdate = Math.max(Date.parse(task.updated_at), parent ? Date.parse(parent.updated_at) : 0)
    return Number.isFinite(lastUpdate) && lastUpdate < cutoff
  }).map((task) => task.id)
}

/** Remove only worktrees with no local files. Git refuses tracked edits and
 * untracked files, but it removes ignored files without asking. Check those
 * explicitly so local ignored data stays in place. Task artifacts remain. */
export async function retireFinishedWorktrees(input: {
  workspacesRoot: string
  tasks: readonly FinishedWorkspaceTask[]
  inactiveDays: number
  nowMs?: number
}): Promise<FinishedWorkspaceResult> {
  const result: FinishedWorkspaceResult = { worktrees: 0, errors: [] }
  const ids = finishedWorkspaceIds(input.tasks, input.inactiveDays, input.nowMs)
  if (ids.length === 0) return result

  // When process liveness is unknown, keep every worktree. A running agent may
  // have a completed task status after a delayed event or another app instance.
  const live = findWorkspacesWithLiveProcesses(input.workspacesRoot, ids)
  if (live === null) return result

  for (const id of ids) {
    if (live.has(id)) continue
    const workspace = join(input.workspacesRoot, id)
    let entries
    try {
      entries = await readdir(workspace, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        result.errors.push(`Could not read finished workspace ${id}: ${String(error)}`)
      }
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const worktree = join(workspace, entry.name)
      try {
        const gitMarker = await lstat(join(worktree, '.git'))
        if (!gitMarker.isFile()) continue // A managed worktree has a .git file.
        const { stdout } = await execFileAsync('git', [
          '-C', worktree, 'status', '--porcelain=v1', '--untracked-files=normal', '--ignored=matching'
        ], { timeout: 60_000 })
        if (stdout.trim()) continue
        await execFileAsync('git', ['-C', worktree, 'worktree', 'remove', worktree], { timeout: 60_000 })
        result.worktrees++
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        // Git refusal means the checkout has local data. Leave it in place and
        // retry on a later cleanup if the user clears it.
        const gitError = error as { stderr?: string }
        if (/contains modified or untracked files|is dirty/i.test(gitError.stderr || '')) continue
        result.errors.push(`Could not retire worktree ${id}/${entry.name}: ${String(error)}`)
      }
    }
  }
  return result
}
