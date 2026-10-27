import { existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { terminateProcessesInWorkspaces } from './workspace-process-cleanup'
import {
  activeStatusWorkspaceIds,
  findWorkspacesWithLiveProcesses,
  pruneStaleNodeModules
} from './workspace-node-modules-gc'

export type WorkspaceCleanupJob =
  | { kind: 'orphans'; workspacesRoot: string; taskIds: string[]; retentionDays: number }
  | { kind: 'node-modules'; workspacesRoot: string; tasks: { id: string; status: string }[]; inactiveDays: number }

export type WorkspaceCleanupJobResult =
  | { kind: 'orphans'; cleaned: number; errors: string[] }
  | { kind: 'node-modules'; pruned: number; errors: string[] }

export type WorkspaceCleanupWorkerProgress = {
  phase: 'scanning' | 'cleaning' | 'pruning'
  current: number
  total: number
  message: string
}

/** Run the disk and process work outside Electron's main thread. */
export async function executeWorkspaceCleanupJob(
  job: WorkspaceCleanupJob,
  onProgress: (progress: WorkspaceCleanupWorkerProgress) => void = () => {}
): Promise<WorkspaceCleanupJobResult> {
  if (job.kind === 'node-modules') {
    const errors: string[] = []
    let dirs: string[] = []
    try {
      if (existsSync(job.workspacesRoot)) {
        dirs = readdirSync(job.workspacesRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      }
    } catch (error) {
      errors.push(`Could not list workspaces directory: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'node-modules', pruned: 0, errors }
    }

    let skip = findWorkspacesWithLiveProcesses(job.workspacesRoot, dirs)
    if (skip === null) skip = activeStatusWorkspaceIds(job.tasks)
    onProgress({ phase: 'pruning', current: 0, total: dirs.length, message: `Pruning idle node_modules (inactive > ${job.inactiveDays} days)...` })
    const result = pruneStaleNodeModules({
      workspacesRoot: job.workspacesRoot,
      inactiveDays: job.inactiveDays,
      skipWorkspaceIds: skip,
      onProgress: (current, total) => onProgress({ phase: 'pruning', current, total, message: 'Pruning idle node_modules...' })
    })
    onProgress({ phase: 'pruning', current: dirs.length, total: dirs.length, message: `Pruned ${result.pruned.length} idle node_modules` })
    return { kind: 'node-modules', pruned: result.pruned.length, errors: [...errors, ...result.errors] }
  }

  const errors: string[] = []
  // An empty task list can mean that the database is unavailable. Do not
  // classify every directory as an orphan if ownership cannot be checked.
  if (job.taskIds.length === 0) return { kind: 'orphans', cleaned: 0, errors }

  const cutoff = Date.now() - job.retentionDays * 24 * 60 * 60 * 1000
  let orphanDirs: string[] = []
  try {
    if (existsSync(job.workspacesRoot)) {
      const taskIds = new Set(job.taskIds)
      orphanDirs = readdirSync(job.workspacesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !taskIds.has(entry.name))
        .map((entry) => entry.name)
        .filter((name) => {
          try { return statSync(join(job.workspacesRoot, name)).mtimeMs < cutoff }
          catch { return false }
        })
    }
  } catch (error) {
    errors.push(`Could not scan workspaces directory: ${error instanceof Error ? error.message : String(error)}`)
    return { kind: 'orphans', cleaned: 0, errors }
  }

  // Stop workspace processes before removal. The scan can wait for lsof, so it
  // must run in the worker with the directory scan and deletion.
  if (orphanDirs.length > 0) {
    try {
      await terminateProcessesInWorkspaces({ workspacesRoot: job.workspacesRoot, workspaceIds: orphanDirs })
    } catch (error) {
      errors.push(`Failed to terminate workspace processes: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  onProgress({ phase: 'scanning', current: 0, total: orphanDirs.length, message: `Found ${orphanDirs.length} workspaces to clean` })

  let cleaned = 0
  for (const [index, name] of orphanDirs.entries()) {
    onProgress({ phase: 'cleaning', current: index, total: orphanDirs.length, message: `Cleaning orphaned workspace ${name.substring(0, 12)}...` })
    try {
      rmSync(join(job.workspacesRoot, name), { recursive: true, force: true })
      cleaned++
    } catch (error) {
      errors.push(`Failed to clean orphaned directory ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { kind: 'orphans', cleaned, errors }
}
