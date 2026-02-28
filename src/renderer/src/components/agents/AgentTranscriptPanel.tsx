import { useRef, useEffect, useState, useMemo } from 'react'
import { StopCircle, Loader2, Terminal, Send, ChevronRight, ChevronDown, Wrench, AlertTriangle, CheckCircle2, Circle, Clock, RotateCcw, Code2, Eye, ListTodo } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Markdown } from '@/components/ui/Markdown'
import type { AgentMessage } from '@/hooks/use-agent-session'

enum ViewMode {
  MARKDOWN = 'markdown',
  RAW = 'raw'
}

function formatStepMeta(meta: NonNullable<AgentMessage['stepMeta']>): string {
  const parts: string[] = []
  if (meta.durationMs != null) {
    const sec = (meta.durationMs / 1000).toFixed(1)
    parts.push(`${sec}s`)
  }
  if (meta.tokens) {
    const t = meta.tokens
    const items = [`in:${t.input}`, `out:${t.output}`]
    if (t.cache) items.push(`cache:${t.cache}`)
    parts.push(items.join(' '))
  }
  return parts.join(' · ')
}

/**
 * Truncates large content (like base64 data) for display
 */
function sanitizeToolContent(content: any): string {
  // Handle null/undefined
  if (content == null) {
    return ''
  }

  // Handle objects (like image data from Read tool)
  if (typeof content === 'object') {
    // Check if it's an image object
    if (content.type === 'image' && content.source) {
      const dataLength = content.source.data?.length || 0
      return `[Image content: ${dataLength} characters of base64 data]`
    }
    // For other objects, stringify but truncate
    const stringified = JSON.stringify(content, null, 2)
    if (stringified.length > 1000) {
      return `[Object: ${stringified.substring(0, 1000)}...]`
    }
    return stringified
  }

  // Convert to string if not already
  const str = String(content)
  const MAX_DISPLAY_LENGTH = 5000 // Max chars to display

  if (str.length <= MAX_DISPLAY_LENGTH) {
    return str
  }

  // Check if it looks like base64 data
  const base64Chars = (str.match(/[A-Za-z0-9+/=]/g) || []).length
  const isLikelyBase64 = base64Chars / str.length > 0.9

  if (isLikelyBase64) {
    return `[Binary content: ${str.length} characters]`
  }

  return str.substring(0, MAX_DISPLAY_LENGTH) + `\n\n... (${str.length - MAX_DISPLAY_LENGTH} more characters)`
}

interface AgentTranscriptPanelProps {
  title?: string
  messages: AgentMessage[]
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
  onStop: () => void
  onRestart?: () => void
  onSend?: (message: string) => void
  className?: string
}

function QuestionMessage({ message, onAnswer }: { message: AgentMessage; onAnswer?: (answer: string) => void }) {
  const questions = message.tool?.questions || []
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [textInputs, setTextInputs] = useState<Record<number, string>>({})
  const [submitted, setSubmitted] = useState(false)

  const handleSelect = (qi: number, optionLabel: string) => {
    if (submitted) return
    setAnswers(prev => ({ ...prev, [qi]: optionLabel }))
  }

  const handleTextChange = (qi: number, value: string) => {
    if (submitted) return
    setTextInputs(prev => ({ ...prev, [qi]: value }))
    setAnswers(prev => ({ ...prev, [qi]: value }))
  }

  const allAnswered = questions.every((_, qi) => answers[qi]?.trim())

  const handleSubmit = () => {
    if (!allAnswered || submitted) return
    setSubmitted(true)
    // Format: single answer for 1 question, JSON for multiple
    if (questions.length === 1) {
      onAnswer?.(answers[0])
    } else {
      const formatted = questions.map((q, qi) => `${q.header || q.question}: ${answers[qi]}`).join('\n')
      onAnswer?.(formatted)
    }
  }

  return (
    <div className="rounded-md bg-[#161b22] border border-primary/30 overflow-hidden">
      {questions.map((q, qi) => {
        const hasOptions = q.options && q.options.length > 0
        return (
          <div key={qi} className="px-4 py-3 space-y-2.5">
            {q.header && <span className="text-[10px] text-primary font-medium uppercase tracking-wide">{q.header}</span>}
            <p className="text-xs text-foreground">{q.question}</p>
            {hasOptions ? (
              <div className="space-y-1.5">
                {q.options.map((opt, oi) => {
                  const isSelected = answers[qi] === opt.label
                  return (
                    <button
                      key={oi}
                      onClick={() => handleSelect(qi, opt.label)}
                      disabled={submitted}
                      className={`w-full text-left rounded px-3 py-2 text-xs transition-colors border ${
                        isSelected
                          ? 'bg-primary/20 border-primary/50 text-foreground'
                          : submitted
                            ? 'border-border/30 text-muted-foreground opacity-50 cursor-default'
                            : 'border-border/50 hover:bg-white/5 hover:border-border text-gray-300 cursor-pointer'
                      }`}
                    >
                      <span className="font-medium">{opt.label}</span>
                      {opt.description && (
                        <span className="block text-[11px] text-muted-foreground mt-0.5">{opt.description}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            ) : (
              <input
                type="text"
                value={textInputs[qi] || ''}
                onChange={(e) => handleTextChange(qi, e.target.value)}
                disabled={submitted}
                placeholder="Type your answer..."
                className="w-full bg-background border border-border/50 rounded px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
                onKeyDown={(e) => { if (e.key === 'Enter' && allAnswered) handleSubmit() }}
              />
            )}
          </div>
        )
      })}
      {!submitted && (
        <div className="px-4 py-3 border-t border-border/30">
          <button
            onClick={handleSubmit}
            disabled={!allAnswered}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
              allAnswered
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer'
                : 'bg-muted text-muted-foreground cursor-not-allowed'
            }`}
          >
            Submit
          </button>
        </div>
      )}
      <div className="px-4 pb-2">
        <span className="text-[10px] text-muted-foreground">{message.timestamp.toLocaleTimeString()}</span>
      </div>
    </div>
  )
}

function TodoWriteMessage({ message }: { message: AgentMessage }) {
  const todos = message.tool?.todos || []
  const completed = todos.filter((t) => t.status === 'completed').length

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0" />
      case 'in_progress': return <Clock className="h-3.5 w-3.5 text-yellow-400 shrink-0" />
      default: return <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    }
  }

  return (
    <div className="rounded-md bg-[#161b22] border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/30">
        <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Tasks</span>
        <span className="text-[10px] text-muted-foreground ml-auto">{completed}/{todos.length} done</span>
      </div>
      <div className="px-3 py-2 space-y-1">
        {todos.map((todo) => (
          <div
            key={todo.id}
            className={`flex items-start gap-2.5 rounded px-2 py-1.5 text-xs ${
              todo.status === 'completed' ? 'opacity-60' : ''
            }`}
          >
            {statusIcon(todo.status)}
            <span className={`${todo.status === 'completed' ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
              {todo.content}
            </span>
          </div>
        ))}
      </div>
      <div className="px-4 pb-2">
        <span className="text-[10px] text-muted-foreground">{message.timestamp.toLocaleTimeString()}</span>
      </div>
    </div>
  )
}

function ToolCallMessage({ message }: { message: AgentMessage }) {
  const [expanded, setExpanded] = useState(false)
  const tool = message.tool!
  const statusColor = tool.status === 'completed' ? 'text-green-400'
    : tool.status === 'error' ? 'text-red-400'
    : 'text-yellow-400'

  return (
    <div className="rounded-md bg-[#161b22] border border-border/50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono hover:bg-white/5 transition-colors"
      >
        <ChevronRight className={`h-3 w-3 text-muted-foreground shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-foreground">{tool.name}</span>
        {tool.title && <span className="text-muted-foreground truncate">— {tool.title}</span>}
        <span className={`ml-auto text-[10px] shrink-0 ${statusColor}`}>{tool.status}</span>
      </button>
      {expanded && (
        <div className="border-t border-border/30 px-3 py-2 text-[11px] font-mono space-y-2">
          {tool.input && (
            <div>
              <span className="text-muted-foreground">Input:</span>
              <pre className="mt-0.5 text-gray-400 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{sanitizeToolContent(tool.input)}</pre>
            </div>
          )}
          {tool.output && (
            <div>
              <span className="text-muted-foreground">Output:</span>
              <pre className="mt-0.5 text-gray-400 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{sanitizeToolContent(tool.output)}</pre>
            </div>
          )}
          {tool.error && (
            <div>
              <span className="text-red-400">Error:</span>
              <pre className="mt-0.5 text-red-300 whitespace-pre-wrap break-words">{tool.error}</pre>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 px-3 pb-1.5">
        <span className="text-[10px] text-muted-foreground">{message.timestamp.toLocaleTimeString()}</span>
        {message.stepMeta && (
          <span className="text-[10px] text-muted-foreground">{formatStepMeta(message.stepMeta)}</span>
        )}
      </div>
    </div>
  )
}

function MessageBubble({ message, onAnswer, viewMode }: { message: AgentMessage; onAnswer?: (answer: string) => void; viewMode?: ViewMode }) {
  if (message.partType === 'question' && message.tool?.questions) {
    return <QuestionMessage message={message} onAnswer={onAnswer} />
  }

  if (message.partType === 'todowrite' && message.tool?.todos) {
    return <TodoWriteMessage message={message} />
  }

  if (message.partType === 'tool' && message.tool) {
    return <ToolCallMessage message={message} />
  }

  // Step markers are absorbed into message stepMeta — skip if any slip through
  if (message.partType === 'step-start' || message.partType === 'step-finish') {
    return null
  }

  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const isReasoning = message.partType === 'reasoning'
  const isError = message.partType === 'error' || message.partType === 'retry'

  return (
    <div className={`flex gap-2 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[90%] rounded-md px-3 py-2 ${
          isError
            ? 'bg-red-500/10 text-red-200 border border-red-500/20'
            : isUser
              ? 'bg-primary/20 text-foreground'
              : isSystem
                ? 'bg-yellow-500/10 text-yellow-200'
                : isReasoning
                  ? 'bg-purple-500/10 text-purple-200 border border-purple-500/20'
                  : 'bg-[#161b22] text-gray-300 border border-border/50'
        }`}
      >
        {isError && (
          <span className="text-[10px] text-red-400 flex items-center gap-1 mb-1">
            <AlertTriangle className="h-3 w-3" /> Error
          </span>
        )}
        {isReasoning && <span className="text-[10px] text-purple-400 block mb-1">Thinking</span>}
        {viewMode === ViewMode.MARKDOWN ? (
          <Markdown size="xs">{message.content}</Markdown>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">
            {message.content}
          </pre>
        )}
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] text-muted-foreground">{message.timestamp.toLocaleTimeString()}</span>
          {message.stepMeta && (
            <span className="text-[10px] text-muted-foreground">{formatStepMeta(message.stepMeta)}</span>
          )}
        </div>
      </div>
    </div>
  )
}

function TodoSummary({ todos }: { todos: NonNullable<AgentMessage['tool']>['todos'] }) {
  const [expanded, setExpanded] = useState(true)
  if (!todos || todos.length === 0) return null

  const completed = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.filter((t) => t.status === 'in_progress').length

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
      case 'in_progress': return <Clock className="h-3 w-3 text-yellow-400 shrink-0 animate-pulse" />
      default: return <Circle className="h-3 w-3 text-muted-foreground shrink-0" />
    }
  }

  return (
    <div className="border-b border-border/50 shrink-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-white/5 transition-colors"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        }
        <ListTodo className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground font-medium">Tasks</span>
        <span className="text-muted-foreground ml-auto tabular-nums">
          {completed}/{todos.length}
          {inProgress > 0 && <span className="text-yellow-400 ml-1.5">({inProgress} active)</span>}
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-2.5 space-y-0.5">
          {todos.map((todo) => (
            <div
              key={todo.id}
              className={`flex items-start gap-2 rounded px-2 py-1 text-xs ${
                todo.status === 'completed' ? 'opacity-50' : ''
              }`}
            >
              {statusIcon(todo.status)}
              <span className={todo.status === 'completed' ? 'line-through text-muted-foreground' : 'text-foreground'}>
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function AgentTranscriptPanel({ title = 'Agent transcript', messages, status, onStop, onRestart, onSend, className }: AgentTranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [viewMode, setViewMode] = useState<ViewMode>(ViewMode.MARKDOWN)

  // Find the latest todowrite message to show as a pinned summary
  const latestTodos = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].partType === 'todowrite' && messages[i].tool?.todos?.length) {
        return messages[i].tool!.todos!
      }
    }
    return null
  }, [messages])

  // Detect if the session ended due to an error (last message is error/retry and status is idle)
  const lastErrorMessage = useMemo(() => {
    if (status !== 'idle' || messages.length === 0) return null
    const last = messages[messages.length - 1]
    if (last.partType === 'error' || last.partType === 'retry') return last
    return null
  }, [messages, status])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Use setTimeout to ensure DOM has rendered the new messages
    const timer = setTimeout(() => {
      el.scrollTop = el.scrollHeight
    }, 50)
    return () => clearTimeout(timer)
  }, [messages.length])

  const getStatusColor = () => {
    switch (status) {
      case 'working': return 'text-green-400'
      case 'error': return 'text-red-400'
      case 'waiting_approval': return 'text-yellow-400'
      default: return 'text-muted-foreground'
    }
  }

  const getStatusLabel = () => {
    switch (status) {
      case 'working': return 'Working'
      case 'error': return 'Error'
      case 'waiting_approval': return 'Waiting for approval'
      default: return 'Idle'
    }
  }

  const handleSend = () => {
    const value = inputRef.current?.value.trim()
    if (value && onSend) {
      onSend(value)
      inputRef.current!.value = ''
    }
  }

  return (
    <div className={`flex flex-col min-h-0 bg-[#0d1117] border-l border-border ${className ?? ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{title}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs flex items-center gap-1 ${getStatusColor()}`}>
            {status === 'working' && <Loader2 className="h-3 w-3 animate-spin" />}
            {getStatusLabel()}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setViewMode(viewMode === ViewMode.MARKDOWN ? ViewMode.RAW : ViewMode.MARKDOWN)}
              className="h-7 px-2"
              title={viewMode === ViewMode.MARKDOWN ? 'Show raw content' : 'Show markdown'}
            >
              {viewMode === ViewMode.MARKDOWN ? <Code2 className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
            {onRestart && messages.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onRestart}
                className="h-7 px-2"
                title="Restart session"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
            {(status === 'working' || status === 'waiting_approval') && (
              <Button variant="ghost" size="sm" onClick={onStop} className="h-7 px-2" title="Stop session">
                <StopCircle className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Error banner */}
      {lastErrorMessage && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 shrink-0">
          <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
          <span className="text-xs text-red-300 truncate">{lastErrorMessage.content}</span>
        </div>
      )}

      {/* Pinned todo summary */}
      {latestTodos && <TodoSummary todos={latestTodos} />}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto p-4 font-mono text-sm space-y-2"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-xs">
            {status === 'working' ? (
              <>
                <Loader2 className="h-8 w-8 mb-3 animate-spin opacity-30" />
                <p>Agent is starting...</p>
              </>
            ) : (
              <>
                <Terminal className="h-8 w-8 mb-2 opacity-20" />
                <p>No messages yet</p>
              </>
            )}
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} onAnswer={onSend} viewMode={viewMode} />
            ))}
            {status === 'working' && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Agent is working...
              </div>
            )}
          </>
        )}
      </div>

      {/* Input + Footer */}
      <div className="border-t border-border/50 shrink-0">
        {onSend && (
          <div className="flex items-center gap-2 px-4 py-2">
            <input
              ref={inputRef}
              type="text"
              placeholder="Send a message..."
              className="flex-1 bg-transparent border border-border/50 rounded px-3 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/30"
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            />
            <Button variant="ghost" size="icon" onClick={handleSend} className="h-7 w-7">
              <Send className="h-3 w-3" />
            </Button>
          </div>
        )}
        <div className="px-4 py-2 text-[10px] text-muted-foreground font-mono">
          {messages.length} message{messages.length !== 1 ? 's' : ''}
        </div>
      </div>
    </div>
  )
}
