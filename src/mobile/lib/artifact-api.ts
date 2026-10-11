import type { ArtifactApi } from '@shared/artifacts'
import { api } from '../api/client'

/** Adapts the mobile REST client to the shared `ArtifactApi` shape so
 * platform-agnostic artifact components (e.g. `InlineHtmlRender`) work
 * unmodified on mobile. No `copyFile`/`saveAs` — both desktop-only. */
export const mobileArtifactApi: ArtifactApi = {
  // Not used by InlineHtmlRender/useArtifactContent (both take the already
  // hydrated `Artifact` from the store); kept only to satisfy `ArtifactApi`.
  scan: async () => [],
  read: (taskId, relativePath) => api.artifacts.content(taskId, relativePath),
  mcpCall: (input) => api.artifacts.mcpCall(input)
}
