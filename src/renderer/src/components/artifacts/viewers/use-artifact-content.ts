import { useEffect, useState } from 'react'
import type { Artifact, ArtifactApi, ArtifactContent } from '@shared/artifacts'

export function useArtifactContent(artifact: Artifact, artifactApi: ArtifactApi) {
  const [content, setContent] = useState<ArtifactContent | null>(null)
  const [loading, setLoading] = useState(!!artifact.path)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!artifact.path) {
      setContent(null)
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    artifactApi.read(artifact.taskId, artifact.path).then((next) => {
      if (!cancelled) setContent(next)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [artifact.taskId, artifact.path, artifact.reloadTrigger, artifactApi])

  return { content, loading, error }
}
