import { useCallback, useRef } from 'react'
import { attachmentApi } from '@/lib/ipc-client'
import { dispatchShortcutFeedback } from '@/lib/keyboard-shortcuts'
import { materializeClipboardAttachments, planClipboardAttachments } from '@/lib/clipboard-attachments'

type PasteLikeEvent = Pick<ClipboardEvent, 'clipboardData' | 'preventDefault' | 'defaultPrevented'>

function resolveFilePath(file: File): string {
  const getPath = window.electronAPI?.webUtils?.getPathForFile
  if (getPath) return getPath(file)
  // Older Electron builds exposed the path directly on File.
  return (file as File & { path?: string }).path ?? ''
}

/**
 * Returns a paste handler that attaches pasted files/screenshots via
 * `onAddPaths` (the same path-based pipeline as drag-and-drop and the file
 * picker). Text-only pastes are left untouched. Works with React and native
 * `paste` events. Pass `undefined` to disable.
 */
export function useClipboardAttachmentPaste(
  onAddPaths: ((paths: string[]) => unknown) | undefined
): (event: PasteLikeEvent) => void {
  const onAddPathsRef = useRef(onAddPaths)
  onAddPathsRef.current = onAddPaths

  return useCallback((event: PasteLikeEvent) => {
    if (!onAddPathsRef.current || event.defaultPrevented) return
    const plan = planClipboardAttachments(event.clipboardData, resolveFilePath)
    if (!plan) return
    event.preventDefault()
    void (async () => {
      try {
        const paths = await materializeClipboardAttachments(plan, attachmentApi.stageClipboardFile)
        if (paths.length > 0) await onAddPathsRef.current?.(paths)
      } catch (error) {
        console.error('[clipboard-paste] Failed to attach pasted files:', error)
        const detail = error instanceof Error && error.message ? error.message : String(error ?? '')
        dispatchShortcutFeedback(`Could not attach pasted file${detail ? ` — ${detail.slice(0, 200)}` : ''}`, true)
      }
    })()
  }, [])
}
