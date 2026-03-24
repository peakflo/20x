import { useState } from 'react'
import { Markdown } from '@/components/ui/Markdown'
import { cn } from '../lib/utils'
import type { AgentMessage } from '../stores/agent-store'

function QuestionMessage({ message, onAnswer, canAnswer }: { message: AgentMessage; onAnswer?: (answer: string) => void; canAnswer: boolean }) {
  const questions = message.tool?.questions || []
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [submitted, setSubmitted] = useState(false)
  const isLocked = submitted || !canAnswer

  const allAnswered = questions.every((_, qi) => answers[qi]?.trim())

  const handleSubmit = () => {
    if (!allAnswered || isLocked) return
    setSubmitted(true)
    if (questions.length === 1) {
      onAnswer?.(answers[0])
    } else {
      const formatted = questions.map((q, qi) => `${q.header || q.question}: ${answers[qi]}`).join('\n')
      onAnswer?.(formatted)
    }
  }

  return (
    <div className="rounded-md bg-[#161b22] border border-primary/30 overflow-hidden">
      {questions.map((q, qi) => (
        <div key={qi} className="space-y-2">
          {q.header && (
            <div className="px-4 py-2 border-b border-border/30">
              <span className="text-[10px] text-primary font-medium uppercase tracking-wide">{q.header}</span>
            </div>
          )}
          <div className="px-4 py-3">
            <p className="text-xs text-foreground">{q.question}</p>
          </div>
          {q.options?.length > 0 && (
            <div className="px-4 pb-3 space-y-1.5">
              {q.options.map((opt, oi) => {
                const isSelected = answers[qi] === opt.label
                return (
                  <button
                    key={oi}
                    onClick={() => !isLocked && setAnswers(prev => ({ ...prev, [qi]: opt.label }))}
                    disabled={isLocked}
                    className={cn(
                      'w-full text-left rounded px-3 py-2 text-xs transition-colors border',
                      isSelected
                        ? 'bg-primary/20 border-primary/50 text-foreground'
                        : 'border-border/50 hover:bg-white/5 hover:border-border text-gray-300',
                      isLocked && 'opacity-50 cursor-default'
                    )}
                  >
                    <div className="font-medium">{opt.label}</div>
                    {opt.description && <div className="text-muted-foreground mt-0.5">{opt.description}</div>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ))}
      {!isLocked && allAnswered && (
        <div className="px-4 py-2.5 border-t border-border/30">
          <button
            onClick={handleSubmit}
            className="w-full bg-primary text-primary-foreground text-xs font-medium py-2 rounded-md active:opacity-80"
          >
            Submit
          </button>
        </div>
      )}
    </div>
  )
}

function TodoList({ message }: { message: AgentMessage }) {
  const todos = message.tool?.todos || []
  return (
    <div className="rounded-md bg-[#161b22] border border-border/50 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border/30">
        <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Tasks</span>
      </div>
      <div className="px-2 py-2 space-y-1">
        {todos.map((t) => (
          <div key={t.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
            {t.status === 'completed' && (
              <svg className="h-3.5 w-3.5 text-green-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></svg>
            )}
            {t.status === 'in_progress' && (
              <svg className="h-3.5 w-3.5 text-yellow-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
            )}
            {t.status === 'pending' && (
              <svg className="h-3.5 w-3.5 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /></svg>
            )}
            <span className={cn(
              t.status === 'completed' && 'opacity-60 line-through text-muted-foreground',
              t.status !== 'completed' && 'text-foreground'
            )}>
              {t.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PlanReviewMessage({ message }: { message: AgentMessage }) {
  const tool = message.tool
  const label = tool?.title || message.content || 'Plan mode'
  const rawOutput = tool?.output || ''
  // Filter out confirmation prompts — not useful content
  const details = /^(exit|enter) plan mode\??$/i.test(rawOutput.trim()) ? '' : rawOutput

  return (
    <div className="rounded-md bg-[#161b22] border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 font-mono text-xs">
        {/* FileText icon */}
        <svg className="h-3 w-3 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>
        </svg>
        <span className="text-foreground">{label}</span>
      </div>
      {details && (
        <div className="px-3 py-2 border-t border-border/30 max-h-[50vh] overflow-y-auto">
          <div className="break-words">
            <Markdown size="xs">{details}</Markdown>
          </div>
        </div>
      )}
    </div>
  )
}

function deriveToolSubtitle(tool?: AgentMessage['tool']): string {
  if (!tool) return ''
  if (tool.title) return tool.title

  if (tool.name === 'command' && typeof tool.input === 'string') {
    const firstLine = tool.input.split('\n').map((line) => line.trim()).find(Boolean)
    return firstLine ? firstLine.slice(0, 120) : ''
  }

  return ''
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

function TaskProgressMessage({ message }: { message: AgentMessage }) {
  const [expanded, setExpanded] = useState(false)
  const tp = message.taskProgress!
  const isRunning = tp.status === 'started' || tp.status === 'running'
  const isError = tp.status === 'failed'
  const isDone = tp.status === 'completed'
  const isStopped = tp.status === 'stopped'

  return (
    <div className={cn(
      'rounded-md bg-[#161b22] border overflow-hidden',
      isError && 'border-red-500/30',
      isStopped && 'border-yellow-500/30',
      isRunning && 'border-blue-500/30',
      !isError && !isStopped && !isRunning && 'border-border/50'
    )}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 font-mono text-xs hover:bg-white/5 transition-colors"
      >
        {/* Terminal icon */}
        <svg className="h-3 w-3 text-blue-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" />
        </svg>
        <span className="text-foreground font-medium truncate">{tp.description || 'Subagent task'}</span>
        {tp.lastToolName && isRunning && (
          <span className="text-muted-foreground text-[10px] truncate">· {tp.lastToolName}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {tp.usage && (
            <span className="text-[10px] text-muted-foreground">
              {tp.usage.tool_uses} tools · {formatDuration(tp.usage.duration_ms)}
            </span>
          )}
          {isRunning && (
            <svg className="h-3 w-3 text-blue-400 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
          )}
          {isError && (
            <svg className="h-3 w-3 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>
            </svg>
          )}
          {isStopped && (
            <svg className="h-3 w-3 text-yellow-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
            </svg>
          )}
        </span>
        <span className={cn(
          'text-muted-foreground transition-transform text-[10px]',
          expanded && 'rotate-90'
        )}>▶</span>
      </button>
      {expanded && (
        <div className="border-t border-border/30 px-3 py-2 space-y-2">
          {tp.summary && (
            <div className="text-xs">
              <Markdown size="sm">{tp.summary}</Markdown>
            </div>
          )}
          {tp.usage && (
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-mono">
              <span>{tp.usage.tool_uses} tool uses</span>
              <span>{tp.usage.total_tokens.toLocaleString()} tokens</span>
              <span>{formatDuration(tp.usage.duration_ms)}</span>
            </div>
          )}
          {!tp.summary && !tp.usage && (
            <div className="text-[11px] text-muted-foreground">No additional details available</div>
          )}
        </div>
      )}
    </div>
  )
}

function ToolCallMessage({ message }: { message: AgentMessage }) {
  const [expanded, setExpanded] = useState(false)
  const tool = message.tool!
  const isRunning = !tool.status || tool.status === 'in_progress' || tool.status === 'running' || tool.status === 'pending'
  const isError = tool.status === 'error' || tool.status === 'failed'
  const subtitle = deriveToolSubtitle(tool)

  return (
    <div className="rounded-md bg-[#161b22] border border-border/50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 font-mono text-xs hover:bg-white/5 transition-colors"
      >
        {/* Wrench icon */}
        <svg className="h-3 w-3 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span className="text-foreground font-medium">{tool.name}</span>
        {subtitle && <span className="text-muted-foreground truncate"> {subtitle}</span>}
        {isRunning && (
          <svg className="h-3 w-3 ml-auto shrink-0 text-muted-foreground animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
        )}
        {isError && (
          <svg className="h-3 w-3 ml-auto shrink-0 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>
          </svg>
        )}
        <span className={cn(
          'text-muted-foreground transition-transform text-[10px]',
          expanded && 'rotate-90'
        )}>▶</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-border/30 space-y-2 text-[11px] font-mono">
          {tool.input && (
            <div>
              <div className="text-muted-foreground mb-0.5">Input</div>
              <pre className="bg-background/50 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap text-gray-400">{tool.input}</pre>
            </div>
          )}
          {tool.output && (
            <div>
              <div className="text-muted-foreground mb-0.5">Output</div>
              <pre className="bg-background/50 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap text-gray-400">{tool.output}</pre>
            </div>
          )}
          {tool.error && (
            <div>
              <div className="text-red-400 mb-0.5">Error</div>
              <pre className="bg-red-500/10 rounded p-2 text-red-300 whitespace-pre-wrap">{tool.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TaskNotificationMessage({ message }: { message: AgentMessage }) {
  const tool = message.tool
  const status = tool?.status || 'completed'
  const summary = tool?.output || message.content || 'Task completed'
  const isError = status === 'failed' || status === 'stopped'
  const statusColor = status === 'completed' ? 'text-green-400' : status === 'failed' ? 'text-red-400' : 'text-yellow-400'
  const borderColor = status === 'completed' ? 'border-green-500/30' : status === 'failed' ? 'border-red-500/30' : 'border-yellow-500/30'
  const bgColor = status === 'completed' ? 'bg-green-500/5' : status === 'failed' ? 'bg-red-500/5' : 'bg-yellow-500/5'

  return (
    <div className={cn('rounded-md overflow-hidden border', bgColor, borderColor)}>
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Status icon */}
        {status === 'completed' ? (
          <svg className={cn('h-4 w-4 shrink-0', statusColor)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        ) : status === 'failed' ? (
          <svg className={cn('h-4 w-4 shrink-0', statusColor)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" />
          </svg>
        ) : (
          <svg className={cn('h-4 w-4 shrink-0', statusColor)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><rect width="4" height="6" x="10" y="9" rx="1" />
          </svg>
        )}
        <span className={cn('text-xs font-medium', statusColor)}>
          Subtask {status}
        </span>
      </div>
      {summary && (
        <div className={cn('px-3 pb-2', isError ? 'text-red-200' : 'text-gray-300')}>
          <Markdown size="sm">{summary}</Markdown>
        </div>
      )}
    </div>
  )
}

interface MessageBubbleProps {
  message: AgentMessage
  onAnswer?: (answer: string) => void
  canAnswerQuestion?: boolean
}

export function MessageBubble({ message, onAnswer, canAnswerQuestion = false }: MessageBubbleProps) {
  // Question — check by data content so it renders correctly regardless of partType
  if (message.tool?.questions && message.tool.questions.length > 0) {
    return <QuestionMessage message={message} onAnswer={onAnswer} canAnswer={canAnswerQuestion} />
  }

  // Todo list — check by data content so it renders correctly regardless of partType
  if (message.tool?.todos && message.tool.todos.length > 0) {
    return <TodoList message={message} />
  }

  // Plan review
  if (message.partType === 'planreview') {
    return <PlanReviewMessage message={message} />
  }

  // Tool call — require a name to avoid rendering ghost entries with no tool name
  if (message.partType === 'tool' && message.tool?.name) {
    return <ToolCallMessage message={message} />
  }

  // Task progress — live subagent task tracking
  if (message.partType === 'task_progress' && message.taskProgress) {
    return <TaskProgressMessage message={message} />
  }

  // Task notification — subtask completion/failure/stopped
  if (message.partType === 'task-notification') {
    return <TaskNotificationMessage message={message} />
  }

  // Step markers and system status — skip (absorbed by store)
  if (message.partType === 'step-start' || message.partType === 'step-finish' || message.partType === 'system-status') return null

  // Skip tool messages that have no content and no recognizable tool name
  if (message.partType === 'tool' && !message.content) return null

  // Regular text message — matches desktop AgentTranscriptPanel exactly
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const isError = message.partType === 'error'
  const isReasoning = message.partType === 'reasoning'

  return (
    <div className={cn('flex gap-2', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn(
        'max-w-[90%] rounded-md px-3 py-2 overflow-hidden min-w-0',
        isUser && 'bg-primary/20 text-foreground',
        isSystem && !isError && 'bg-yellow-500/10 text-yellow-200',
        isError && 'bg-red-500/10 text-red-200 border border-red-500/20',
        isReasoning && 'bg-purple-500/10 text-purple-200 border border-purple-500/20',
        !isUser && !isSystem && !isError && !isReasoning && 'bg-[#161b22] text-gray-300 border border-border/50'
      )}>
        <div className="break-words min-w-0">
          <Markdown size="sm">{message.content}</Markdown>
        </div>
        {message.stepMeta && (
          <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
            {message.stepMeta.durationMs != null && <span>{(message.stepMeta.durationMs / 1000).toFixed(1)}s</span>}
            {message.stepMeta.tokens && (
              <span>{message.stepMeta.tokens.input + message.stepMeta.tokens.output} tokens</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
