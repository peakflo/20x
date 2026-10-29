import { execFile } from 'child_process'
import { promisify } from 'util'
import { lstat, mkdir, readdir, rename, rm, rmdir } from 'fs/promises'
import { extname, join, relative } from 'path'
import { TaskStatus } from '../shared/constants'
import { ARTIFACT_OUTPUT_DIRECTORIES, artifactWorkpieceForPath } from '../shared/artifacts'
import { artifactTypeForPath } from './artifacts'
import { gitChildEnv } from './git-child-env'
import { findWorkspacesWithLiveProcesses } from './workspace-node-modules-gc'

const execFileAsync = promisify(execFile)
const DAY_MS = 24 * 60 * 60 * 1000
const OUTPUT_DIRECTORIES = ARTIFACT_OUTPUT_DIRECTORIES
const SKIP_OUTPUT_SCAN = new Set(['.git', '.next', '.turbo', 'node_modules'])
const ROOT_OUTPUT_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.zip'])
const ROOT_NON_OUTPUTS = new Set(['AGENTS.md', 'CLAUDE.md', 'heartbeat.md'])
const STAGING_DIRECTORY = 'retire-staging'

export interface FinishedWorkspaceTask {
  id: string
  status: string
  parent_task_id: string | null
  updated_at: string
}

export interface FinishedWorkspaceResult {
  workspaces: number
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

function isRootOutputFile(name: string): boolean {
  if (ROOT_NON_OUTPUTS.has(name)) return false
  const type = artifactTypeForPath(name)
  return (type !== null && artifactWorkpieceForPath(name, type) !== null) ||
    ROOT_OUTPUT_EXTENSIONS.has(extname(name).toLowerCase())
}

/** Find output folders and disposable content without entering dependencies or Git internals. */
async function inspectDirectory(root: string): Promise<{ outputs: string[]; disposable: boolean }> {
  const outputs: string[] = []
  async function visit(directory: string): Promise<{ hasOutput: boolean; disposable: boolean }> {
    let hasOutput = false
    let disposable = false
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name)
      if (OUTPUT_DIRECTORIES.has(entry.name.toLowerCase()) && (entry.isDirectory() || entry.isSymbolicLink())) {
        outputs.push(child)
        hasOutput = true
      } else if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_OUTPUT_SCAN.has(entry.name)) {
        const nested = await visit(child)
        hasOutput ||= nested.hasOutput
        disposable ||= nested.disposable || !nested.hasOutput
      } else {
        disposable = true
      }
    }
    return { hasOutput, disposable }
  }
  const { disposable } = await visit(root)
  return { outputs, disposable }
}

/** Recover outputs if an earlier cleanup stopped after staging them. */
async function restoreStagedOutputs(workspace: string): Promise<void> {
  const stage = join(workspace, '.20x', STAGING_DIRECTORY)
  try {
    const metadata = await lstat(stage)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Output staging path is not a directory')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  async function restore(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name)
      const destination = join(workspace, relative(stage, source))
      if (OUTPUT_DIRECTORIES.has(entry.name.toLowerCase()) && (entry.isDirectory() || entry.isSymbolicLink())) {
        await mkdir(join(destination, '..'), { recursive: true })
        await rename(source, destination)
      } else if (entry.isDirectory()) {
        await restore(source)
        await rmdir(source)
      }
    }
  }
  await restore(stage)
  await rmdir(stage)
}

async function retireDirectory(workspace: string, directory: string, outputs: readonly string[]): Promise<void> {
  const stage = join(workspace, '.20x', STAGING_DIRECTORY)
  try {
    for (const output of outputs) {
      const destination = join(stage, relative(workspace, output))
      await mkdir(join(destination, '..'), { recursive: true })
      await rename(output, destination)
    }
    const gitMarker = await lstat(join(directory, '.git')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (gitMarker?.isFile()) {
      // Force is intentional: the finished task has passed its retention period.
      // Git removes its worktree registration as well as its checkout.
      await execFileAsync('git', ['worktree', 'remove', '--force', directory], {
        cwd: directory,
        env: gitChildEnv(),
        timeout: 120_000
      })
    } else {
      // This also removes separate clones and local files in ordinary directories.
      await rm(directory, { recursive: true, force: true })
    }
  } finally {
    await restoreStagedOutputs(workspace)
  }
}

async function pruneWorkspaceMetadata(workspace: string): Promise<boolean> {
  const metadata = join(workspace, '.20x')
  let entries
  try { entries = await readdir(metadata, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  let removed = false
  for (const entry of entries) {
    if (entry.name === 'artifacts.json' || OUTPUT_DIRECTORIES.has(entry.name.toLowerCase())) continue
    await rm(join(metadata, entry.name), { recursive: true, force: true })
    removed = true
  }
  return removed
}

/** Retire all non-output files in old finished task workspaces. The task root,
 * artifact registry, artifact folders, and output folders remain available. */
export async function retireFinishedWorkspaces(input: {
  workspacesRoot: string
  tasks: readonly FinishedWorkspaceTask[]
  inactiveDays: number
  nowMs?: number
  onProgress?: (current: number, total: number) => void
}): Promise<FinishedWorkspaceResult> {
  const result: FinishedWorkspaceResult = { workspaces: 0, errors: [] }
  if (!Number.isFinite(input.inactiveDays) || input.inactiveDays < 1) {
    result.errors.push(`Refusing finished workspace retirement with invalid threshold: ${input.inactiveDays}`)
    return result
  }
  const ids = finishedWorkspaceIds(input.tasks, input.inactiveDays, input.nowMs)
  if (ids.length === 0) return result

  // A finished status can coexist with a running agent. Keep the workspace
  // when process liveness cannot be established.
  const live = findWorkspacesWithLiveProcesses(input.workspacesRoot, ids)
  if (live === null) {
    result.errors.push('Could not check running workspace processes; finished workspace retirement was skipped')
    return result
  }

  for (const [index, id] of ids.entries()) {
    const workspace = join(input.workspacesRoot, id)
    try {
      if (live.has(id)) continue
      const rootMetadata = await lstat(workspace)
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
        result.errors.push(`Finished workspace ${id} is not a directory`)
        continue
      }
      const internalMetadata = await lstat(join(workspace, '.20x')).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (internalMetadata && (!internalMetadata.isDirectory() || internalMetadata.isSymbolicLink())) {
        result.errors.push(`Finished workspace ${id} has invalid artifact metadata`)
        continue
      }
      await restoreStagedOutputs(workspace)
      const entries = await readdir(workspace, { withFileTypes: true })
      let changed = false
      for (const entry of entries) {
        const path = join(workspace, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (entry.name === '.20x' || OUTPUT_DIRECTORIES.has(entry.name.toLowerCase())) continue
          if (entry.name === '.git') {
            await rm(path, { recursive: true, force: true })
            changed = true
            continue
          }
          const inspected = await inspectDirectory(path)
          if (inspected.disposable || inspected.outputs.length === 0) {
            await retireDirectory(workspace, path, inspected.outputs)
            changed = true
          }
        } else if (OUTPUT_DIRECTORIES.has(entry.name.toLowerCase()) && entry.isSymbolicLink()) {
          continue
        } else if (!entry.isFile() || !isRootOutputFile(entry.name)) {
          await rm(path, { recursive: true, force: true })
          changed = true
        }
      }
      changed = await pruneWorkspaceMetadata(workspace) || changed
      if (changed) result.workspaces++
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        result.errors.push(`Could not retire finished workspace ${id}: ${String(error)}`)
      }
    } finally {
      input.onProgress?.(index + 1, ids.length)
    }
  }
  return result
}
