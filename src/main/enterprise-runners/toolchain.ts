import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export type IsExecutable = (path: string) => boolean

export const defaultIsExecutable: IsExecutable = (path) => {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Only absolute PATH entries. An empty entry or `.` means "the current
 * directory", which would let a project-local binary take over.
 */
export function absolutePathDirs(pathValue: string | undefined): string[] {
  return (pathValue ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '' && isAbsolute(dir))
}

export function resolveExecutable(
  name: string,
  dirs: readonly string[],
  isExecutable: IsExecutable = defaultIsExecutable
): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export interface Toolchain {
  node: string | null
  /** Resolved next to `node` first, so it is the npm that belongs to that Node. */
  npx: string | null
  git: string | null
  dirs: string[]
}

export function resolveToolchain(env: NodeJS.ProcessEnv = process.env, isExecutable: IsExecutable = defaultIsExecutable): Toolchain {
  const dirs = absolutePathDirs(env.PATH)
  const node = resolveExecutable('node', dirs, isExecutable)
  const nodeDir = node ? node.slice(0, node.lastIndexOf('/')) : null
  const beside = nodeDir ? join(nodeDir, 'npx') : null
  const npx = beside && isExecutable(beside) ? beside : resolveExecutable('npx', dirs, isExecutable)
  return { node, npx, git: resolveExecutable('git', dirs, isExecutable), dirs }
}
