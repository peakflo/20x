import { useRef, useEffect } from 'react'
import { StopCircle, Loader2, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { AgentMessage } from '@/hooks/use-agent-session'

interface AgentTranscriptPanelProps {
  messages: AgentMessage[]
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
  onStop: () => void
  className?: string
}

export function AgentTranscriptPanel({ messages, status, onStop, className }: AgentTranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const getStatusColor = () => {
    switch (status) {
      case 'working':
        return 'text-green-400'
      case 'error':
        return 'text-red-400'
      case 'waiting_approval':
        return 'text-yellow-400'
      default:
        return 'text-muted-foreground'
    }
  }

  const getStatusLabel = () => {
    switch (status) {
      case 'working':
        return 'Working'
      case 'error':
        return 'Error'
      case 'waiting_approval':
        return 'Waiting for approval'
      default:
        return 'Idle'
    }
  }

  return (
    <div className={`flex flex-col h-full bg-[#0d1117] border-l border-border ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Agent Transcript</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={`text-xs ${getStatusColor()}`}>
              {status === 'working' && <Loader2 className="h-3 w-3 inline animate-spin mr-1" />}
              {getStatusLabel()}
            </span>
          </div>
          {status === 'working' && (
            <Button variant="ghost" size="sm" onClick={onStop} className="h-7 px-2">
              <StopCircle className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-sm space-y-3"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-xs">
            <Terminal className="h-8 w-8 mb-2 opacity-20" />
            <p>No messages yet</p>
            <p className="mt-1">Agent will start working soon...</p>
          </div>
        ) : (
          messages.map((message, index) => (
            <div
              key={message.id || index}
              className={`flex gap-2 ${
                message.role === 'user'
                  ? 'justify-end'
                  : 'justify-start'
              }`}
            >
              <div
                className={`max-w-[90%] rounded-md px-3 py-2 ${
                  message.role === 'user'
                    ? 'bg-primary/20 text-foreground'
                    : message.role === 'system'
                    ? 'bg-yellow-500/10 text-yellow-200'
                    : 'bg-[#161b22] text-gray-300 border border-border/50'
                }`}
              >
                <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                  {message.content}
                </pre>
                <span className="text-[10px] text-muted-foreground mt-1 block">
                  {message.timestamp.toLocaleTimeString()}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-border/50 text-[10px] text-muted-foreground font-mono">
        {messages.length} message{messages.length !== 1 ? 's' : ''}
      </div>
    </div>
  )
}
