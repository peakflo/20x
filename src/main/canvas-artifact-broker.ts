/**
 * Canvas Artifact Broker.
 *
 * The artifact counterpart of `panel-browser-broker.ts`. A canvas "artifact
 * panel" shows one artifact owned by one task. Other task panels can be
 * edge-connected to it on the canvas; the renderer registers each artifact
 * panel here together with the task ids it is connected to, and the
 * `canvas_artifact_*` MCP tools let those tasks' agents read it.
 *
 * Guarantees (mirroring the browser broker):
 *  1. Only registered panels are addressable, and only by tasks that are
 *     edge-connected to them. Artifact tools for a task's own workpieces stay
 *     pinned to that task — this broker is the ONLY cross-task read path, and
 *     it exists only while the user keeps the connection on the canvas.
 *  2. A file is readable only when it is the panel's artifact entry or one of
 *     the artifact's owned files, re-checked against the owner task's artifact
 *     list on disk (the renderer's file list is never trusted on its own).
 *  3. Read-only. A connected agent cannot change another task's artifact.
 */
import type { ArtifactContent, ArtifactFileEntry, CanvasArtifactPanelRegistration } from '../shared/artifacts'

export type ArtifactPanelRegistration = CanvasArtifactPanelRegistration

interface RegisteredArtifactPanel extends Omit<ArtifactPanelRegistration, 'taskIds'> {
  taskIds: Set<string>
}

export interface LinkedArtifactSummary {
  panel_id: string
  owner_task_id: string
  artifact_id: string
  title: string
  type: string
  entry_file?: string
  files: string[]
  url?: string
}

export type ArtifactPanelResolution =
  | { ok: true; panel: RegisteredArtifactPanel }
  | { ok: false; error: string }

export interface ArtifactReadDeps {
  getWorkspaceDir: (taskId: string) => string
  listEntries: (workspaceDir: string, taskId: string) => Promise<ArtifactFileEntry[]>
  readArtifact: (workspaceDir: string, relativePath: string) => Promise<ArtifactContent | null>
}

function sanitizeStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
}

export class CanvasArtifactBroker {
  private readonly registry = new Map<string, RegisteredArtifactPanel>()

  /** Register or replace an artifact panel. Returns false for malformed input. */
  register(input: ArtifactPanelRegistration): boolean {
    if (!input || typeof input.panelId !== 'string' || !input.panelId) return false
    if (typeof input.ownerTaskId !== 'string' || !input.ownerTaskId) return false
    if (typeof input.artifactId !== 'string' || !input.artifactId) return false
    this.registry.set(input.panelId, {
      panelId: input.panelId,
      ownerTaskId: input.ownerTaskId,
      artifactId: input.artifactId,
      title: typeof input.title === 'string' ? input.title : 'Artifact',
      type: typeof input.type === 'string' ? input.type : 'file',
      path: typeof input.path === 'string' ? input.path : undefined,
      files: sanitizeStrings(input.files),
      url: typeof input.url === 'string' ? input.url : undefined,
      taskIds: new Set(sanitizeStrings(input.taskIds))
    })
    return true
  }

  unregister(panelId: string): void {
    this.registry.delete(panelId)
  }

  clear(): void {
    this.registry.clear()
  }

  /** Artifact panels connected to `taskId` (the renderer omits the owner task — it already has its own artifact tools). */
  list(taskId: string): LinkedArtifactSummary[] {
    const out: LinkedArtifactSummary[] = []
    for (const panel of this.registry.values()) {
      if (!panel.taskIds.has(taskId)) continue
      out.push({
        panel_id: panel.panelId,
        owner_task_id: panel.ownerTaskId,
        artifact_id: panel.artifactId,
        title: panel.title,
        type: panel.type,
        entry_file: panel.path,
        files: panel.files?.length ? [...panel.files] : panel.path ? [panel.path] : [],
        url: panel.url
      })
    }
    return out
  }

  /**
   * Picks the artifact panel a read may target. With an explicit panel_id it
   * must exist AND be connected to the calling task; without one, auto-binds
   * when exactly one artifact panel is connected (ambiguity is an error).
   */
  resolve(taskId: string, panelId?: string | null): ArtifactPanelResolution {
    if (panelId) {
      const panel = this.registry.get(panelId)
      if (!panel) return { ok: false, error: `Unknown artifact panel "${panelId}". Use canvas_artifact_list.` }
      if (!panel.taskIds.has(taskId)) {
        return { ok: false, error: `Artifact panel "${panelId}" is not connected to this task. Use canvas_artifact_list.` }
      }
      return { ok: true, panel }
    }
    const linked = [...this.registry.values()].filter((p) => p.taskIds.has(taskId))
    if (linked.length === 0) {
      return { ok: false, error: 'No artifact panel is connected to this task. Connect one on the canvas.' }
    }
    if (linked.length > 1) {
      return { ok: false, error: `Multiple artifact panels are connected to this task (${linked.map((p) => p.panelId).join(', ')}). Pass panel_id.` }
    }
    return { ok: true, panel: linked[0] }
  }

  /** Read one file of a connected artifact (defaults to its entry file). */
  async read(
    taskId: string,
    input: { panelId?: string | null; file?: string | null },
    deps: ArtifactReadDeps
  ): Promise<{ panel_id: string; owner_task_id: string; file: string; content: ArtifactContent } | { error: string }> {
    const resolved = this.resolve(taskId, input.panelId)
    if (!resolved.ok) return { error: resolved.error }
    const { panel } = resolved
    if (panel.url && !panel.path) {
      return { error: `This artifact is a link, not a file: ${panel.url}` }
    }
    const file = input.file || panel.path
    if (!file) return { error: 'This artifact has no readable file.' }
    const allowed = new Set([...(panel.files ?? []), ...(panel.path ? [panel.path] : [])])
    if (!allowed.has(file)) {
      return { error: `"${file}" is not a file of this artifact. Use canvas_artifact_list for its files.` }
    }
    const workspaceDir = deps.getWorkspaceDir(panel.ownerTaskId)
    // Re-verify against the owner's artifact list on disk: the renderer's
    // registration says which artifact the user connected, not what is safe.
    const entries = await deps.listEntries(workspaceDir, panel.ownerTaskId)
    if (!entries.some((entry) => entry.path === file || entry.files?.includes(file))) {
      return { error: `"${file}" is no longer an artifact file of the owning task.` }
    }
    const content = await deps.readArtifact(workspaceDir, file)
    if (!content) return { error: `Could not read "${file}" (missing, unsupported, or over the size limit).` }
    return { panel_id: panel.panelId, owner_task_id: panel.ownerTaskId, file, content }
  }
}

export const canvasArtifactBroker = new CanvasArtifactBroker()
