import { useEffect, useRef, useState } from 'react'
import type { Artifact, ArtifactApi, ArtifactContent } from '@shared/artifacts'

export function useArtifactContent(artifact: Artifact, artifactApi: ArtifactApi, refreshTrigger = 0) {
  const [content, setContent] = useState<ArtifactContent | null>(null)
  const [loading, setLoading] = useState(!!artifact.path)
  const [error, setError] = useState<string | null>(null)
  const settledIdentityRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!artifact.path) {
      settledIdentityRef.current = null
      setContent(null)
      setLoading(false)
      setError(null)
      return
    }
    const identity = `${artifact.taskId}:${artifact.path}`
    const initialLoad = settledIdentityRef.current !== identity
    if (initialLoad) {
      setContent(null)
      setLoading(true)
      setError(null)
    }
    artifactApi.read(artifact.taskId, artifact.path).then((next) => {
      if (!cancelled) {
        setContent(next)
        setError(null)
      }
    }).catch((reason: unknown) => {
      if (!cancelled && initialLoad) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) {
        settledIdentityRef.current = identity
        if (initialLoad) setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [artifact.taskId, artifact.path, artifact.reloadTrigger, artifactApi, refreshTrigger])

  return { content, loading, error }
}
