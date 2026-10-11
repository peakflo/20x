import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArtifactContentKind, ArtifactType, type ArtifactContent } from '@shared/artifacts'
import { ScadEditor } from './ScadArtifactView'

interface ScadAttachmentApi {
  readScad: (taskId: string, attachmentId: string) => Promise<string>
  saveScad: (taskId: string, attachmentId: string, content: string, expectedContent: string) => Promise<void>
  renderScad: (taskId: string, attachmentId: string) => Promise<string>
}

export function ScadAttachmentEditor({ taskId, attachment, api }: {
  taskId: string
  attachment: { id: string; filename: string }
  api: ScadAttachmentApi
}) {
  const [content, setContent] = useState<ArtifactContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setContent(null)
    setError(null)
    void api.readScad(taskId, attachment.id).then((text) => {
      if (active) setContent({ kind: ArtifactContentKind.TEXT, content: text })
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { active = false }
  }, [api, taskId, attachment.id])

  const read = useCallback(async () => ({ kind: ArtifactContentKind.TEXT, content: await api.readScad(taskId, attachment.id) }), [api, taskId, attachment.id])
  const save = useCallback(async (_taskId: string, _path: string, text: string, expected: string) => api.saveScad(taskId, attachment.id, text, expected), [api, taskId, attachment.id])
  const renderModel = useCallback(async () => api.renderScad(taskId, attachment.id), [api, taskId, attachment.id])
  const artifact = useMemo(() => ({ id: attachment.id, taskId, title: attachment.filename, type: ArtifactType.FILE, path: attachment.filename, updatedAt: 0, reloadTrigger: 0 }), [attachment.id, attachment.filename, taskId])

  if (error) return <div role="alert" className="p-4 text-sm text-red-400">{error}</div>
  if (!content) return <div className="p-4 text-sm text-muted-foreground">Loading SCAD file…</div>
  return <ScadEditor artifact={artifact} content={content} read={read} save={save} renderModel={renderModel} />
}
