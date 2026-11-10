import { lstat, readdir, rm } from 'fs/promises'
import { join } from 'path'

export interface TurboCachePruneResult {
  files: number
  bytes: number
  errors: string[]
}

async function directoryEntries(path: string): Promise<import('fs').Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Find only cache directories owned by 20x. Do not follow directory links. */
export async function findTurboCacheDirs(reposRoot: string, workspacesRoot: string): Promise<string[]> {
  const found: string[] = []
  for (const org of await directoryEntries(reposRoot)) {
    if (!org.isDirectory()) continue
    const turbo = join(reposRoot, org.name, '.turbo')
    if (!await isRealDirectory(turbo)) continue
    const cache = join(turbo, 'cache')
    if (await isRealDirectory(cache)) found.push(cache)
  }
  for (const workspace of await directoryEntries(workspacesRoot)) {
    if (!workspace.isDirectory()) continue
    for (const repo of await directoryEntries(join(workspacesRoot, workspace.name))) {
      if (!repo.isDirectory()) continue
      const turbo = join(workspacesRoot, workspace.name, repo.name, '.turbo')
      if (!await isRealDirectory(turbo)) continue
      const cache = join(turbo, 'cache')
      if (await isRealDirectory(cache)) found.push(cache)
    }
  }
  return found
}

/** Delete old regular cache files. The cache can be rebuilt by Turbo. */
export async function pruneStaleTurboCache(input: {
  reposRoot: string
  workspacesRoot: string
  inactiveDays: number
  now?: number
  onProgress?: (processed: number, total: number) => void
}): Promise<TurboCachePruneResult> {
  const result: TurboCachePruneResult = { files: 0, bytes: 0, errors: [] }
  if (!Number.isFinite(input.inactiveDays) || input.inactiveDays < 1) {
    result.errors.push(`Refusing Turbo cache prune with invalid threshold: ${input.inactiveDays}`)
    return result
  }
  let dirs: string[]
  try {
    dirs = await findTurboCacheDirs(input.reposRoot, input.workspacesRoot)
  } catch (error) {
    result.errors.push(`Could not find Turbo caches: ${error instanceof Error ? error.message : String(error)}`)
    return result
  }
  const cutoff = (input.now ?? Date.now()) - input.inactiveDays * 24 * 60 * 60 * 1000
  let processed = 0
  for (const dir of dirs) {
    let entries: import('fs').Dirent[]
    try {
      entries = await directoryEntries(dir)
    } catch (error) {
      result.errors.push(`Could not read ${dir}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const path = join(dir, entry.name)
      try {
        const stat = await lstat(path)
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue
        await rm(path)
        result.files++
        result.bytes += stat.size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          result.errors.push(`Could not prune ${path}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    input.onProgress?.(++processed, dirs.length)
  }
  return result
}
