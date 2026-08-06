import { ArtifactType, type Artifact } from '../stores/artifact-store'

function ArtifactIcon({ type }: { type: ArtifactType }) {
  if (type === ArtifactType.IMAGE) {
    return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
  }
  if (type === ArtifactType.HTML) {
    return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m8 9-3 3 3 3"/><path d="m16 9 3 3-3 3"/><path d="m14 5-4 14"/></svg>
  }
  if (type === ArtifactType.PR) {
    return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v12"/><path d="M18 15V6"/><path d="m15 9 3-3 3 3"/></svg>
  }
  return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
}

export function ArtifactCard({ artifact, onOpen, compact = false }: { artifact: Artifact; onOpen: () => void; compact?: boolean }) {
  const typeLabel = artifact.type === ArtifactType.PR
    ? 'Pull request'
    : artifact.type.charAt(0).toUpperCase() + artifact.type.slice(1)

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full flex items-center gap-3 rounded-md border border-border/50 bg-card px-3 py-2.5 text-left active:opacity-70"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <ArtifactIcon type={artifact.type} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{artifact.title}</span>
        {!compact && <span className="block text-[11px] text-muted-foreground">{typeLabel} · Tap to open</span>}
      </span>
      <svg className="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
    </button>
  )
}
