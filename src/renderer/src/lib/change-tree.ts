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
  files: DiffFile[]
  stats: ChangeTreeStats
}

interface MutableDirectory {
  name: string
  path: string
  directories: Map<string, MutableDirectory>
  files: DiffFile[]
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
        additions: total.additions + file.additions,
        deletions: total.deletions + file.deletions,
        files: total.files + 1
      }),
      { additions: 0, deletions: 0, files: 0 }
    )
  )
  return { name: directory.name, path: directory.path, directories, files, stats }
}

export function buildChangeTree(files: DiffFile[]): ChangeTreeDirectory {
  const root: MutableDirectory = { name: '', path: '', directories: new Map(), files: [] }

  for (const file of files) {
    const segments = file.path.replace(/\\/g, '/').split('/').filter(Boolean)
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
    directory.files.push(file)
  }

  return finalize(root)
}
