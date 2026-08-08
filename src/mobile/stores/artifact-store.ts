import { create } from 'zustand'
import { ArtifactType, type Artifact } from '@shared/artifacts'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'

export { ArtifactType }
export type { Artifact }

interface ArtifactState {
  artifactsByTask: Map<string, Artifact[]>
  loadingTaskIds: Set<string>
  hydrate: (taskId: string) => Promise<void>
  upsert: (artifact: Artifact) => void
  getArtifact: (taskId: string, artifactId: string) => Artifact | undefined
}

const hydrating = new Map<string, Promise<void>>()

function mergeArtifacts(current: Artifact[], incoming: Artifact[]): Artifact[] {
  const byId = new Map(current.map((artifact) => [artifact.id, artifact]))
  for (const artifact of incoming) {
    const existing = byId.get(artifact.id)
    byId.set(
      artifact.id,
      existing && existing.updatedAt > artifact.updatedAt
        ? existing
        : { ...existing, ...artifact, reloadTrigger: Math.max(existing?.reloadTrigger || 0, artifact.reloadTrigger) }
    )
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title))
}

export const useArtifactStore = create<ArtifactState>((set, get) => {
  onEvent('artifact:updated', (payload) => {
    const event = payload as { artifact?: Artifact } & Partial<Artifact>
    const artifact = event.artifact || (event.id && event.taskId ? event as Artifact : null)
    if (artifact) get().upsert(artifact)
    else if (event.taskId) void get().hydrate(event.taskId)
  })

  return {
    artifactsByTask: new Map(),
    loadingTaskIds: new Set(),

    hydrate: async (taskId) => {
      const existing = hydrating.get(taskId)
      if (existing) return existing

      const request = (async () => {
        set((state) => ({ loadingTaskIds: new Set(state.loadingTaskIds).add(taskId) }))
        try {
          const artifacts = await api.artifacts.list(taskId)
          set((state) => ({
            artifactsByTask: new Map(state.artifactsByTask).set(
              taskId,
              mergeArtifacts(state.artifactsByTask.get(taskId) || [], artifacts)
            )
          }))
        } catch (error) {
          console.error(`[mobile] Failed to load artifacts for ${taskId}:`, error)
        } finally {
          set((state) => {
            const loadingTaskIds = new Set(state.loadingTaskIds)
            loadingTaskIds.delete(taskId)
            return { loadingTaskIds }
          })
          hydrating.delete(taskId)
        }
      })()

      hydrating.set(taskId, request)
      return request
    },

    upsert: (artifact) => {
      set((state) => {
        const current = state.artifactsByTask.get(artifact.taskId) || []
        return {
          artifactsByTask: new Map(state.artifactsByTask).set(
            artifact.taskId,
            mergeArtifacts(current, [artifact])
          )
        }
      })
    },

    getArtifact: (taskId, artifactId) =>
      get().artifactsByTask.get(taskId)?.find((artifact) => artifact.id === artifactId)
  }
})
