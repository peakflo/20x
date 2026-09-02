import { useEffect, useState, type ReactNode } from 'react'
import { PanelRightClose } from 'lucide-react'
import { ArtifactType, type Artifact, type ArtifactApi, type ArtifactUIState } from '@shared/artifacts'
import { PinnedArtifactTabId } from '@/stores/artifact-store'
import { cn } from '@/lib/utils'
import { ArtifactCopyActions } from './ArtifactCopyActions'
import { ArtifactTabStrip } from './ArtifactTabStrip'
import { MarkdownArtifactView } from './viewers/MarkdownArtifactView'
import { ImageArtifactView } from './viewers/ImageArtifactView'
import { HtmlArtifactView } from './viewers/HtmlArtifactView'
import { PrArtifactView } from './viewers/PrArtifactView'
import { FileArtifactView } from './viewers/FileArtifactView'

export const ACTIVE_ARTIFACT_REFRESH_INTERVAL_MS = 30_000

export interface ArtifactsPanelProps {
  taskId: string
  artifacts: Artifact[]
  ui: ArtifactUIState
  artifactApi: ArtifactApi
  hasChanges: boolean
  hasOutput: boolean
  changesCount?: number
  onSelectTab: (tabId: string) => void
  onCloseTab: (artifactId: string) => void
  onToggleOpen: () => void
  onToggleRail: () => void
  details: ReactNode
  changes: ReactNode
  output: ReactNode
  className?: string
}

export function ArtifactsPanel({ artifacts, ui, artifactApi, hasChanges, hasOutput, changesCount, onSelectTab, onCloseTab, onToggleOpen, details, changes, output, className }: ArtifactsPanelProps) {
  const active = ui.activeTabId || PinnedArtifactTabId.DETAILS
  const activeArtifact = artifacts.find((artifact) => artifact.id === active)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  useEffect(() => {
    if (!activeArtifact) return
    const interval = window.setInterval(() => {
      setRefreshTrigger((trigger) => trigger + 1)
    }, ACTIVE_ARTIFACT_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [activeArtifact?.id])

  return (
    <section className={cn('flex h-full min-h-0 min-w-0 flex-col bg-background', className)} data-task-artifacts>
      <div className="relative">
        <ArtifactTabStrip artifacts={artifacts} activeTabId={active} hasChanges={hasChanges} hasOutput={hasOutput} changesCount={changesCount} onSelectTab={onSelectTab} onCloseTab={onCloseTab} className={activeArtifact ? 'pr-52' : 'pr-11'} />
        <div className="absolute right-2 top-1.5 flex items-center gap-1 bg-background">
          {activeArtifact && <ArtifactCopyActions key={activeArtifact.id} artifact={activeArtifact} artifactApi={artifactApi} />}
          <button type="button" aria-label="Close artifacts" onClick={onToggleOpen} className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><PanelRightClose className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className={active === PinnedArtifactTabId.DETAILS ? 'h-full' : 'hidden'}>{details}</div>
        {hasChanges && active === PinnedArtifactTabId.CHANGES && <div className="h-full">{changes}</div>}
        {hasOutput && <div className={active === PinnedArtifactTabId.OUTPUT ? 'h-full overflow-y-auto p-4' : 'hidden'}>{output}</div>}
        {artifacts.map((artifact) => (
          <div key={artifact.id} className={active === artifact.id ? 'h-full' : 'hidden'}>
            {active === artifact.id ? <ArtifactViewer artifact={artifact} artifactApi={artifactApi} refreshTrigger={refreshTrigger} /> : null}
          </div>
        ))}
      </div>
    </section>
  )
}

function ArtifactViewer({ artifact, artifactApi, refreshTrigger }: { artifact: Artifact; artifactApi: ArtifactApi; refreshTrigger: number }) {
  switch (artifact.type) {
    case ArtifactType.MARKDOWN: return <MarkdownArtifactView artifact={artifact} artifactApi={artifactApi} refreshTrigger={refreshTrigger} />
    case ArtifactType.IMAGE: return <ImageArtifactView artifact={artifact} artifactApi={artifactApi} refreshTrigger={refreshTrigger} />
    case ArtifactType.HTML: return <HtmlArtifactView artifact={artifact} artifactApi={artifactApi} refreshTrigger={refreshTrigger} />
    case ArtifactType.PR: return <PrArtifactView artifact={artifact} refreshTrigger={refreshTrigger} />
    default: return <FileArtifactView artifact={artifact} artifactApi={artifactApi} refreshTrigger={refreshTrigger} />
  }
}
