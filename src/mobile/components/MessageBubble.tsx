import { useState } from 'react'
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
    <div className="rounded-lg bg-muted border border-primary/30 overflow-hidden">
      {questions.map((q, qi) => (
        <div key={qi} className="px-3 py-2 space-y-2">
          {q.header && <span className="text-[10px] text-primary font-medium uppercase tracking-wide">{q.header}</span>}
          <p className="text-xs text-foreground">{q.question}</p>
          {q.options?.length > 0 && (
            <div className="space-y-1">
              {q.options.map((opt, oi) => {
                const isSelected = answers[qi] === opt.label
                return (
                  <button
                    key={oi}
                    onClick={() => !submitted && setAnswers(prev => ({ ...prev, [qi]: opt.label }))}
                    disabled={submitted}
                    className={`w-full text-left px-3 py-2 rounded text-xs transition-colors ${
                      isSelected
                        ? 'bg-primary/20 border border-primary/50 text-primary'
                        : 'bg-background/50 border border-border/50 text-foreground hover:bg-accent'
                    } ${submitted ? 'opacity-60' : ''}`}
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
        <div className="px-3 py-2 border-t border-border/30">
          <button
            onClick={handleSubmit}
            className="w-full bg-primary text-primary-foreground text-xs font-medium py-2 rounded-lg active:opacity-80"
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
    <div className="rounded-lg bg-muted border border-border/50 px-3 py-2 space-y-1">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Tasks</div>
      {todos.map((t) => (
        <div key={t.id} className="flex items-center gap-2 text-xs">
          <span className={`w-3 h-3 rounded-full border shrink-0 flex items-center justify-center text-[8px] ${
            t.status === 'completed' ? 'bg-emerald-400/20 border-emerald-400 text-emerald-400' :
            t.status === 'in_progress' ? 'bg-amber-400/20 border-amber-400 text-amber-400' :
            'border-muted-foreground'
          }`}>
            {t.status === 'completed' && '\u2713'}
            {t.status === 'in_progress' && '\u25CF'}
          </span>
          <span className={t.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'}>
            {t.content}
          </span>
        </div>
      ))}
    </div>
  )
}

function ToolCallMessage({ message }: { message: AgentMessage }) {
  const [expanded, setExpanded] = useState(false)
  const tool = message.tool!
  const statusIcon = tool.status === 'succeeded' ? '\u2713' : tool.status === 'failed' ? '\u2717' : '\u25CF'
  const statusColor = tool.status === 'succeeded' ? 'text-emerald-400' : tool.status === 'failed' ? 'text-red-400' : 'text-amber-400'

  return (
    <div className="rounded-lg border border-border/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground active:bg-accent/30"
      >
        <span className={statusColor}>{statusIcon}</span>
        <span className="font-mono font-medium text-foreground/80">{tool.name}</span>
        {tool.title && <span className="truncate">{tool.title}</span>}
        <span className="ml-auto text-muted-foreground">{expanded ? '\u25B2' : '\u25BC'}</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-border/30 space-y-2 text-xs font-mono">
          {tool.input && (
            <div>
              <div className="text-muted-foreground mb-0.5">Input</div>
              <pre className="bg-background/50 rounded p-2 overflow-x-auto text-[10px] max-h-40 overflow-y-auto whitespace-pre-wrap">{tool.input}</pre>
            </div>
          )}
          {tool.output && (
            <div>
              <div className="text-muted-foreground mb-0.5">Output</div>
              <pre className="bg-background/50 rounded p-2 overflow-x-auto text-[10px] max-h-40 overflow-y-auto whitespace-pre-wrap">{tool.output}</pre>
            </div>
          )}
          {tool.error && (
            <div>
              <div className="text-red-400 mb-0.5">Error</div>
              <pre className="bg-red-500/10 rounded p-2 text-red-300 text-[10px] whitespace-pre-wrap">{tool.error}</pre>
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

  // Regular text message
  const isUser = message.role === 'user'
  const isError = message.partType === 'error'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
        isUser
          ? 'bg-primary/20 text-foreground'
          : isError
            ? 'bg-red-500/10 text-red-300'
            : 'bg-muted text-foreground'
      }`}>
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
        {message.stepMeta && (
          <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
            {message.stepMeta.durationMs && <span>{(message.stepMeta.durationMs / 1000).toFixed(1)}s</span>}
            {message.stepMeta.tokens && (
              <span>{message.stepMeta.tokens.input + message.stepMeta.tokens.output} tokens</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
