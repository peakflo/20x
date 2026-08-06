import { FileDiff, List, PackageOpen, X } from 'lucide-react'
import type { Artifact } from '@shared/artifacts'
import { PinnedArtifactTabId } from '@/stores/artifact-store'
import { cn } from '@/lib/utils'
import { ARTIFACT_ICONS } from './artifact-icons'

export interface ArtifactTabStripProps {
  artifacts: Artifact[]
  activeTabId: string | null
  hasChanges: boolean
  hasOutput: boolean
  changesCount?: number
  onSelectTab: (tabId: string) => void
  onCloseTab: (artifactId: string) => void
  className?: string
}

export function ArtifactTabStrip({
  artifacts,
  activeTabId,
  hasChanges,
  hasOutput,
  changesCount = 0,
  onSelectTab,
  onCloseTab,
  className
}: ArtifactTabStripProps) {
  const pinned = [
    { id: PinnedArtifactTabId.DETAILS, label: 'Details', icon: List, visible: true, dimmed: false },
    { id: PinnedArtifactTabId.CHANGES, label: 'Changes', icon: FileDiff, visible: hasChanges, dimmed: changesCount === 0 },
    { id: PinnedArtifactTabId.OUTPUT, label: 'Output', icon: PackageOpen, visible: hasOutput, dimmed: false }
  ]

  return (
    <div className={cn('flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border/50 bg-background px-2 py-1.5', className)}>
      {pinned.filter((tab) => tab.visible).map((tab) => {
        const Icon = tab.icon
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelectTab(tab.id)}
            className={cn(
              'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors',
              activeTabId === tab.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              tab.dimmed && activeTabId !== tab.id && 'opacity-55'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {tab.label}
            {tab.id === PinnedArtifactTabId.CHANGES && changesCount > 0 && (
              <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold tabular-nums text-primary">{changesCount}</span>
            )}
          </button>
        )
      })}

      {artifacts.map((artifact) => {
        const Icon = ARTIFACT_ICONS[artifact.type]
        return (
          <div
            key={artifact.id}
            className={cn(
              'group flex h-7 max-w-48 shrink-0 items-center rounded-md text-xs transition-colors',
              activeTabId === artifact.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
          >
            <button type="button" onClick={() => onSelectTab(artifact.id)} className="flex min-w-0 items-center gap-1.5 py-1 pl-2">
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{artifact.title}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${artifact.title}`}
              onClick={(event) => { event.stopPropagation(); onCloseTab(artifact.id) }}
              className="mx-1 grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-background/70 hover:text-foreground group-hover:opacity-100 focus:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
