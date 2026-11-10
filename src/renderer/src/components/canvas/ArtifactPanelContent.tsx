import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileText, Link2 } from 'lucide-react'
import { useArtifactStore } from '@/stores/artifact-store'
import { useTaskStore } from '@/stores/task-store'
import { useCanvasStore, connectedTaskIdsForArtifactPanel } from '@/stores/canvas-store'
import { artifactApi } from '@/lib/ipc-client'
import { ArtifactViewer, ACTIVE_ARTIFACT_REFRESH_INTERVAL_MS } from '@/components/artifacts/ArtifactsPanel'
import { ArtifactCopyActions } from '@/components/artifacts/ArtifactCopyActions'
import { ArtifactFileSelector } from '@/components/artifacts/ArtifactFileSelector'
import { useArtifactNavigation } from '@/components/artifacts/use-artifact-navigation'

interface ArtifactPanelContentProps {
  panelId: string
  /** Renderer artifact id */
  artifactId: string
  /** Task that owns the artifact */
  taskId: string
}

interface ConnectedTask {
  id: string
  title: string
}

function computeConnectedTasks(panelId: string): ConnectedTask[] {
  const { panels, edges } = useCanvasStore.getState()
  return connectedTaskIdsForArtifactPanel(panelId, panels, edges).map((id) => ({
    id,
    title: panels.find((p) => p.type === 'task' && p.refId === id)?.title || 'Task',
  }))
}

/**
 * A task artifact shown as its own canvas panel ("separate window").
 *
 * Renders with the same viewers as the task artifact panel. Other task panels
 * can be connected to it (drag near it, or use "Connect task"); connected
 * tasks are registered with the main-process artifact broker so their agents
 * can read the artifact via the canvas_artifact_* MCP tools — the artifact
 * equivalent of the agent browser panel.
 */
export function ArtifactPanelContent({ panelId, artifactId, taskId }: ArtifactPanelContentProps) {
  const artifact = useArtifactStore(
    useCallback((s) => s.artifactsByTask[taskId]?.find((a) => a.id === artifactId), [taskId, artifactId])
  )
  const hydrate = useArtifactStore((s) => s.hydrate)
  const ownerTitle = useTaskStore(useCallback((s) => s.tasks.find((t) => t.id === taskId)?.title, [taskId]))
  const setConnectingFromId = useCanvasStore((s) => s.setConnectingFromId)
  const bringToFront = useCanvasStore((s) => s.bringToFront)

  // Artifacts are loaded per task when its workspace opens; an artifact panel
  // restored on its own (app restart, task panel closed) loads them itself.
  useEffect(() => {
    void hydrate(taskId, artifactApi).catch((error) => {
      console.error('[ArtifactPanel] Failed to hydrate artifacts:', error)
    })
  }, [hydrate, taskId])

  const navigation = useArtifactNavigation(artifact)
  const selectedArtifact = navigation.selectedArtifact

  // Same periodic refresh as the task artifact panel.
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  useEffect(() => {
    if (!artifact) return
    const interval = window.setInterval(() => setRefreshTrigger((t) => t + 1), ACTIVE_ARTIFACT_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [artifact?.id])

  // ── Connected tasks (edges) ─────────────────────────────────
  // Re-computed only when edges change, not on every panel move.
  const [connectedTasks, setConnectedTasks] = useState<ConnectedTask[]>(() => computeConnectedTasks(panelId))
  useEffect(() => {
    setConnectedTasks(computeConnectedTasks(panelId))
    return useCanvasStore.subscribe(
      (state) => state.edges,
      () => setConnectedTasks(computeConnectedTasks(panelId))
    )
  }, [panelId])

  // ── Broker registration ─────────────────────────────────────
  // Mirrors the browser panel: the main process learns which tasks are
  // connected to this artifact so canvas_artifact_* tools can serve it to
  // exactly those tasks. Released by the canvas store when the panel closes.
  const taskIdsKey = connectedTasks.map((t) => t.id).join('\n')
  const filesKey = (artifact?.files ?? []).join('\n')
  useEffect(() => {
    if (!artifact) return
    try {
      void window.electronAPI?.canvasArtifacts
        ?.registerPanel({
          panelId,
          ownerTaskId: taskId,
          artifactId: artifact.id,
          title: artifact.title,
          type: artifact.type,
          path: artifact.path,
          files: artifact.files ?? (artifact.path ? [artifact.path] : []),
          url: artifact.url,
          taskIds: taskIdsKey ? taskIdsKey.split('\n') : [],
        })
        ?.catch(() => {})
    } catch {
      // IPC bridge unavailable (tests) — ignore
    }
    // Keyed on the stable string forms of the arrays so a re-render with equal
    // content does not re-register.
  }, [panelId, taskId, artifact?.id, artifact?.title, artifact?.type, artifact?.path, artifact?.url, filesKey, taskIdsKey])

  const handleConnect = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      // Enter connection mode; clicking a task panel completes an artifact edge.
      setConnectingFromId(panelId)
    },
    [panelId, setConnectingFromId]
  )

  const handleShowOwner = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const owner = useCanvasStore.getState().panels.find((p) => p.type === 'task' && p.refId === taskId)
      if (owner) bringToFront(owner.id)
    },
    [taskId, bringToFront]
  )

  const connectedLabel = useMemo(() => {
    if (connectedTasks.length === 0) return 'No tasks connected'
    if (connectedTasks.length === 1) return `Shared with ${connectedTasks[0].title}`
    return `Shared with ${connectedTasks.length} tasks`
  }, [connectedTasks])

  if (!artifact) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-muted-foreground/60" data-testid="artifact-panel-missing">
        <FileText className="h-5 w-5" />
        <span>Artifact not found or not loaded yet</span>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background select-text" data-testid="artifact-panel">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleShowOwner}
          className="min-w-0 truncate hover:text-foreground"
          title="Bring the owning task to the front"
        >
          From <span className="font-medium text-foreground/80">{ownerTitle || 'task'}</span>
        </button>
        <span className="text-muted-foreground/40">·</span>
        <span
          className={`min-w-0 truncate ${connectedTasks.length ? 'text-fuchsia-300' : ''}`}
          title={connectedTasks.map((t) => t.title).join(', ') || undefined}
          data-testid="artifact-panel-connections"
        >
          {connectedLabel}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {selectedArtifact && <ArtifactCopyActions key={`${artifact.id}:${selectedArtifact.path}`} artifact={selectedArtifact} artifactApi={artifactApi} />}
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleConnect}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-fuchsia-300 hover:bg-fuchsia-500/15"
            title="Connect a task: click a task panel next. Its agent can then read this artifact."
            aria-label="Connect a task to this artifact"
          >
            <Link2 className="h-3.5 w-3.5" />
            Connect task
          </button>
        </div>
      </div>
      <ArtifactFileSelector files={navigation.files} path={selectedArtifact?.path} onSelect={navigation.selectFile} />
      {navigation.linkError && <div role="alert" className="px-3 py-2 text-sm text-red-400">{navigation.linkError}</div>}
      <div className="relative min-h-0 flex-1">
        {selectedArtifact && (
          <ArtifactViewer artifact={selectedArtifact} artifactApi={artifactApi} refreshTrigger={refreshTrigger} onLinkClick={navigation.openLink} />
        )}
      </div>
    </div>
  )
}
