import type { ReactNode } from 'react'
import { PanelRightClose } from 'lucide-react'
import { ArtifactType, type Artifact, type ArtifactApi, type ArtifactUIState } from '@shared/artifacts'
import { PinnedArtifactTabId } from '@/stores/artifact-store'
import { cn } from '@/lib/utils'
import { ArtifactTabStrip } from './ArtifactTabStrip'
import { MarkdownArtifactView } from './viewers/MarkdownArtifactView'
import { ImageArtifactView } from './viewers/ImageArtifactView'
import { HtmlArtifactView } from './viewers/HtmlArtifactView'
import { PrArtifactView } from './viewers/PrArtifactView'
import { FileArtifactView } from './viewers/FileArtifactView'

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

  return (
    <section className={cn('flex h-full min-h-0 min-w-0 flex-col bg-background', className)} data-task-artifacts>
      <div className="relative">
        <ArtifactTabStrip artifacts={artifacts} activeTabId={active} hasChanges={hasChanges} hasOutput={hasOutput} changesCount={changesCount} onSelectTab={onSelectTab} onCloseTab={onCloseTab} className="pr-11" />
        <button type="button" aria-label="Close artifacts" onClick={onToggleOpen} className="absolute right-2 top-1.5 grid h-7 w-7 place-items-center rounded-md bg-background text-muted-foreground hover:bg-accent hover:text-foreground"><PanelRightClose className="h-3.5 w-3.5" /></button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className={active === PinnedArtifactTabId.DETAILS ? 'h-full' : 'hidden'}>{details}</div>
        {hasChanges && <div className={active === PinnedArtifactTabId.CHANGES ? 'h-full' : 'hidden'}>{changes}</div>}
        {hasOutput && <div className={active === PinnedArtifactTabId.OUTPUT ? 'h-full overflow-y-auto p-4' : 'hidden'}>{output}</div>}
        {artifacts.map((artifact) => (
          <div key={artifact.id} className={active === artifact.id ? 'h-full' : 'hidden'}>
            {active === artifact.id ? <ArtifactViewer artifact={artifact} artifactApi={artifactApi} /> : null}
          </div>
        ))}
      </div>
    </section>
  )
}

function ArtifactViewer({ artifact, artifactApi }: { artifact: Artifact; artifactApi: ArtifactApi }) {
  switch (artifact.type) {
    case ArtifactType.MARKDOWN: return <MarkdownArtifactView artifact={artifact} artifactApi={artifactApi} />
    case ArtifactType.IMAGE: return <ImageArtifactView artifact={artifact} artifactApi={artifactApi} />
    case ArtifactType.HTML: return <HtmlArtifactView artifact={artifact} artifactApi={artifactApi} />
    case ArtifactType.PR: return <PrArtifactView artifact={artifact} />
    default: return <FileArtifactView artifact={artifact} artifactApi={artifactApi} />
  }
}
