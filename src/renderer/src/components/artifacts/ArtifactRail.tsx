import { ChevronLeft, ChevronRight, FileCheck2, GitCompareArrows, List } from 'lucide-react'
import type { Artifact } from '@shared/artifacts'
import { PinnedArtifactTabId } from '@/stores/artifact-store'
import { cn } from '@/lib/utils'
import { ARTIFACT_ICONS } from './artifact-icons'

export interface ArtifactRailProps {
  artifacts: Artifact[]
  expanded: boolean
  activeTabId?: string | null
  agentActive?: boolean
  hasChanges?: boolean
  hasOutput?: boolean
  changesCount?: number
  onSelectTab: (tabId: string) => void
  onToggleExpanded: () => void
  className?: string
}

export function ArtifactRail({ artifacts, expanded, activeTabId, agentActive, hasChanges, hasOutput, changesCount, onSelectTab, onToggleExpanded, className }: ArtifactRailProps) {
  return (
    <aside className={cn('flex h-full shrink-0 flex-col border-l border-border/50 bg-[#0d1117] transition-[width] duration-200', expanded ? 'w-[220px]' : 'w-12', className)}>
      <div className="flex h-10 items-center border-b border-border/50 px-1.5">
        {expanded && <span className="min-w-0 flex-1 truncate px-1.5 text-xs font-medium text-muted-foreground">Artifacts</span>}
        <button type="button" aria-label={expanded ? 'Collapse artifacts rail' : 'Expand artifacts rail'} onClick={onToggleExpanded} className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          {expanded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-1.5">
        <RailItem icon={List} label="Details" expanded={expanded} active={activeTabId === PinnedArtifactTabId.DETAILS} onClick={() => onSelectTab(PinnedArtifactTabId.DETAILS)} />
        {hasChanges && <RailItem icon={GitCompareArrows} label={`Changes${changesCount ? ` · ${changesCount}` : ''}`} expanded={expanded} active={activeTabId === PinnedArtifactTabId.CHANGES} onClick={() => onSelectTab(PinnedArtifactTabId.CHANGES)} />}
        {hasOutput && <RailItem icon={FileCheck2} label="Output" expanded={expanded} active={activeTabId === PinnedArtifactTabId.OUTPUT} onClick={() => onSelectTab(PinnedArtifactTabId.OUTPUT)} />}
        {artifacts.map((artifact) => (
          <RailItem key={artifact.id} icon={ARTIFACT_ICONS[artifact.type]} label={artifact.title} expanded={expanded} active={activeTabId === artifact.id} activity={agentActive} onClick={() => onSelectTab(artifact.id)} />
        ))}
      </div>
    </aside>
  )
}

function RailItem({ icon: Icon, label, expanded, active, activity, onClick }: { icon: typeof List; label: string; expanded: boolean; active: boolean; activity?: boolean; onClick: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className={cn('relative flex h-8 w-full items-center rounded-md text-xs transition-colors', expanded ? 'gap-2 px-2' : 'justify-center', active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
      <Icon className="h-4 w-4 shrink-0" />
      {expanded && <span className="truncate">{label}</span>}
      {activity && <span aria-label="Agent activity" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400" />}
    </button>
  )
}
