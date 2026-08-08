import type { DiffFile } from './diff-parser'

export interface ChangeTreeStats {
  additions: number
  deletions: number
  files: number
}

export interface ChangeTreeDirectory {
  name: string
  path: string
  directories: ChangeTreeDirectory[]
  files: ChangeTreeFile[]
  stats: ChangeTreeStats
}

export interface ChangeTreeFile {
  path: string
  change?: DiffFile
}

interface MutableDirectory {
  name: string
  path: string
  directories: Map<string, MutableDirectory>
  files: ChangeTreeFile[]
}

function finalize(directory: MutableDirectory): ChangeTreeDirectory {
  const directories = [...directory.directories.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(finalize)
  const files = [...directory.files].sort((left, right) => left.path.localeCompare(right.path))
  const stats = directories.reduce<ChangeTreeStats>(
    (total, child) => ({
      additions: total.additions + child.stats.additions,
      deletions: total.deletions + child.stats.deletions,
      files: total.files + child.stats.files
    }),
    files.reduce<ChangeTreeStats>(
      (total, file) => ({
        additions: total.additions + (file.change?.additions || 0),
        deletions: total.deletions + (file.change?.deletions || 0),
        files: total.files + 1
      }),
      { additions: 0, deletions: 0, files: 0 }
    )
  )
  return { name: directory.name, path: directory.path, directories, files, stats }
}

export function buildFileTree(paths: string[], changes: DiffFile[]): ChangeTreeDirectory {
  const root: MutableDirectory = { name: '', path: '', directories: new Map(), files: [] }
  const changesByPath = new Map(changes.map((file) => [file.path, file]))

  for (const rawPath of paths) {
    const path = rawPath.replace(/\\/g, '/')
    const segments = path.split('/').filter(Boolean)
    if (segments.length === 0) continue
    let directory = root
    for (const segment of segments.slice(0, -1)) {
      const path = directory.path ? `${directory.path}/${segment}` : segment
      let child = directory.directories.get(segment)
      if (!child) {
        child = { name: segment, path, directories: new Map(), files: [] }
        directory.directories.set(segment, child)
      }
      directory = child
    }
    directory.files.push({ path, change: changesByPath.get(path) })
  }

  return finalize(root)
}

export function buildChangeTree(files: DiffFile[]): ChangeTreeDirectory {
  return buildFileTree(files.map((file) => file.path), files)
}
