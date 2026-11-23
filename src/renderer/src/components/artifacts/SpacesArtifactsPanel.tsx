import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Cloud, CloudOff, File, FileCode2, FileImage, FileText, Loader2, RefreshCw } from 'lucide-react'
import { type Artifact } from '@shared/artifacts'
import { isArtifactEditable, type SpacesArtifactContent, type SpacesArtifactSummary } from '@shared/enterprise-runners'
import { enterpriseRunnersApi } from '@/lib/ipc-client'
import { useSpacesArtifactStore } from '@/stores/spaces-artifact-store'
import { Markdown } from '@/components/ui/Markdown'
import { cn } from '@/lib/utils'
import { ARTIFACT_ICONS } from './artifact-icons'
import { ArtifactHtmlFrame } from './viewers/ArtifactHtmlFrame'

type Filter = 'all' | 'local' | 'spaces'

const SPACES_ICONS = { markdown: FileText, html: FileCode2, image: FileImage, file: File } as const

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function SourceBadge({ source }: { source: 'local' | 'spaces' }) {
  return source === 'spaces'
    ? <span data-testid="source-badge-spaces" className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-500"><Cloud className="h-2.5 w-2.5" />Spaces</span>
    : <span data-testid="source-badge-local" className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Local</span>
}

const EDIT_NOTE = 'Editing server artifacts isn’t part of v1 — open in Spaces to change it. Local artifacts stay editable.'

/** Combined Local + Spaces artifact list; Spaces rows open a read-only viewer. */
export function SpacesArtifactsPanel({ taskId, localArtifacts, onOpenLocal }: {
  taskId: string
  localArtifacts: Artifact[]
  onOpenLocal: (artifactId: string) => void
}) {
  const entry = useSpacesArtifactStore((s) => s.byTask[taskId])
  const load = useSpacesArtifactStore((s) => s.load)
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<SpacesArtifactSummary | null>(null)

  useEffect(() => { void load(taskId) }, [taskId, load])

  const spaces = entry?.artifacts ?? []
  const loading = !entry || entry.status === 'loading'
  const showLocal = filter !== 'spaces'
  const showSpaces = filter !== 'local'
  const empty = !loading && localArtifacts.length === 0 && spaces.length === 0

  const syncedAt = useMemo(() => (entry?.syncedAt ? new Date(entry.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null), [entry?.syncedAt])

  if (selected) return <SpacesArtifactViewer taskId={taskId} artifact={selected} onBack={() => setSelected(null)} />

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="spaces-artifacts-panel">
      <div className="flex items-center gap-1 border-b border-border/50 px-3 py-2">
        {(['all', 'local', 'spaces'] as const).map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={cn('rounded-md px-2 py-1 text-xs capitalize', filter === f ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50')}>{f}</button>
        ))}
        <button type="button" aria-label="Refresh Spaces artifacts" onClick={() => void load(taskId, true)} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent">
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      {entry?.status === 'offline' && (
        <div role="status" data-testid="spaces-artifacts-offline" className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          <CloudOff className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span><strong>Offline</strong> — showing cached Spaces artifacts (read-only).{syncedAt ? ` Last synced ${syncedAt}.` : ''} Local artifacts stay editable.</span>
        </div>
      )}
      {entry?.status === 'signed-out' && <div role="status" className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">Sign in to Peakflo Enterprise to see Spaces artifacts.</div>}
      {entry?.status === 'error' && <div role="alert" className="border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">Couldn’t load Spaces artifacts{entry.error ? `: ${entry.error}` : ''}</div>}
      {loading && showSpaces && (
        <div role="status" data-testid="spaces-artifacts-loading" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Fetching artifacts from Spaces…</div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <div data-testid="spaces-artifacts-empty" className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-xs text-muted-foreground">
            <strong className="text-sm text-foreground">No artifacts yet</strong>
            Files the runner produces appear here with a “Spaces” label.
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {showLocal && localArtifacts.map((a) => {
              const Icon = ARTIFACT_ICONS[a.type] ?? File
              return (
                <li key={a.id}>
                  <button type="button" onClick={() => onOpenLocal(a.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs">{a.title}</span>
                    <SourceBadge source="local" />
                    <span className="text-[10px] text-muted-foreground">{isArtifactEditable('local') ? 'editable' : 'read-only'}</span>
                  </button>
                </li>
              )
            })}
            {showSpaces && spaces.map((a) => {
              const Icon = SPACES_ICONS[a.kind]
              return (
                <li key={a.id}>
                  <button type="button" onClick={() => setSelected(a)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs">{a.title}</span>
                    <SourceBadge source="spaces" />
                    {a.availability === 'cached' && <span className="text-[10px] text-muted-foreground">cached</span>}
                    {a.availability === 'not-cached' && <span className="text-[10px] text-muted-foreground">not cached</span>}
                    <span className="text-[10px] text-muted-foreground">{formatSize(a.sizeBytes)} · read-only</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

const noFile = async (): Promise<null> => null

/** Read-only viewer for one Spaces artifact. */
export function SpacesArtifactViewer({ taskId, artifact, onBack }: { taskId: string; artifact: SpacesArtifactSummary; onBack: () => void }) {
  const [content, setContent] = useState<SpacesArtifactContent | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)
    enterpriseRunnersApi.readSpacesArtifact(taskId, artifact.id)
      .then((c) => { if (!cancelled) setContent(c) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [taskId, artifact.id])

  const webUrl = content?.webUrl ?? artifact.webUrl
  const text = content && content.encoding === 'utf8' ? content.content : null
  const open = (): void => { if (webUrl) void window.electronAPI.shell.openExternal(webUrl) }

  let body: React.ReactNode
  if (error) body = <div role="alert" className="p-6 text-sm text-red-400">{error}</div>
  else if (!content) body = <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading artifact…</div>
  else if (content.availability === 'not-cached' || text === null && artifact.kind !== 'image' && artifact.kind !== 'file') {
    body = <div className="p-6 text-sm text-muted-foreground">Not cached — connect to Spaces to view this artifact, or open it in Spaces.</div>
  } else if (artifact.kind === 'markdown') body = <div className="h-full overflow-y-auto px-6 py-5"><Markdown size="sm">{text ?? ''}</Markdown></div>
  else if (artifact.kind === 'html') {
    body = (
      <div className="h-full">
        <ArtifactHtmlFrame html={text ?? ''} title={artifact.title} taskId={taskId} path="index.html" files={[]} readFile={noFile} />
      </div>
    )
  } else if (artifact.kind === 'image' && content.encoding === 'base64' && content.content) {
    body = <div className="flex h-full items-center justify-center overflow-auto p-4"><img alt={artifact.title} src={`data:${content.mimeType};base64,${content.content}`} className="max-h-full max-w-full" /></div>
  } else {
    body = (
      <div className="space-y-1 p-6 text-sm">
        <div className="font-medium">{artifact.filename ?? artifact.title}</div>
        <div className="text-xs text-muted-foreground">{formatSize(content.sizeBytes)} · {content.mimeType}</div>
        <div className="text-xs text-muted-foreground">Files are downloaded from Spaces.</div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="spaces-artifact-viewer">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <button type="button" aria-label="Back to artifacts" onClick={onBack} className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent"><ArrowLeft className="h-3.5 w-3.5" /></button>
        <span className="min-w-0 truncate text-xs font-medium">{artifact.title}</span>
        <SourceBadge source="spaces" />
        <span className="text-[10px] text-muted-foreground">read-only</span>
        {content?.availability === 'cached' && <span className="text-[10px] text-muted-foreground">cached</span>}
        <button type="button" onClick={open} disabled={!webUrl} className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-40">Open in Spaces <ArrowUpRight className="h-3 w-3" /></button>
      </div>
      <div className="min-h-0 flex-1">{body}</div>
      <div className="border-t border-border/40 px-3 py-1.5 text-[10px] text-muted-foreground">{EDIT_NOTE}</div>
    </div>
  )
}
