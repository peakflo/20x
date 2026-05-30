import { useState, useEffect, useMemo } from 'react'
import { useAgentStore, type AgentMessage } from '@/stores/agent-store'
import { Bot, User } from 'lucide-react'

const MASTERMIND_SESSION_ID = 'mastermind-session'

const ROTATING_TITLES = [
  'What do you want to finish today?',
  'What should we tackle next?',
  'Ready to get things done?',
  'What’s on your mind?'
]

function MessageRow({ message }: { message: AgentMessage }) {
  const isAssistant = message.role === 'assistant'
  const content = message.content?.replace(/\n/g, ' ').trim()
  if (!content) return null

  return (
    <div className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
      <div className={`mt-0.5 h-6 w-6 rounded-full flex items-center justify-center shrink-0 ${
        isAssistant
          ? 'bg-primary/10 text-primary'
          : 'bg-muted text-muted-foreground'
      }`}>
        {isAssistant ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
      </div>
      <p className="text-sm text-foreground/80 line-clamp-1 leading-6 min-w-0">
        {content}
      </p>
    </div>
  )
}

interface HeroSectionProps {
  onSeeFullConversation: () => void
}

export function HeroSection({ onSeeFullConversation }: HeroSectionProps) {
  const [titleIndex, setTitleIndex] = useState(0)

  const session = useAgentStore((s) => s.sessions.get(MASTERMIND_SESSION_ID))
  const messages = session?.messages || []

  // Rotate title every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setTitleIndex((i) => (i + 1) % ROTATING_TITLES.length)
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  // Get last 3 text messages (user + assistant with content, skip tool/system messages)
  const recentMessages = useMemo(() => {
    const textMessages = messages.filter(
      (m: AgentMessage) =>
        (m.role === 'user' || m.role === 'assistant') &&
        m.content?.trim() &&
        !m.partType
    )
    return textMessages.slice(-3)
  }, [messages])

  return (
    <div className="space-y-3">
      {/* Rotating title */}
      <h1 className="text-xl font-semibold tracking-tight text-foreground transition-opacity duration-500">
        {ROTATING_TITLES[titleIndex]}
      </h1>

      {/* Recent messages */}
      {recentMessages.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card/80 px-4 py-3">
          <div className="space-y-0 divide-y divide-border/30">
            {recentMessages.map((msg: AgentMessage) => (
              <MessageRow key={msg.id} message={msg} />
            ))}
          </div>
          <button
            onClick={onSeeFullConversation}
            className="mt-3 flex items-center gap-1.5 text-xs text-foreground/60 hover:text-primary transition-colors cursor-pointer"
          >
            <span className="tracking-wider">&middot; &middot; &middot;</span>
            <span>See full conversation</span>
          </button>
        </div>
      )}
    </div>
  )
}
