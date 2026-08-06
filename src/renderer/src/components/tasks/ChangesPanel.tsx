import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ChevronRight, RefreshCw, Loader2, FileDiff, Columns2, Rows3, WrapText, GitBranch,
  FilePlus2, FileMinus2, FilePen, FileSymlink, FolderGit2, GitPullRequest, ExternalLink,
  CheckCircle2, XCircle, Folder, FolderOpen, Files, ListTree,
} from 'lucide-react'
import { worktreeApi } from '@/lib/ipc-client'
import { parseUnifiedDiff, wordDiff, type DiffFile, type DiffHunk, type DiffLine, type WordSegment, type FileStatus } from '@/lib/diff-parser'
import { buildChangeTree, type ChangeTreeDirectory } from '@/lib/change-tree'
import { DiffStatLabel } from './DiffStatLabel'
import { cn } from '@/lib/utils'

export interface RepoChanges {
  repo: string
  files: DiffFile[]
  error?: string
  noWorktree?: boolean
  path?: string
  branch?: string
  pushed?: boolean
  prNumber?: number
  prUrl?: string
  prState?: string
  prTitle?: string
  ciStatus?: 'passing' | 'failing' | 'pending' | 'none'
}

type ViewMode = 'unified' | 'split'

enum ChangesDisplayMode {
  ALL_FILES = 'all-files',
  DIFF = 'diff'
}

// ── Row model (shared by unified + split rendering) ─────────────────────────
type Row =
  | { kind: 'context'; line: DiffLine }
  | { kind: 'del'; line: DiffLine }
  | { kind: 'add'; line: DiffLine }
  | { kind: 'pair'; del: DiffLine; add: DiffLine; delSeg: WordSegment[]; addSeg: WordSegment[] }

function alignHunk(hunk: DiffHunk): Row[] {
  const rows: Row[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []

  const flush = () => {
    const pairs = Math.min(dels.length, adds.length)
    for (let i = 0; i < pairs; i++) {
      const d = dels[i]
      const a = adds[i]
      const w = wordDiff(d.content, a.content)
      rows.push({ kind: 'pair', del: d, add: a, delSeg: w.old, addSeg: w.new })
    }
    for (let i = pairs; i < dels.length; i++) rows.push({ kind: 'del', line: dels[i] })
    for (let i = pairs; i < adds.length; i++) rows.push({ kind: 'add', line: adds[i] })
    dels = []
    adds = []
  }

  for (const line of hunk.lines) {
    if (line.type === 'delete') dels.push(line)
    else if (line.type === 'add') adds.push(line)
    else { flush(); rows.push({ kind: 'context', line }) }
  }
  flush()
  return rows
}

const STATUS_META: Record<FileStatus, { icon: typeof FilePen; className: string; label: string }> = {
  added: { icon: FilePlus2, className: 'text-success', label: 'Added' },
  deleted: { icon: FileMinus2, className: 'text-destructive', label: 'Deleted' },
  renamed: { icon: FileSymlink, className: 'text-primary', label: 'Renamed' },
  modified: { icon: FilePen, className: 'text-warning', label: 'Modified' },
}

const STATUS_BADGE: Record<FileStatus, string> = {
  added: 'bg-success/10 text-success',
  deleted: 'bg-destructive/10 text-destructive',
  renamed: 'bg-primary/10 text-primary',
  modified: 'bg-warning/10 text-warning'
}

function Segs({ segs, tone }: { segs: WordSegment[]; tone: 'add' | 'del' }) {
  return (
    <>
      {segs.map((s, i) =>
        s.changed ? (
          <span key={i} className={tone === 'add' ? 'rounded-sm bg-success/25' : 'rounded-sm bg-destructive/25'}>{s.text}</span>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </>
  )
}

const NUM = 'select-none w-10 shrink-0 pr-2 text-right text-muted-foreground/50'

function LineText({ children, wrap }: { children: ReactNode; wrap: boolean }) {
  return <span className={cn('flex-1 pl-2', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>{children}</span>
}

function UnifiedRows({ rows, wrap }: { rows: Row[]; wrap: boolean }) {
  const out: ReactNode[] = []
  rows.forEach((r, i) => {
    if (r.kind === 'context') {
      out.push(
        <div key={i} className="flex text-foreground/70">
          <span className={NUM}>{r.line.oldLine}</span><span className={NUM}>{r.line.newLine}</span>
          <LineText wrap={wrap}> {r.line.content}</LineText>
        </div>
      )
    } else if (r.kind === 'del') {
      out.push(
        <div key={i} className="flex bg-destructive/10 text-foreground">
          <span className={NUM}>{r.line.oldLine}</span><span className={NUM} /><LineText wrap={wrap}><span className="text-destructive">-</span>{r.line.content}</LineText>
        </div>
      )
    } else if (r.kind === 'add') {
      out.push(
        <div key={i} className="flex bg-success/10 text-foreground">
          <span className={NUM} /><span className={NUM}>{r.line.newLine}</span><LineText wrap={wrap}><span className="text-success">+</span>{r.line.content}</LineText>
        </div>
      )
    } else {
      out.push(
        <div key={`${i}d`} className="flex bg-destructive/10 text-foreground">
          <span className={NUM}>{r.del.oldLine}</span><span className={NUM} /><LineText wrap={wrap}><span className="text-destructive">-</span><Segs segs={r.delSeg} tone="del" /></LineText>
        </div>
      )
      out.push(
        <div key={`${i}a`} className="flex bg-success/10 text-foreground">
          <span className={NUM} /><span className={NUM}>{r.add.newLine}</span><LineText wrap={wrap}><span className="text-success">+</span><Segs segs={r.addSeg} tone="add" /></LineText>
        </div>
      )
    }
  })
  return <>{out}</>
}

function SplitSide({ line, seg, tone, wrap }: { line: DiffLine | null; seg?: WordSegment[]; tone?: 'add' | 'del'; wrap: boolean }) {
  if (!line) return <div className="flex-1 bg-muted/30" />
  const bg = tone === 'add' ? 'bg-success/10' : tone === 'del' ? 'bg-destructive/10' : ''
  const num = tone === 'add' ? line.newLine : tone === 'del' ? line.oldLine : (line.newLine ?? line.oldLine)
  return (
    <div className={cn('flex flex-1 min-w-0', bg)}>
      <span className={NUM}>{num}</span>
      <LineText wrap={wrap}>{seg ? <Segs segs={seg} tone={tone as 'add' | 'del'} /> : line.content}</LineText>
    </div>
  )
}

function SplitRows({ rows, wrap }: { rows: Row[]; wrap: boolean }) {
  return (
    <>
      {rows.map((r, i) => {
        if (r.kind === 'context') {
          return (
            <div key={i} className="flex text-foreground/70">
              <SplitSide line={r.line} wrap={wrap} />
              <div className="w-px shrink-0 bg-border" />
              <SplitSide line={r.line} wrap={wrap} />
            </div>
          )
        }
        if (r.kind === 'pair') {
          return (
            <div key={i} className="flex">
              <SplitSide line={r.del} seg={r.delSeg} tone="del" wrap={wrap} />
              <div className="w-px shrink-0 bg-border" />
              <SplitSide line={r.add} seg={r.addSeg} tone="add" wrap={wrap} />
            </div>
          )
        }
        if (r.kind === 'del') {
          return (
            <div key={i} className="flex">
              <SplitSide line={r.line} tone="del" wrap={wrap} />
              <div className="w-px shrink-0 bg-border" />
              <SplitSide line={null} wrap={wrap} />
            </div>
          )
        }
        return (
          <div key={i} className="flex">
            <SplitSide line={null} wrap={wrap} />
            <div className="w-px shrink-0 bg-border" />
            <SplitSide line={r.line} tone="add" wrap={wrap} />
          </div>
        )
      })}
    </>
  )
}

function CiBadge({ status }: { status?: RepoChanges['ciStatus'] }) {
  if (!status || status === 'none') return null
  if (status === 'passing') return <span title="Checks passing" className="inline-flex items-center text-success"><CheckCircle2 className="h-3.5 w-3.5" /></span>
  if (status === 'failing') return <span title="Checks failing" className="inline-flex items-center text-destructive"><XCircle className="h-3.5 w-3.5" /></span>
  return <span title="Checks running" className="inline-flex items-center text-warning"><Loader2 className="h-3.5 w-3.5 animate-spin" /></span>
}

const DiffBody = memo(function DiffBody({ file, viewMode, wrap }: { file: DiffFile; viewMode: ViewMode; wrap: boolean }) {
  const hunkRows = useMemo(
    () => (!file.binary ? file.hunks.map((hunk) => ({ hunk, rows: alignHunk(hunk) })) : []),
    [file]
  )

  if (file.binary) return <div className="px-4 py-6 text-center text-xs text-muted-foreground">Binary diff preview is unavailable.</div>
  return (
    <div className={cn('font-mono text-xs leading-[1.55]', wrap ? 'min-w-full' : 'min-w-max')}>
      {hunkRows.map(({ hunk, rows }, hi) => (
        <div key={hi}>
          <div className="sticky top-0 z-10 border-y border-border/40 bg-muted px-3 py-1 text-[11px] text-muted-foreground">{hunk.header}</div>
          {viewMode === 'split' ? <SplitRows rows={rows} wrap={wrap} /> : <UnifiedRows rows={rows} wrap={wrap} />}
        </div>
      ))}
      {file.hunks.length === 0 && <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">No textual changes.</div>}
    </div>
  )
})

const FileBlock = memo(function FileBlock({ file, viewMode, wrap }: { file: DiffFile; viewMode: ViewMode; wrap: boolean }) {
  // Files start collapsed — the panel opens as a clean changed-files overview;
  // click a file to expand its diff.
  const [open, setOpen] = useState(false)
  const meta = STATUS_META[file.status]
  const Icon = meta.icon

  return (
    <div className="border-b border-border/60">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors sticky top-0 z-10 bg-card"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Icon className={cn('h-3.5 w-3.5 shrink-0', meta.className)} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={file.path}>
          {file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.newPath}` : file.path}
        </span>
        {!file.binary && <DiffStatLabel additions={file.additions} deletions={file.deletions} className="text-[11px]" />}
        {file.binary && <span className="text-[11px] text-muted-foreground">binary</span>}
      </button>
      {open && !file.binary && (
        <div className="overflow-x-auto"><DiffBody file={file} viewMode={viewMode} wrap={wrap} /></div>
      )}
    </div>
  )
})

function TreeFile({ repo, file, selected, depth, onSelect }: {
  repo: string
  file: DiffFile
  selected: boolean
  depth: number
  onSelect: (repo: string, file: DiffFile) => void
}) {
  const meta = STATUS_META[file.status]
  const Icon = meta.icon
  const name = file.path.replace(/\\/g, '/').split('/').at(-1) || file.path
  return (
    <button
      type="button"
      onClick={() => onSelect(repo, file)}
      title={`${meta.label}: ${file.path}`}
      aria-pressed={selected}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left transition-colors',
        selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      )}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', meta.className)} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{name}</span>
      {!file.binary && <DiffStatLabel additions={file.additions} deletions={file.deletions} className="text-[10px]" />}
      <span className={cn('shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold', STATUS_BADGE[file.status])}>{file.status[0].toUpperCase()}</span>
    </button>
  )
}

function TreeDirectory({ repo, directory, selectedKey, depth, onSelect }: {
  repo: string
  directory: ChangeTreeDirectory
  selectedKey: string | null
  depth: number
  onSelect: (repo: string, file: DiffFile) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
        {open ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />}
        <span className="min-w-0 flex-1 truncate text-xs">{directory.name}</span>
        <span className="text-[10px] text-muted-foreground/70">{directory.stats.files}</span>
      </button>
      {open && (
        <div>
          {directory.directories.map((child) => (
            <TreeDirectory key={child.path} repo={repo} directory={child} selectedKey={selectedKey} depth={depth + 1} onSelect={onSelect} />
          ))}
          {directory.files.map((file) => (
            <TreeFile key={file.path} repo={repo} file={file} selected={selectedKey === `${repo}:${file.path}`} depth={depth + 1} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

function RepoTree({ repo, selectedKey, onSelect }: {
  repo: RepoChanges
  selectedKey: string | null
  onSelect: (repo: string, file: DiffFile) => void
}) {
  const [open, setOpen] = useState(true)
  const tree = useMemo(() => buildChangeTree(repo.files), [repo.files])
  return (
    <div className="border-b border-border/50 py-1 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/50"
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{repo.repo}</span>
        <span className="text-[10px] text-muted-foreground">{tree.stats.files}</span>
      </button>
      {open && (
        <div>
          {tree.directories.map((directory) => (
            <TreeDirectory key={directory.path} repo={repo.repo} directory={directory} selectedKey={selectedKey} depth={0} onSelect={onSelect} />
          ))}
          {tree.files.map((file) => (
            <TreeFile key={file.path} repo={repo.repo} file={file} selected={selectedKey === `${repo.repo}:${file.path}`} depth={0} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

function SelectedFileDiff({ repo, file, viewMode, wrap }: { repo: RepoChanges; file: DiffFile; viewMode: ViewMode; wrap: boolean }) {
  const meta = STATUS_META[file.status]
  const Icon = meta.icon
  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-card px-3 py-2">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', meta.className)} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-foreground" title={file.path}>{file.path}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{repo.repo}</span><span>·</span><span className={meta.className}>{meta.label}</span>
            {repo.branch && <><span>·</span><span className="truncate font-mono">{repo.branch}</span></>}
          </div>
        </div>
        {!file.binary && <DiffStatLabel additions={file.additions} deletions={file.deletions} className="text-[11px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto"><DiffBody file={file} viewMode={viewMode} wrap={wrap} /></div>
    </div>
  )
}

function AllFilesView({ repos, selectedKey, onSelect, viewMode, wrap }: {
  repos: RepoChanges[]
  selectedKey: string | null
  onSelect: (repo: string, file: DiffFile) => void
  viewMode: ViewMode
  wrap: boolean
}) {
  const selected = useMemo(() => {
    if (!selectedKey) return null
    for (const repo of repos) {
      const file = repo.files.find((candidate) => `${repo.repo}:${candidate.path}` === selectedKey)
      if (file) return { repo, file }
    }
    return null
  }, [repos, selectedKey])

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[34%] min-w-[220px] max-w-[340px] shrink-0 overflow-y-auto border-r border-border/60 bg-card p-1.5">
        {repos.filter((repo) => repo.files.length > 0).map((repo) => <RepoTree key={repo.repo} repo={repo} selectedKey={selectedKey} onSelect={onSelect} />)}
      </aside>
      <main className="min-w-0 flex-1">
        {selected
          ? <SelectedFileDiff repo={selected.repo} file={selected.file} viewMode={viewMode} wrap={wrap} />
          : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a changed file to review its diff.</div>}
      </main>
    </div>
  )
}

const RepoBlock = memo(function RepoBlock({ repo, viewMode, wrap }: { repo: RepoChanges; viewMode: ViewMode; wrap: boolean }) {
  const repoSummary = useMemo(
    () => repo.files.reduce(
      (summary, file) => ({
        additions: summary.additions + file.additions,
        deletions: summary.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 }
    ),
    [repo.files]
  )

  return (
    <div>
      {/* Per-repo group header: branch (no PR) — or PR title + link + CI status */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 bg-card px-3 py-2 text-[11px] shadow-sm">
        <span className="font-medium text-foreground shrink-0">{repo.repo}</span>
        {repo.prUrl ? (
          <>
            <button
              onClick={() => window.electronAPI?.shell?.openExternal?.(repo.prUrl!)}
              className="inline-flex min-w-0 items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-primary hover:bg-primary/15 hover:underline cursor-pointer"
              title={`${repo.prTitle ?? ''} (${repo.prUrl})`}
            >
              <GitPullRequest className="h-3 w-3 shrink-0" />
              <span className="truncate max-w-[240px]">{repo.prTitle || `Pull request #${repo.prNumber}`}</span>
              <span className="shrink-0 text-muted-foreground/70">#{repo.prNumber}</span>
              <ExternalLink className="h-2.5 w-2.5 shrink-0" />
            </button>
            <CiBadge status={repo.ciStatus} />
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <GitBranch className="h-3 w-3 shrink-0" />
            <span className="font-mono text-[10px] text-foreground/80">{repo.branch ?? 'detached HEAD'}</span>
            <span className="text-muted-foreground/60">{repo.pushed ? '· no PR yet' : '· not pushed'}</span>
          </span>
        )}
        <DiffStatLabel additions={repoSummary.additions} deletions={repoSummary.deletions} className="ml-auto text-[10px]" />
      </div>
      {repo.files.map((file, i) => (
        <FileBlock key={`${repo.repo}:${file.path}:${i}`} file={file} viewMode={viewMode} wrap={wrap} />
      ))}
    </div>
  )
})

export interface ChangesSummary { files: number; additions: number; deletions: number }

export function ChangesPanel({ taskId, repos, className, onSummary, onPullRequests }: {
  taskId: string
  repos: string[]
  className?: string
  onSummary?: (s: ChangesSummary) => void
  onPullRequests?: (pullRequests: Array<Pick<RepoChanges, 'repo' | 'prNumber' | 'prUrl' | 'prState' | 'prTitle' | 'ciStatus'>>) => void
}) {
  const [data, setData] = useState<RepoChanges[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>(() => (localStorage.getItem('diff-view-mode') as ViewMode) || 'unified')
  const [wrap, setWrap] = useState<boolean>(() => localStorage.getItem('diff-wrap') === '1')
  const [displayMode, setDisplayMode] = useState<ChangesDisplayMode>(() => {
    const saved = localStorage.getItem('changes-display-mode')
    return saved === ChangesDisplayMode.DIFF ? ChangesDisplayMode.DIFF : ChangesDisplayMode.ALL_FILES
  })
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null)

  // Key the fetch on a stable string so unrelated re-renders (new array identity)
  // don't re-run git diff.
  const reposKey = repos.join('|')
  const load = useCallback(async () => {
    const list = reposKey ? reposKey.split('|') : []
    if (!list.length) { setData([]); onSummary?.({ files: 0, additions: 0, deletions: 0 }); return }
    setLoading(true)
    try {
      const res = await worktreeApi.changes(taskId, list.map((fullName) => ({ fullName })))
      const parsed = res.map((r) => ({
        repo: r.repo, error: r.error, noWorktree: r.noWorktree, path: r.path,
        branch: r.branch, pushed: r.pushed, prNumber: r.prNumber, prUrl: r.prUrl, prState: r.prState,
        prTitle: r.prTitle, ciStatus: r.ciStatus,
        files: r.diff ? parseUnifiedDiff(r.diff) : [],
      }))
      setData(parsed)
      onPullRequests?.(parsed.filter((repo) => repo.prUrl).map((repo) => ({
        repo: repo.repo,
        prNumber: repo.prNumber,
        prUrl: repo.prUrl,
        prState: repo.prState,
        prTitle: repo.prTitle,
        ciStatus: repo.ciStatus
      })))
      let a = 0, d = 0, f = 0
      for (const repo of parsed) for (const file of repo.files) { a += file.additions; d += file.deletions; f++ }
      onSummary?.({ files: f, additions: a, deletions: d })
    } catch (e) {
      setData([{ repo: '', files: [], error: (e as Error).message }])
      onSummary?.({ files: 0, additions: 0, deletions: 0 })
    } finally {
      setLoading(false)
    }
  }, [taskId, reposKey, onSummary, onPullRequests])

  useEffect(() => { void load() }, [load])

  const setMode = (m: ViewMode) => { setViewMode(m); localStorage.setItem('diff-view-mode', m) }
  const setChangesMode = (mode: ChangesDisplayMode) => {
    setDisplayMode(mode)
    localStorage.setItem('changes-display-mode', mode)
  }
  const toggleWrap = () => setWrap((w) => { localStorage.setItem('diff-wrap', w ? '0' : '1'); return !w })

  const totals = useMemo(() => {
    let a = 0, d = 0, f = 0
    for (const repo of data ?? []) for (const file of repo.files) { a += file.additions; d += file.deletions; f++ }
    return { additions: a, deletions: d, files: f }
  }, [data])

  const hasChanges = (data ?? []).some((r) => r.files.length > 0)
  const availableFileKeys = useMemo(
    () => (data ?? []).flatMap((repo) => repo.files.map((file) => `${repo.repo}:${file.path}`)),
    [data]
  )

  useEffect(() => {
    if (availableFileKeys.length === 0) {
      setSelectedFileKey(null)
      return
    }
    setSelectedFileKey((current) => current && availableFileKeys.includes(current) ? current : availableFileKeys[0])
  }, [availableFileKeys])

  const selectFile = useCallback((repo: string, file: DiffFile) => {
    setSelectedFileKey(`${repo}:${file.path}`)
  }, [])

  return (
    <div className={cn('flex h-full flex-col bg-card', className)}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 flex-shrink-0">
        <FileDiff className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">Changes</span>
        {totals.files > 0 && (
          <>
            <span className="text-xs text-muted-foreground">· {totals.files} file{totals.files !== 1 ? 's' : ''}</span>
            <DiffStatLabel additions={totals.additions} deletions={totals.deletions} className="text-[11px]" />
          </>
        )}
        <div className="flex-1" />
        <div className="flex items-center rounded-lg border border-border/60 bg-muted/40 p-0.5">
          <button
            type="button"
            onClick={() => setChangesMode(ChangesDisplayMode.ALL_FILES)}
            title="Browse all changed files"
            className={cn('flex h-6 items-center gap-1 rounded-md px-2 text-[11px] transition-colors', displayMode === ChangesDisplayMode.ALL_FILES ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
          >
            <ListTree className="h-3.5 w-3.5" />All files
          </button>
          <button
            type="button"
            onClick={() => setChangesMode(ChangesDisplayMode.DIFF)}
            title="Review the continuous diff"
            className={cn('flex h-6 items-center gap-1 rounded-md px-2 text-[11px] transition-colors', displayMode === ChangesDisplayMode.DIFF ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
          >
            <Files className="h-3.5 w-3.5" />Diff
          </button>
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5">
          <button onClick={() => setMode('unified')} title="Unified" className={cn('grid h-6 w-6 place-items-center rounded-md transition-colors', viewMode === 'unified' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}><Rows3 className="h-3.5 w-3.5" /></button>
          <button onClick={() => setMode('split')} title="Split" className={cn('grid h-6 w-6 place-items-center rounded-md transition-colors', viewMode === 'split' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}><Columns2 className="h-3.5 w-3.5" /></button>
        </div>
        <button onClick={toggleWrap} title="Toggle word wrap" className={cn('grid h-7 w-7 place-items-center rounded-lg transition-colors', wrap ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}><WrapText className="h-3.5 w-3.5" /></button>
        <button onClick={() => void load()} disabled={loading} title="Refresh" className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        {loading && !data && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Computing diff…</div>
        )}
        {!loading && !repos.length && (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">This task has no linked repositories.</div>
        )}
        {data && repos.length > 0 && !hasChanges && !loading && !data.some((r) => r.error) && (
          data.length > 0 && data.every((r) => r.noWorktree) ? (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center text-sm text-muted-foreground">
              <FolderGit2 className="h-6 w-6 opacity-40" />
              This task&apos;s worktree isn&apos;t set up yet.
              <span className="text-xs text-muted-foreground/70">Start the agent on this task to create it.</span>
              {data.filter((r) => r.path).map((r) => (
                <code key={r.repo} className="mt-1 max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground/60">{r.path}</code>
              ))}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
              <FileDiff className="h-6 w-6 opacity-40" />
              No changes in the task worktree{repos.length > 1 ? 's' : ''} yet.
            </div>
          )
        )}
        {data && hasChanges && displayMode === ChangesDisplayMode.ALL_FILES && (
          <AllFilesView repos={data} selectedKey={selectedFileKey} onSelect={selectFile} viewMode={viewMode} wrap={wrap} />
        )}
        {data && hasChanges && displayMode === ChangesDisplayMode.DIFF && (
          <div className="h-full overflow-y-auto">
            {data.map((repo) => {
              if (repo.error) return <div key={repo.repo} className="px-3 py-2 text-xs text-destructive">{repo.repo}: {repo.error}</div>
              if (repo.files.length === 0) return null
              return <RepoBlock key={repo.repo} repo={repo} viewMode={viewMode} wrap={wrap} />
            })}
          </div>
        )}
      </div>
    </div>
  )
}
