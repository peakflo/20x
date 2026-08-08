import { useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '@/components/ui/Markdown'
import {
  ArtifactContentKind,
  PullRequestCheckState,
  PullRequestReviewDecision,
  PullRequestState,
  type ArtifactContent,
  type PullRequestDetails
} from '@shared/artifacts'
import { api } from '../api/client'
import { ArtifactType, useArtifactStore } from '../stores/artifact-store'
import type { Route } from '../App'

const ACTIVE_ARTIFACT_REFRESH_INTERVAL_MS = 30_000

function hardenHtml(source: string): string {
  const policy = "default-src 'none'; connect-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  const guard = `<meta http-equiv="Content-Security-Policy" content="${policy}"><base href="about:blank"><script>window.open=function(){return null};</script>`
  return /<head[\s>]/i.test(source)
    ? source.replace(/<head([^>]*)>/i, `<head$1>${guard}`)
    : `<!doctype html><html><head>${guard}</head><body>${source}</body></html>`
}

function safeExternalUrl(value?: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function safeImageUrl(value?: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

export function ArtifactViewerPage({ taskId, artifactId, onNavigate }: { taskId: string; artifactId: string; onNavigate: (route: Route) => void }) {
  const artifact = useArtifactStore((state) => state.artifactsByTask.get(taskId)?.find((item) => item.id === artifactId))
  const hydrate = useArtifactStore((state) => state.hydrate)
  const [content, setContent] = useState<ArtifactContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pullRequest, setPullRequest] = useState<PullRequestDetails | null>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const settledArtifactRef = useRef<string | null>(null)

  useEffect(() => {
    if (!artifact) void hydrate(taskId)
  }, [artifact, hydrate, taskId])

  useEffect(() => {
    if (!artifact) return
    const interval = window.setInterval(() => {
      setRefreshTrigger((trigger) => trigger + 1)
    }, ACTIVE_ARTIFACT_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [artifact?.id])

  useEffect(() => {
    if (!artifact?.path || artifact.type === ArtifactType.PR) {
      if (artifact && artifact.type !== ArtifactType.PR) {
        settledArtifactRef.current = artifact.id
        setLoading(false)
      }
      return
    }
    let cancelled = false
    const initialLoad = settledArtifactRef.current !== artifact.id
    if (initialLoad) {
      setLoading(true)
      setError(null)
    }
    void api.artifacts.content(taskId, artifact.path).then((result) => {
      if (!cancelled) {
        setContent(result)
        setError(null)
      }
    }).catch((reason: unknown) => {
      if (!cancelled && initialLoad) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) {
        settledArtifactRef.current = artifact.id
        if (initialLoad) setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [artifact?.path, artifact?.reloadTrigger, artifact?.type, refreshTrigger, taskId])

  useEffect(() => {
    if (artifact?.type !== ArtifactType.PR || !artifact.url) return
    let cancelled = false
    const initialLoad = settledArtifactRef.current !== artifact.id
    if (initialLoad) {
      setLoading(true)
      setError(null)
    }
    void api.github.pullRequest(artifact.url).then((result) => {
      if (!cancelled) {
        setPullRequest(result)
        setError(null)
      }
    }).catch((reason: unknown) => {
      if (!cancelled && initialLoad) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) {
        settledArtifactRef.current = artifact.id
        if (initialLoad) setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [artifact?.reloadTrigger, artifact?.type, artifact?.url, refreshTrigger])

  const imageUrl = useMemo(() => {
    if (artifact?.type !== ArtifactType.IMAGE) return null
    const remoteUrl = safeImageUrl(artifact.url)
    if (remoteUrl) return remoteUrl
    return content?.kind === ArtifactContentKind.DATA_URL ? content.content : null
  }, [artifact?.type, artifact?.url, content])
  const externalUrl = safeExternalUrl(artifact?.url)

  const handleBack = () => {
    if (history.length > 1) history.back()
    else onNavigate({ page: 'detail', taskId })
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-3">
        <button type="button" onClick={handleBack} className="rounded-md p-1.5 active:opacity-60" aria-label="Back to task">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{artifact?.title || 'Artifact'}</span>
        {artifact?.type === ArtifactType.PR && externalUrl && (
          <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary">Open ↗</a>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-background">
        {loading && <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading artifact…</div>}
        {!loading && error && <div className="flex h-full items-center justify-center p-6 text-center text-sm text-red-400">{error}</div>}
        {!loading && !error && !artifact && <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Artifact not found</div>}
        {!loading && !error && artifact?.type === ArtifactType.MARKDOWN && content && (
          <div className="mx-auto max-w-3xl p-5"><Markdown size="sm">{content.content}</Markdown></div>
        )}
        {!loading && !error && artifact?.type === ArtifactType.IMAGE && imageUrl && (
          <div className="flex min-h-full items-center justify-center p-4"><img key={artifact.reloadTrigger} src={imageUrl} alt={artifact.title} className="max-h-full max-w-full object-contain" /></div>
        )}
        {!loading && !error && artifact?.type === ArtifactType.HTML && content && (
          <iframe
            key={artifact.reloadTrigger}
            title={artifact.title}
            srcDoc={hardenHtml(content.content)}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="h-full w-full border-0 bg-white"
          />
        )}
        {!loading && !error && artifact?.type === ArtifactType.FILE && content && (
          <pre className="min-h-full whitespace-pre-wrap break-words p-4 font-mono text-xs text-foreground/80">{content.kind === ArtifactContentKind.TEXT ? content.content : 'Binary file preview is not available.'}</pre>
        )}
        {!loading && !error && artifact?.type === ArtifactType.PR && pullRequest && (
          <MobilePullRequestDetails details={pullRequest} />
        )}
      </div>
    </div>
  )
}

function MobilePullRequestDetails({ details }: { details: PullRequestDetails }) {
  const stateLabel = details.isDraft
    ? 'Draft'
    : details.state === PullRequestState.MERGED
      ? 'Merged'
      : details.state === PullRequestState.CLOSED ? 'Closed' : 'Open'
  const stateClass = details.state === PullRequestState.OPEN && !details.isDraft
    ? 'bg-emerald-500/10 text-emerald-500'
    : details.state === PullRequestState.MERGED
      ? 'bg-purple-500/10 text-purple-500'
      : 'bg-muted text-muted-foreground'
  const reviewLabel = details.reviewDecision === PullRequestReviewDecision.APPROVED
    ? 'Approved'
    : details.reviewDecision === PullRequestReviewDecision.CHANGES_REQUESTED
      ? 'Changes requested'
      : details.reviewDecision === PullRequestReviewDecision.REVIEW_REQUIRED ? 'Review required' : 'No review decision'
  const passedChecks = details.checks.filter((check) => check.state === PullRequestCheckState.PASSED).length
  const failedChecks = details.checks.filter((check) => check.state === PullRequestCheckState.FAILED).length
  const pendingChecks = details.checks.filter((check) => check.state === PullRequestCheckState.PENDING).length

  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
        <div className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{details.repository} #{details.number}</span>
            <span className={`rounded-full px-2 py-0.5 font-medium ${stateClass}`}>{stateLabel}</span>
          </div>
          <h2 className="mt-1 text-base font-semibold leading-snug">{details.title}</h2>
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            {details.author.avatarUrl && <img src={details.author.avatarUrl} alt="" className="h-4 w-4 rounded-full" />}
            <span>{details.author.login}</span>
            <span className="truncate font-mono">{details.headRefName} → {details.baseRefName}</span>
          </div>
          {details.body && <p className="mt-3 line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{details.body}</p>}
        </div>
        <div className="grid grid-cols-2 border-y border-border/50 text-center text-xs">
          <div className="border-b border-r border-border/50 p-3"><div className="font-semibold">{details.changedFiles}</div><div className="text-muted-foreground">files changed</div></div>
          <div className="border-b border-border/50 p-3"><div className="font-semibold"><span className="text-emerald-500">+{details.additions}</span> <span className="text-red-500">−{details.deletions}</span></div><div className="text-muted-foreground">lines</div></div>
          <div className="border-r border-border/50 p-3"><div className="font-semibold">{details.reviewsCount}</div><div className="text-muted-foreground">reviews</div></div>
          <div className="p-3"><div className="font-semibold">{details.commentsCount}</div><div className="text-muted-foreground">comments</div></div>
        </div>
        <div className="space-y-4 p-4">
          <section>
            <h3 className="text-xs font-medium">Review</h3>
            <div className="mt-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5 text-xs">{reviewLabel}</div>
          </section>
          <section>
            <h3 className="text-xs font-medium">Checks</h3>
            <div className="mt-2 overflow-hidden rounded-lg border border-border/50 bg-muted/30">
              {details.checks.length === 0 ? <div className="px-3 py-2.5 text-xs text-muted-foreground">No checks reported</div> : (
                <>
                  <div className="flex gap-3 border-b border-border/50 px-3 py-2 text-[11px]">
                    <span className="text-emerald-500">{passedChecks} passed</span>
                    {failedChecks > 0 && <span className="text-red-500">{failedChecks} failed</span>}
                    {pendingChecks > 0 && <span className="text-amber-500">{pendingChecks} pending</span>}
                  </div>
                  {details.checks.slice(0, 5).map((check, index) => (
                    <div key={`${check.name}:${index}`} className="flex items-center gap-2 border-b border-border/40 px-3 py-2 text-xs last:border-b-0">
                      <span className={check.state === PullRequestCheckState.PASSED ? 'text-emerald-500' : check.state === PullRequestCheckState.FAILED ? 'text-red-500' : 'text-amber-500'}>●</span>
                      <span className="min-w-0 flex-1 truncate">{check.name}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
