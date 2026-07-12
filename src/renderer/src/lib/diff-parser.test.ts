import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff, wordDiff } from './diff-parser'

describe('parseUnifiedDiff', () => {
  it('parses a modified file with counts + line numbers', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 111..222 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
      ' const c = 4',
      '',
    ].join('\n')
    const [file] = parseUnifiedDiff(diff)
    expect(file.path).toBe('src/foo.ts')
    expect(file.status).toBe('modified')
    expect(file.additions).toBe(1)
    expect(file.deletions).toBe(1)
    expect(file.hunks).toHaveLength(1)
    const lines = file.hunks[0].lines
    expect(lines[0]).toMatchObject({ type: 'context', oldLine: 1, newLine: 1 })
    expect(lines[1]).toMatchObject({ type: 'delete', oldLine: 2, content: 'const b = 2' })
    expect(lines[2]).toMatchObject({ type: 'add', newLine: 2, content: 'const b = 3' })
    expect(lines[3]).toMatchObject({ type: 'context', oldLine: 3, newLine: 3 })
  })

  it('detects added (new) files', () => {
    const diff = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 000..abc',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
    ].join('\n')
    const [file] = parseUnifiedDiff(diff)
    expect(file.status).toBe('added')
    expect(file.path).toBe('new.txt')
    expect(file.additions).toBe(2)
    expect(file.deletions).toBe(0)
  })

  it('detects deleted files', () => {
    const diff = [
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
    ].join('\n')
    const [file] = parseUnifiedDiff(diff)
    expect(file.status).toBe('deleted')
    expect(file.path).toBe('gone.txt')
    expect(file.deletions).toBe(1)
  })

  it('parses multiple files in one patch', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-a',
      '+A',
      'diff --git a/b.txt b/b.txt',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1 +1 @@',
      '-b',
      '+B',
    ].join('\n')
    const files = parseUnifiedDiff(diff)
    expect(files.map((f) => f.path)).toEqual(['a.txt', 'b.txt'])
  })

  it('returns [] for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
})

describe('wordDiff', () => {
  it('marks only the changed tokens', () => {
    const { old, new: neu } = wordDiff('const b = 2', 'const b = 3')
    expect(old.filter((s) => s.changed).map((s) => s.text)).toContain('2')
    expect(neu.filter((s) => s.changed).map((s) => s.text)).toContain('3')
    // Unchanged prefix is preserved losslessly.
    expect(old.map((s) => s.text).join('')).toBe('const b = 2')
    expect(neu.map((s) => s.text).join('')).toBe('const b = 3')
  })
})
