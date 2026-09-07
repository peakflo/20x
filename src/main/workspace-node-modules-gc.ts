import { existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import {
  ACTIVE_TASK_STATUSES,
  canReadProcessCwd,
  readProcessSnapshot,
  resolveWorkspacesRoot,
  workspaceIdForCwd
} from './workspace-process-cleanup'

/**
 * Age-based pruning of idle `node_modules` directories inside task workspaces.
 *
 * Whole-workspace cleanup only handles `completed` tasks, so review-pending and
 * other live workspaces accumulate dependency directories forever (measured:
 * 175 stale `node_modules` holding ~23 GB). Dependencies are regenerable from
 * `package.json`, so deleting just them is safe for every task status — source
 * files, worktrees and review state are left untouched.
 *
 * Inactivity is the `node_modules` directory's own mtime: installing, adding
 * or removing a top-level entry refreshes it, while reads (builds, typechecks)
 * do not. A directory untouched for longer than the threshold is pruned.
 *
 * Settings:
 * - `workspace_nodemodules_gc_enabled` — "true"/"false" (default: "true")
 * - `workspace_nodemodules_gc_days` — days of inactivity before pruning (default: 7)
 * - `workspace_nodemodules_gc_last_run` — ISO timestamp of the last automatic run
 */

export const NODE_MODULES_GC_ENABLED_KEY = 'workspace_nodemodules_gc_enabled'
export const NODE_MODULES_GC_DAYS_KEY = 'workspace_nodemodules_gc_days'
export const NODE_MODULES_GC_LAST_RUN_KEY = 'workspace_nodemodules_gc_last_run'

export const DEFAULT_NODE_MODULES_GC_DAYS = 7

export interface NodeModulesPruneResult {
  /** Absolute paths of the `node_modules` directories that were removed. */
  pruned: string[]
  errors: string[]
}

/** True when `mtimeMs` is older than `inactiveDays` measured from `nowMs`. */
export function isInactive(mtimeMs: number, nowMs: number, inactiveDays: number): boolean {
  return mtimeMs < nowMs - inactiveDays * 24 * 60 * 60 * 1000
}

/**
 * Every top-level `node_modules` directory under `workspaceDir`, at any depth:
 * `.opencode/node_modules`, `<repo>/node_modules`, `<repo>/functions/node_modules`,
 * `<pkg>/packages/<name>/node_modules`, …
 *
 * A `node_modules` that contains another `node_modules` is reported once — the
 * walk does not descend into it, since removing the outer one removes the inner.
 * `.git` directories are never descended into (worktree metadata, not deps).
 * Unreadable subdirectories are skipped silently; they are retried on the next run.
 */
export function findTopLevelNodeModules(workspaceDir: string): string[] {
  const found: string[] = []
  const stack: string[] = [workspaceDir]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules') {
        found.push(join(dir, entry.name))
        continue
      }
      // Symbolic links to directories are not followed: a linked `node_modules`
      // (e.g. pnpm-style) is either reported by name above or left alone, and
      // following links could escape the workspace or loop.
      if (entry.isSymbolicLink()) continue
      if (entry.name === '.git') continue
      stack.push(join(dir, entry.name))
    }
  }
  return found
}

/**
 * Workspace ids that currently have at least one process rooted in them.
 *
 * Returns NULL when that cannot be determined — on Windows (no cheap cwd query)
 * or when the process table yields no cwd rows at all. A NULL must fall back to
 * a conservative rule (e.g. skipping `ACTIVE_TASK_STATUSES`); it must never be
 * read as "nothing is running". An empty set is the real, readable answer.
 *
 * Deliberately unguarded: unlike the kill paths, our own processes also count
 * as activity here. Skipping a workspace we happen to run from is the safe side.
 */
export function findWorkspacesWithLiveProcesses(
  workspacesRoot: string,
  dirNames: readonly string[]
): Set<string> | null {
  if (!canReadProcessCwd()) return null
  if (dirNames.length === 0) return new Set()
  let snapshot: { cwdRows: { pid: number; cwd: string }[] }
  try {
    snapshot = readProcessSnapshot()
  } catch {
    return null
  }
  if (snapshot.cwdRows.length === 0) return null
  const wanted = new Set(dirNames)
  const root = resolveWorkspacesRoot(workspacesRoot)
  const active = new Set<string>()
  for (const { cwd } of snapshot.cwdRows) {
    const id = workspaceIdForCwd(cwd, root)
    if (id !== null && wanted.has(id)) active.add(id)
  }
  return active
}

/**
 * Workspace ids to spare when liveness cannot be observed. A task an agent is
 * actively working on may hold a build lock inside `node_modules`; without a
 * process snapshot there is no way to tell it apart from a stuck one, so every
 * task in an active status is skipped. Stuck-but-idle tasks are still pruned on
 * platforms where the snapshot works, because there the live-process check ran.
 */
export function activeStatusWorkspaceIds(
  tasks: readonly { id: string; status: string }[]
): Set<string> {
  const active = new Set<string>()
  for (const task of tasks) {
    if ((ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status)) active.add(task.id)
  }
  return active
}

/**
 * Removes every top-level `node_modules` under `workspacesRoot` whose own mtime
 * is older than `inactiveDays`, except in skipped workspaces.
 *
 * Never throws: per-directory failures are collected in `errors` and the run
 * continues. Rejects a threshold below 1 day rather than pruning everything.
 */
export function pruneStaleNodeModules(input: {
  workspacesRoot: string
  inactiveDays: number
  now?: number
  skipWorkspaceIds?: ReadonlySet<string>
  onProgress?: (processed: number, total: number, currentPath: string) => void
}): NodeModulesPruneResult {
  const pruned: string[] = []
  const errors: string[] = []
  const { workspacesRoot, skipWorkspaceIds, onProgress } = input
  const now = input.now ?? Date.now()
  const inactiveDays = input.inactiveDays

  if (!Number.isFinite(inactiveDays) || inactiveDays < 1) {
    return { pruned, errors: [`Refusing node_modules prune with invalid threshold: ${String(inactiveDays)}`] }
  }

  let dirNames: string[]
  try {
    if (!existsSync(workspacesRoot)) return { pruned, errors }
    dirNames = readdirSync(workspacesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (err) {
    return { pruned, errors: [`Could not list workspaces directory: ${err instanceof Error ? err.message : String(err)}`] }
  }

  const candidates = dirNames.filter((name) => !(skipWorkspaceIds?.has(name) ?? false))
  let processed = 0
  for (const name of candidates) {
    const workspaceDir = join(workspacesRoot, name)
    onProgress?.(processed, candidates.length, workspaceDir)
    for (const nmPath of findTopLevelNodeModules(workspaceDir)) {
      let mtimeMs: number
      try {
        mtimeMs = statSync(nmPath).mtimeMs
      } catch (err) {
        errors.push(`Could not stat ${nmPath}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      if (!isInactive(mtimeMs, now, inactiveDays)) continue
      try {
        rmSync(nmPath, { recursive: true, force: true })
        pruned.push(nmPath)
        console.log(`[NodeModulesGC] Pruned idle node_modules: ${nmPath}`)
      } catch (err) {
        errors.push(`Failed to prune ${nmPath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    processed++
  }
  onProgress?.(processed, candidates.length, '')

  return { pruned, errors }
}
