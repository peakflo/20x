import { useState, useRef, useCallback, useEffect } from 'react'
import { Paperclip, AtSign, Plus, ArrowUp, ChevronDown, Settings } from 'lucide-react'
import { agentApi } from '@/lib/ipc-client'
import type { Agent } from '@/types'

interface CommandInputProps {
  onSendToMastermind: (message: string) => void
  onCreateTask: (text: string) => void
}

export function CommandInput({ onSendToMastermind, onCreateTask }: CommandInputProps) {
  const [text, setText] = useState('')
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [showAgentDropdown, setShowAgentDropdown] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Load agents on mount
  useEffect(() => {
    agentApi.getAll().then((allAgents) => {
      setAgents(allAgents)
      const defaultAgent = allAgents.find((a) => a.is_default) || allAgents[0]
      if (defaultAgent) setSelectedAgentId(defaultAgent.id)
    })
  }, [])

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showAgentDropdown) return undefined
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowAgentDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showAgentDropdown])

  // Auto-resize textarea
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSendToMastermind(trimmed)
    setText('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, onSendToMastermind])

  const handleCreateTask = useCallback(() => {
    onCreateTask(text.trim())
    setText('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, onCreateTask])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const selectedAgent = agents.find((a) => a.id === selectedAgentId)

  return (
    <div className="rounded-lg border border-border/80 bg-muted overflow-hidden shadow-sm transition-all duration-200 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30">
      {/* Text area */}
      <div className="px-4 pt-3 pb-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Ask Mastermind or describe a task..."
          rows={1}
          className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none leading-relaxed max-h-32 min-h-[32px]"
        />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 pb-2.5 pt-0.5 border-t border-border/40">
        {/* Agent selector pill */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setShowAgentDropdown(!showAgentDropdown)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors cursor-pointer"
          >
            <Settings className="h-3 w-3" />
            <span className="max-w-[120px] truncate">{selectedAgent?.name || 'Select agent'}</span>
            <ChevronDown className="h-3 w-3" />
          </button>

          {showAgentDropdown && (
            <div className="absolute bottom-full left-0 mb-1 w-48 rounded-lg border border-border bg-popover shadow-lg py-1 z-50">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => {
                    setSelectedAgentId(agent.id)
                    setShowAgentDropdown(false)
                  }}
                  className={`w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                    agent.id === selectedAgentId
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-muted/50'
                  }`}
                >
                  {agent.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Separator */}
        <div className="w-px h-4 bg-border mx-1" />

        {/* Attach file */}
        <button
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors cursor-pointer"
          title="Attach file"
        >
          <Paperclip className="h-3.5 w-3.5" />
        </button>

        {/* Mention */}
        <button
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors cursor-pointer"
          title="Mention"
        >
          <AtSign className="h-3.5 w-3.5" />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Create task button */}
        <button
          onClick={handleCreateTask}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-background/60 border border-border/60 transition-colors cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" />
          Create task
        </button>

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!text.trim()}
          className={`p-1.5 rounded-lg transition-all duration-150 cursor-pointer ${
            text.trim()
              ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm'
              : 'bg-muted text-muted-foreground/40 cursor-not-allowed'
          }`}
          title="Send to Mastermind"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
