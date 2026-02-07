import { Paperclip, X, FileText } from 'lucide-react'
import { attachmentApi } from '@/lib/ipc-client'
import type { FileAttachment } from '@/types'

export interface PendingFile {
  id: string
  filename: string
  size: number
  sourcePath: string
}

interface TaskAttachmentsProps {
  items: FileAttachment[]
  onChange: (items: FileAttachment[]) => void
  taskId: string | null
  readOnly?: boolean
  pendingFiles?: PendingFile[]
  onPendingChange?: (files: PendingFile[]) => void
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function TaskAttachments({
  items,
  onChange,
  taskId,
  readOnly = false,
  pendingFiles = [],
  onPendingChange
}: TaskAttachmentsProps) {
  const handleAdd = async () => {
    const filePaths = await attachmentApi.pick()
    if (!filePaths.length) return

    if (taskId) {
      // Existing task — save files immediately
      const newAttachments: FileAttachment[] = []
      for (const fp of filePaths) {
        const attachment = await attachmentApi.save(taskId, fp)
        newAttachments.push(attachment)
      }
      onChange([...items, ...newAttachments])
    } else {
      // New task — store as pending
      const pending: PendingFile[] = filePaths.map((fp) => ({
        id: crypto.randomUUID(),
        filename: fp.split('/').pop() || fp.split('\\').pop() || fp,
        size: 0,
        sourcePath: fp
      }))
      onPendingChange?.([...pendingFiles, ...pending])
    }
  }

  const handleRemove = async (attachment: FileAttachment) => {
    if (taskId) {
      await attachmentApi.remove(taskId, attachment.id)
    }
    onChange(items.filter((a) => a.id !== attachment.id))
  }

  const handleRemovePending = (id: string) => {
    onPendingChange?.(pendingFiles.filter((f) => f.id !== id))
  }

  const handleOpen = (attachment: FileAttachment) => {
    if (taskId) attachmentApi.open(taskId, attachment.id)
  }

  const totalCount = items.length + pendingFiles.length

  return (
    <div className="space-y-2" role="group" aria-label="Attachments">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Attachments</span>
        {totalCount > 0 && (
          <span className="text-xs text-muted-foreground">{totalCount} file{totalCount !== 1 ? 's' : ''}</span>
        )}
      </div>

      {(items.length > 0 || pendingFiles.length > 0) && (
        <div className="space-y-1" role="list">
          {items.map((a) => (
            <div key={a.id} className="flex items-center gap-2 group" role="listitem">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <button
                type="button"
                onClick={() => handleOpen(a)}
                className="text-sm flex-1 text-left truncate hover:underline cursor-pointer"
              >
                {a.filename}
              </button>
              <span className="text-xs text-muted-foreground shrink-0">{formatFileSize(a.size)}</span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleRemove(a)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
          {pendingFiles.map((f) => (
            <div key={f.id} className="flex items-center gap-2 group" role="listitem">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-sm flex-1 truncate">{f.filename}</span>
              <span className="text-xs text-muted-foreground shrink-0">pending</span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleRemovePending(f.id)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <button
          type="button"
          onClick={handleAdd}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <Paperclip className="h-3.5 w-3.5" />
          Add files
        </button>
      )}
    </div>
  )
}
