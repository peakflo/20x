import { useEffect } from 'react'
import { spacesSummaryToArtifact } from '@shared/enterprise-runners'
import { enterpriseRunnersApi } from '@/lib/ipc-client'
import { useArtifactStore } from '@/stores/artifact-store'

export const SPACES_ARTIFACT_REFRESH_MS = 30_000

/**
 * Brings a runner task's Spaces artifacts into the existing artifact store, so
 * they appear as ordinary tabs next to local ones and open in the existing
 * viewers. There is no second list: this only upserts `source: 'spaces'` rows.
 * `refreshKey` (for example the remote session status) refetches when the
 * session changes, since a finished turn is when new files show up.
 */
export function useSpacesArtifacts(taskId: string | undefined, enabled: boolean, refreshKey?: string | null): void {
  useEffect(() => {
    if (!taskId || !enabled) return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const result = await enterpriseRunnersApi.listSpacesArtifacts(taskId)
        if (cancelled) return
        // Offline results are the cached rows; the viewer reads the cache the same way.
        for (const summary of result.artifacts) {
          useArtifactStore.getState().upsertArtifact(spacesSummaryToArtifact(taskId, summary), false)
        }
      } catch {
        // A failed list leaves the tabs we already have; the next tick retries.
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), SPACES_ARTIFACT_REFRESH_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [taskId, enabled, refreshKey])
}
