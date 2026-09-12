import { useState } from 'react'
import type { Artifact } from '@shared/artifacts'
import { artifactFileType, isLocalArtifactLink, resolveArtifactLink } from '@shared/artifact-navigation'

export function useArtifactNavigation(artifact?: Artifact) {
  const [selection, setSelection] = useState<{ id: string; path: string } | null>(null)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const files = artifact?.files || (artifact?.path ? [artifact.path] : [])
  const selectedPath = selection?.id === artifact?.id && files.includes(selection?.path || '') ? selection?.path : artifact?.path
  const selectedArtifact = artifact && selectedPath && selectedPath !== artifact.path
    ? { ...artifact, path: selectedPath, type: artifactFileType(selectedPath) }
    : artifact
  const selectFile = (path: string) => {
    if (!artifact || !files.includes(path)) return
    setSelection({ id: artifact.id, path })
    setFailure(null)
  }
  const openLink = (href: string): boolean => {
    if (!artifact || !selectedPath || !isLocalArtifactLink(href)) return false
    const path = resolveArtifactLink(selectedPath, href, files)
    if (path) selectFile(path)
    else setFailure({ id: artifact.id, message: 'This file is not available in this artifact.' })
    return true
  }
  return { selectedArtifact, files, selectFile, openLink, linkError: failure?.id === artifact?.id ? failure?.message : null }
}
