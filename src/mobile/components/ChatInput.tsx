import { useState, useRef } from 'react'

interface ChatInputProps {
  onSend: (message: string) => void
  disabled?: boolean
  placeholder?: string
}

export function ChatInput({ onSend, disabled, placeholder = 'Send a message...' }: ChatInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = () => {
    const text = value.trim()
    if (!text || disabled) return
    onSend(text)
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
    <div className="flex items-end gap-2 px-3 py-2">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => { setValue(e.target.value); autoResize() }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className="flex-1 bg-transparent border border-border/50 rounded-md px-3 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground resize-none overflow-hidden max-h-32 focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring/30 min-h-[32px]"
      />
      <button
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        className="h-7 w-7 shrink-0 mb-0.5 rounded-md flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
      >
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" />
        </svg>
      </button>
    </div>
  )
}
