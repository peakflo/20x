import { ExternalLink, GitPullRequest } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { Artifact } from '@shared/artifacts'

export function PrArtifactView({ artifact }: { artifact: Artifact }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-border/50 bg-card p-5">
        <div className="flex items-start gap-3">
          <GitPullRequest className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-foreground">{artifact.title}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{artifact.url}</div>
          </div>
        </div>
        {artifact.url && <Button type="button" className="mt-4 w-full gap-2" onClick={() => window.electronAPI.shell.openExternal(artifact.url!)}><ExternalLink className="h-4 w-4" />Open in browser</Button>}
      </div>
    </div>
  )
}
