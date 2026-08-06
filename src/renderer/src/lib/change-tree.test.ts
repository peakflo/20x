import { describe, expect, it } from 'vitest'
import type { DiffFile } from './diff-parser'
import { buildChangeTree } from './change-tree'

function file(path: string, additions: number, deletions: number): DiffFile {
  return {
    oldPath: path,
    newPath: path,
    path,
    status: 'modified',
    additions,
    deletions,
    binary: false,
    hunks: []
  }
}

describe('buildChangeTree', () => {
  it('groups changed files into a sorted directory hierarchy with aggregate stats', () => {
    const tree = buildChangeTree([
      file('src/z.ts', 2, 1),
      file('README.md', 1, 0),
      file('src/components/Button.tsx', 5, 3),
      file('src/a.ts', 4, 2)
    ])

    expect(tree.files.map((entry) => entry.path)).toEqual(['README.md'])
    expect(tree.directories.map((entry) => entry.path)).toEqual(['src'])
    expect(tree.directories[0].files.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/z.ts'])
    expect(tree.directories[0].directories[0].files[0].path).toBe('src/components/Button.tsx')
    expect(tree.directories[0].stats).toEqual({ additions: 11, deletions: 6, files: 3 })
    expect(tree.stats).toEqual({ additions: 12, deletions: 6, files: 4 })
  })
})
