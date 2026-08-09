import { useState, useEffect, useCallback, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useAgentSession } from '@/hooks/use-agent-session'
import { agentApi, settingsApi } from '@/lib/ipc-client'
import type { Agent } from '@/types'

const MASTERMIND_SESSION_ID = 'mastermind-session'

/** Start the agent at app start, so the first sentence does not wait for it. */
export const MASTERMIND_PREWARM_SETTING = 'mastermind_prewarm'

interface OrchestratorPanelProps {
  onClose: () => void
}

export function OrchestratorPanel({ onClose }: OrchestratorPanelProps) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const { start, stop, sendMessage, approve } = useAgentSession(MASTERMIND_SESSION_ID)
  const currentSession = useAgentStore((state) => state.sessions.get(MASTERMIND_SESSION_ID))
  const removeSession = useAgentStore((state) => state.removeSession)
  /** The start in flight, shared so a message can wait for it instead of racing. */
  const startingRef = useRef<Promise<void> | null>(null)
  const selectedAgentIdRef = useRef<string | null>(null)
  selectedAgentIdRef.current = selectedAgentId
  const [prewarm, setPrewarm] = useState(false)

  // Read the preference before warming anything: a user who switched this off
  // must not get an agent process on every launch.
  useEffect(() => {
    let cancelled = false
    settingsApi
      .get(MASTERMIND_PREWARM_SETTING)
      .then((value) => {
        if (!cancelled) setPrewarm(value !== 'false')
      })
      .catch(() => {
        if (!cancelled) setPrewarm(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Load agents on mount
  useEffect(() => {
    agentApi.getAll().then((allAgents) => {
      setAgents(allAgents)
      // Select default agent or first available
      const defaultAgent = allAgents.find((a) => a.is_default) || allAgents[0]
      if (defaultAgent) {
        setSelectedAgentId(defaultAgent.id)
      }
    })
  }, [])

  // Switch agent. The new choice is recorded before the old session is
  // stopped, or the warm-up would race in and start the old agent again.
  const handleAgentChange = async (newAgentId: string) => {
    selectedAgentIdRef.current = newAgentId
    setSelectedAgentId(newAgentId)
    if (currentSession?.sessionId) {
      await stop()
      removeSession(MASTERMIND_SESSION_ID)
    }
  }

  /**
   * Brings up the session, or joins the one already starting.
   *
   * Starting an agent takes seconds, so it is done ahead of time (see the
   * warm-up below). That creates a window where a message can arrive while the
   * session is still coming up: without the shared promise the message would be
   * dropped, because there is no session yet and one is already being made.
   */
  const ensureSession = useCallback(async (): Promise<boolean> => {
    const live = useAgentStore.getState().sessions.get(MASTERMIND_SESSION_ID)
    if (live?.sessionId) return true

    const agentId = selectedAgentIdRef.current
    if (!agentId) return false

    if (!startingRef.current) {
      startingRef.current = (async () => {
        // Clean up any old session data first
        removeSession(MASTERMIND_SESSION_ID)
        // skipInitialPrompt keeps the agent quiet until the user speaks.
        await start(agentId, MASTERMIND_SESSION_ID, undefined, true)
        // Small delay to ensure session is fully initialized
        await new Promise((resolve) => setTimeout(resolve, 100))
      })().finally(() => {
        startingRef.current = null
      })
    }

    try {
      await startingRef.current
      return Boolean(useAgentStore.getState().sessions.get(MASTERMIND_SESSION_ID)?.sessionId)
    } catch (err) {
      console.error('Failed to start mastermind session:', err)
      return false
    }
  }, [start, removeSession])

  // Send message - the session is usually warm already, so this just sends.
  const handleSendMessage = useCallback(
    async (message: string) => {
      if (!(await ensureSession())) return

      // Question answers should use approve() instead of sendMessage()
      const live = useAgentStore.getState().sessions.get(MASTERMIND_SESSION_ID)
      const messages = live?.messages || []
      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.partType === 'question' && lastMessage?.tool?.questions) {
        await approve(true, message)
      } else {
        await sendMessage(message)
      }
    },
    [ensureSession, sendMessage, approve]
  )

  /**
   * Start the agent in the background, before there is anything to say.
   *
   * The panel is mounted for the whole life of the window, so this runs at
   * app start. It costs one idle agent process and saves the seconds a user
   * would otherwise wait after their first sentence — which is most of the
   * delay when talking to Mastermind by voice.
   *
   * Switched off in Settings → General for anyone who does not want the
   * process. Failure is silent: the first message starts the session as before.
   */
  useEffect(() => {
    if (!prewarm || !selectedAgentId || currentSession?.sessionId) return
    void ensureSession()
  }, [prewarm, selectedAgentId, currentSession?.sessionId, ensureSession])

  // Listen for pre-fill messages from the dashboard command input
  useEffect(() => {
    const handlePrefill = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.message && typeof detail.message === 'string') {
        // Small delay to ensure the panel is mounted and agent is selected
        setTimeout(() => {
          handleSendMessage(detail.message)
        }, 200)
      }
    }
    window.addEventListener('mastermind-prefill', handlePrefill)
    return () => window.removeEventListener('mastermind-prefill', handlePrefill)
  }, [handleSendMessage])

  return (
    <div className="h-full flex flex-col bg-background border-l border-border">
      {/* Header with agent selector */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        {/* A warm session is not a conversation: the choice stays open until
            something has actually been said. */}
        <select
          value={selectedAgentId || ''}
          onChange={(e) => handleAgentChange(e.target.value)}
          className="text-xs bg-background border border-border rounded px-2 py-1 cursor-pointer hover:border-primary/50 transition-colors"
          disabled={(currentSession?.messages?.length ?? 0) > 0}
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>

        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Chat interface */}
      {selectedAgentId && (
        <AgentTranscriptPanel
          title="Mastermind den"
          messages={currentSession?.messages || []}
          status={currentSession?.status || SessionStatus.IDLE}
          systemStatus={currentSession?.systemStatus}
          onStop={stop}
          onSend={handleSendMessage}
          className="flex-1 min-h-0"
          sessionId={currentSession?.sessionId}
          pendingApproval={currentSession?.pendingApproval ?? undefined}
          pendingSend={currentSession?.pendingSend}
        />
      )}

      {!selectedAgentId && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          No agent selected
        </div>
      )}
    </div>
  )
}
