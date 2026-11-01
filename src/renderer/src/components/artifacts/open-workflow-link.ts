import { ArtifactType, workflowArtifactId, workflowPanelRefFromUrl } from '@shared/artifacts'
import { useArtifactStore } from '@/stores/artifact-store'

/**
 * Open a Spaces workflow summary link (`panelUrl`) as a workflow tab in the
 * task's artifacts panel. Creates the tab when the agent's tool output did not
 * already create it. Returns false for every other link, so the caller keeps
 * the default link behaviour.
 */
export function openWorkflowLink(taskId: string, href: string, text?: string): boolean {
  const ref = workflowPanelRefFromUrl(href)
  if (!ref) return false
  const store = useArtifactStore.getState()
  const id = workflowArtifactId(taskId, ref.workflowId)
  const existing = store.getArtifacts(taskId).find((artifact) => artifact.id === id)
  if (!existing || existing.url !== ref.url) {
    store.upsertArtifact({
      id,
      taskId,
      type: ArtifactType.WORKFLOW,
      title: existing?.title || text?.trim() || 'Workflow',
      url: ref.url,
      updatedAt: Date.now()
    })
  }
  store.selectTab(taskId, id, true)
  return true
}

/** The label of the first Markdown link `[label](href)` to `href`. */
export function markdownLinkLabel(markdown: string, href: string): string | undefined {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return markdown.match(new RegExp(`\\[([^\\]]+)\\]\\(<?${escaped}>?(?:\\s+"[^"]*")?\\)`))?.[1]?.trim() || undefined
}
