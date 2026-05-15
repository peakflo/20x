import { useState, useRef } from 'react'

export interface ChatInputAttachment {
  id: string
  filename: string
  size: number
  mime_type: string
}

interface ChatInputProps {
  onSend: (message: string, options?: { attachments?: ChatInputAttachment[] }) => void
  disabled?: boolean
  placeholder?: string
  attachments?: ChatInputAttachment[]
  onRemoveAttachment?: (attachmentId: string) => void
  onOpenAttachmentPicker?: () => void
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ChatInput({
  onSend,
  disabled,
  placeholder = 'Send a message...',
  attachments = [],
  onRemoveAttachment,
  onOpenAttachmentPicker
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = () => {
    const text = value.trim()
    if (!text || disabled) return
    onSend(text, attachments.length > 0 ? { attachments } : undefined)
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const autoResize = () => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 128) + 'px'
    }
  }

  return (
    <div className="px-3 py-3 space-y-2">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-foreground"
              title={`${attachment.filename} (${formatFileSize(attachment.size)})`}
            >
              <svg className="h-3 w-3 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>
              </svg>
              <span className="truncate max-w-[180px]">{attachment.filename}</span>
              <span className="text-muted-foreground">{formatFileSize(attachment.size)}</span>
              <button
                type="button"
                onClick={() => onRemoveAttachment?.(attachment.id)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${attachment.filename}`}
              >
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); autoResize() }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="flex-1 bg-muted/50 border border-border rounded-lg px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground resize-none overflow-hidden max-h-32 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 min-h-[32px] disabled:opacity-40"
        />
        {onOpenAttachmentPicker && (
          <button
            type="button"
            onClick={onOpenAttachmentPicker}
            disabled={disabled}
            className="h-[32px] w-[32px] shrink-0 rounded-lg flex items-center justify-center border border-border/50 text-muted-foreground hover:text-foreground active:opacity-80 disabled:opacity-30 transition-colors"
            title="Attach files"
            aria-label="Attach files"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>
        )}
        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="h-[32px] w-[32px] shrink-0 rounded-lg flex items-center justify-center bg-primary text-primary-foreground active:opacity-80 disabled:opacity-30 transition-colors"
          aria-label="Send message"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" />
          </svg>
        </button>
      </div>
    </div>
  )
}
