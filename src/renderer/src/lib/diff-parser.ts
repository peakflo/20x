/**
 * Unified-diff parser + word-level diff helper.
 *
 * Turns a raw `git diff` patch into a structured model the Changes viewer can
 * render (files → hunks → lines) with per-file add/delete counts and status.
 * Standard unified-diff parsing; approach modelled on common diff renderers.
 */

export type DiffLineType = 'context' | 'add' | 'delete'
export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed'

export interface DiffLine {
  type: DiffLineType
  oldLine: number | null
  newLine: number | null
  content: string // line text without the leading +/-/space marker
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  oldPath: string | null
  newPath: string | null
  /** Display path (new path, or old path for deletions). */
  path: string
  status: FileStatus
  additions: number
  deletions: number
  binary: boolean
  hunks: DiffHunk[]
}

function stripPrefix(raw: string): string | null {
  const p = raw.trim()
  if (p === '/dev/null') return null
  return p.replace(/^[ab]\//, '')
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  const finishFile = () => {
    if (file) {
      if (file.newPath === null && file.oldPath !== null) file.status = 'deleted'
      else if (file.oldPath === null && file.newPath !== null && file.status !== 'renamed') file.status = 'added'
      file.path = file.newPath ?? file.oldPath ?? file.path
      files.push(file)
    }
    file = null
    hunk = null
  }

  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      finishFile()
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
      file = {
        oldPath: m ? m[1] : null,
        newPath: m ? m[2] : null,
        path: m ? m[2] : '',
        status: 'modified',
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      }
      continue
    }
    if (!file) continue

    if (line.startsWith('new file mode')) { file.oldPath = null; file.status = 'added'; continue }
    if (line.startsWith('deleted file mode')) { file.newPath = null; file.status = 'deleted'; continue }
    if (line.startsWith('rename from ')) { file.oldPath = line.slice(12); file.status = 'renamed'; continue }
    if (line.startsWith('rename to ')) { file.newPath = line.slice(10); file.status = 'renamed'; continue }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) { file.binary = true; continue }
    if (line.startsWith('--- ')) { const p = stripPrefix(line.slice(4)); file.oldPath = p; continue }
    if (line.startsWith('+++ ')) { const p = stripPrefix(line.slice(4)); file.newPath = p; continue }

    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      oldLine = m ? Number(m[1]) : 0
      newLine = m ? Number(m[2]) : 0
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue

    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', oldLine: null, newLine, content: line.slice(1) })
      newLine++
      file.additions++
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'delete', oldLine, newLine: null, content: line.slice(1) })
      oldLine++
      file.deletions++
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — ignore
    } else {
      // context (leading space, or empty line inside a hunk)
      hunk.lines.push({ type: 'context', oldLine, newLine, content: line.slice(1) })
      oldLine++
      newLine++
    }
  }

  finishFile()
  return files
}

// ── Word-level (intra-line) diff ─────────────────────────────────────────────

export interface WordSegment {
  text: string
  changed: boolean
}

function tokenize(s: string): string[] {
  // Split on word boundaries but keep the delimiters so joins are lossless.
  return s.match(/(\w+|\s+|[^\w\s])/g) ?? []
}

/**
 * Longest-common-subsequence word diff between two strings. Returns the segments
 * for each side, marking tokens that changed. Cheap enough for line-length input.
 */
export function wordDiff(oldStr: string, newStr: string): { old: WordSegment[]; new: WordSegment[] } {
  const a = tokenize(oldStr)
  const b = tokenize(newStr)
  const n = a.length
  const m = b.length

  // Guard against pathologically long lines.
  if (n * m > 40000) {
    return {
      old: [{ text: oldStr, changed: true }],
      new: [{ text: newStr, changed: true }],
    }
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const oldSeg: WordSegment[] = []
  const newSeg: WordSegment[] = []
  const push = (seg: WordSegment[], text: string, changed: boolean) => {
    const last = seg[seg.length - 1]
    if (last && last.changed === changed) last.text += text
    else seg.push({ text, changed })
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(oldSeg, a[i], false)
      push(newSeg, b[j], false)
      i++; j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(oldSeg, a[i], true)
      i++
    } else {
      push(newSeg, b[j], true)
      j++
    }
  }
  while (i < n) { push(oldSeg, a[i], true); i++ }
  while (j < m) { push(newSeg, b[j], true); j++ }

  return { old: oldSeg, new: newSeg }
}
