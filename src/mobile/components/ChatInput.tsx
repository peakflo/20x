import { useEffect, useState, useRef } from 'react'
import { api } from '../api/client'

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
  placeholder = 'Write a message...',
  attachments = [],
  onRemoveAttachment,
  onOpenAttachmentPicker
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const [voiceNote, setVoiceNote] = useState<string | null>(null)
  const [voiceReason, setVoiceReason] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Voice capture runs on the desktop host in phase 1. Ask the host what it
  // supports instead of guessing, then explain the limit in place of a button
  // that cannot work.
  useEffect(() => {
    let cancelled = false
    // An older desktop host has no capability route, so the call is optional.
    void Promise.resolve(api.capabilities?.get?.())
      .then((caps) => {
        if (!cancelled && caps && !caps.voice.available) setVoiceReason(caps.voice.reason ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

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
    <div className="pointer-events-auto px-3 py-4 space-y-2">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              className="glass-attachment-chip inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-foreground"
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

      {voiceNote && <p className="glass-popover rounded-xl border px-3 py-2 text-xs text-foreground" role="status">{voiceNote}</p>}

      <div className="flex items-end gap-2">
        {onOpenAttachmentPicker && (
          <button
            type="button"
            onClick={onOpenAttachmentPicker}
            disabled={disabled}
            className="glass-action text-muted-foreground hover:text-foreground active:opacity-80"
            title="Attach files"
            aria-label="Attach files"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>
        )}
        <div className="glass-composer flex min-w-0 flex-1 items-center">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); autoResize() }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={`w-full bg-transparent pl-4 ${voiceReason ? 'pr-12' : 'pr-4'} py-[13px] leading-[22px] text-sm text-foreground placeholder:text-[var(--glass-placeholder)] resize-none overflow-hidden max-h-32 focus:outline-none min-h-[48px] disabled:opacity-40`}
        />
        {voiceReason && (
          <button
            type="button"
            onClick={() => setVoiceNote((current) => current ? null : voiceReason)}
            className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            title={voiceReason}
            aria-label="Why voice input is unavailable"
            aria-expanded={Boolean(voiceNote)}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M12 11v5"/><path d="M12 8h.01"/>
            </svg>
          </button>
        )}
        </div>
        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="glass-action glass-send active:opacity-80"
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
