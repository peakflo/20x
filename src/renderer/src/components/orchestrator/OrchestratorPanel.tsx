import { useState, useEffect, useCallback, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { useAgentStore } from '@/stores/agent-store'
import { useAgentSession } from '@/hooks/use-agent-session'
import { agentApi } from '@/lib/ipc-client'
import type { Agent } from '@/types'

const MASTERMIND_SESSION_ID = 'mastermind-session'

interface OrchestratorPanelProps {
  onClose: () => void
}

export function OrchestratorPanel({ onClose }: OrchestratorPanelProps) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const { start, stop, sendMessage } = useAgentSession(MASTERMIND_SESSION_ID)
  const getSession = useAgentStore((state) => state.getSession)
  const removeSession = useAgentStore((state) => state.removeSession)
  const currentSession = getSession(MASTERMIND_SESSION_ID)
  const startingRef = useRef(false)

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

  // Switch agent
  const handleAgentChange = async (newAgentId: string) => {
    if (currentSession?.sessionId) {
      await stop()
    }
    setSelectedAgentId(newAgentId)
  }

  // Send message - start session if needed
  const handleSendMessage = useCallback(
    async (message: string) => {
      if (!selectedAgentId) return

      // Start session on first message if not already started
      if (!currentSession?.sessionId && !startingRef.current) {
        startingRef.current = true
        try {
          // Clean up any old session data first
          removeSession(MASTERMIND_SESSION_ID)

          // Start new session with skipInitialPrompt to prevent auto-sent message
          await start(selectedAgentId, MASTERMIND_SESSION_ID, undefined, true)

          // Small delay to ensure session is fully initialized
          await new Promise(resolve => setTimeout(resolve, 100))

          // Send the message after session starts
          await sendMessage(message)
        } catch (err) {
          console.error('Failed to start mastermind session:', err)
        } finally {
          startingRef.current = false
        }
      } else if (currentSession?.sessionId) {
        // Session already exists, just send the message
        await sendMessage(message)
      }
    },
    [selectedAgentId, currentSession, start, sendMessage, removeSession]
  )

  return (
    <div className="h-full flex flex-col bg-background border-l border-border">
      {/* Header with agent selector */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <select
          value={selectedAgentId || ''}
          onChange={(e) => handleAgentChange(e.target.value)}
          className="text-xs bg-background border border-border rounded px-2 py-1 cursor-pointer hover:border-primary/50 transition-colors"
          disabled={!!currentSession?.sessionId}
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
          messages={currentSession?.messages || []}
          status={currentSession?.status || 'idle'}
          onStop={stop}
          onSend={handleSendMessage}
          className="flex-1 min-h-0"
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
