import { useState } from 'react'
import { cn } from '../lib/utils'
import type { AgentMessage } from '../stores/agent-store'

function QuestionMessage({ message, onAnswer }: { message: AgentMessage; onAnswer?: (answer: string) => void }) {
  const questions = message.tool?.questions || []
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [submitted, setSubmitted] = useState(false)

  const allAnswered = questions.every((_, qi) => answers[qi]?.trim())

  const handleSubmit = () => {
    if (!allAnswered || submitted) return
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
                    onClick={() => !submitted && setAnswers(prev => ({ ...prev, [qi]: opt.label }))}
                    disabled={submitted}
                    className={cn(
                      'w-full text-left rounded px-3 py-2 text-xs transition-colors border',
                      isSelected
                        ? 'bg-primary/20 border-primary/50 text-foreground'
                        : 'border-border/50 hover:bg-white/5 hover:border-border text-gray-300',
                      submitted && 'opacity-50 cursor-default'
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
      {!submitted && allAnswered && (
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

function ToolCallMessage({ message }: { message: AgentMessage }) {
  const [expanded, setExpanded] = useState(false)
  const tool = message.tool!

  const statusColor = tool.status === 'succeeded' || tool.status === 'completed'
    ? 'text-green-400'
    : tool.status === 'failed' || tool.status === 'error'
      ? 'text-red-400'
      : 'text-yellow-400'

  return (
    <div className="rounded-md bg-[#161b22] border border-border/50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 font-mono text-xs hover:bg-white/5 transition-colors"
      >
        <svg className="h-3 w-3 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span className="text-foreground font-medium">{tool.name}</span>
        {tool.title && <span className="text-muted-foreground truncate">{tool.title}</span>}
        <span className={cn('text-[10px] ml-auto shrink-0', statusColor)}>
          {tool.status}
        </span>
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

interface MessageBubbleProps {
  message: AgentMessage
  onAnswer?: (answer: string) => void
}

export function MessageBubble({ message, onAnswer }: MessageBubbleProps) {
  // Question
  if (message.partType === 'question' && message.tool?.questions) {
    return <QuestionMessage message={message} onAnswer={onAnswer} />
  }

  // Todo list
  if (message.partType === 'todowrite' && message.tool?.todos) {
    return <TodoList message={message} />
  }

  // Tool call
  if (message.partType === 'tool' && message.tool) {
    return <ToolCallMessage message={message} />
  }

  // Step markers — skip
  if (message.partType === 'step-start' || message.partType === 'step-finish') return null

  // Regular text message — matches desktop AgentTranscriptPanel exactly
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const isError = message.partType === 'error'
  const isReasoning = message.partType === 'reasoning'

  return (
    <div className={cn('flex gap-2', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn(
        'max-w-[90%] rounded-md px-3 py-2',
        isUser && 'bg-primary/20 text-foreground',
        isSystem && !isError && 'bg-yellow-500/10 text-yellow-200',
        isError && 'bg-red-500/10 text-red-200 border border-red-500/20',
        isReasoning && 'bg-purple-500/10 text-purple-200 border border-purple-500/20',
        !isUser && !isSystem && !isError && !isReasoning && 'bg-[#161b22] text-gray-300 border border-border/50'
      )}>
        <div className="whitespace-pre-wrap break-words font-mono text-xs">{message.content}</div>
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
