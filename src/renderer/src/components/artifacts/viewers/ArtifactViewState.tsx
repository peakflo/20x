import { AlertTriangle, Loader2 } from 'lucide-react'

export function ArtifactViewState({ loading, error, missing, children }: { loading: boolean; error: string | null; missing: boolean; children: React.ReactNode }) {
  if (loading) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading artifact…</div>
  if (error) return <div className="flex h-full items-center justify-center px-6 text-sm text-destructive"><AlertTriangle className="mr-2 h-4 w-4" />{error}</div>
  if (missing) return <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">Artifact content is unavailable.</div>
  return <>{children}</>
}
