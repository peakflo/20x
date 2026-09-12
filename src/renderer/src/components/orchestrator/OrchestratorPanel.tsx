import { ResponsibilitiesPanel } from './ResponsibilitiesPanel'
import { projectConversationId, type ProjectRecord } from '@shared/responsibilities'
import { useState, useEffect, useCallback, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useAgentSession } from '@/hooks/use-agent-session'
import { agentApi, agentSessionApi, settingsApi } from '@/lib/ipc-client'
import type { Agent } from '@/types'
import { useUIStore } from '@/stores/ui-store'

const MASTERMIND_SESSION_ID = 'mastermind-session'

/** Start the agent at app start, so the first sentence does not wait for it. */
export const MASTERMIND_PREWARM_SETTING = 'mastermind_prewarm'

interface OrchestratorPanelProps {
  onClose: () => void
}

export function OrchestratorPanel({ onClose }: OrchestratorPanelProps) {
  const [project, setProject] = useState<ProjectRecord | null>(null)
  return <div className="flex h-full min-h-0 flex-col gap-2">
    <ResponsibilitiesPanel onProjectChange={setProject} />
    <MastermindConversation key={project?.id ?? 'all'} project={project} onClose={onClose} />
  </div>
}

function MastermindConversation({ onClose, project }: OrchestratorPanelProps & { project: ProjectRecord | null }) {
  const draft = useUIStore(s => s.mastermindDraft)
  const clearDraft = useUIStore(s => s.clearMastermindDraft)
  const conversationId = project ? projectConversationId(project.id) : MASTERMIND_SESSION_ID
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const { start, stop, sendMessage, approve } = useAgentSession(conversationId)
  const currentSession = useAgentStore((state) => state.sessions.get(conversationId))
  const endSession = useAgentStore((state) => state.endSession)
  /** The start in flight, shared so a message can wait for it instead of racing. */
  const startingRef = useRef<Promise<void> | null>(null)
  const switchingRef = useRef<Promise<void> | null>(null)
  const mountedRef = useRef(true)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState('')
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

  // Project switches release disposable reasoning; the persisted transcript restores context.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (project) void (switchingRef.current ?? (startingRef.current ?? Promise.resolve()).then(() => agentSessionApi.stopByTaskId(conversationId))).catch(error => console.error('Could not release project conversation', error))
    }
  }, [conversationId])

  // Load agents on mount
  useEffect(() => {
    let cancelled = false
    Promise.all([agentApi.getAll(), settingsApi.get(`mastermind_agent:${conversationId}`)]).then(([allAgents, savedAgentId]) => {
      if (cancelled) return
      setAgents(allAgents)
      const live = useAgentStore.getState().sessions.get(conversationId)
      const defaultAgent = allAgents.find(a => !!live?.sessionId && a.id === live.agentId) || allAgents.find(a => a.id === savedAgentId) || allAgents.find((a) => a.id === project?.agentId) || allAgents.find((a) => a.is_default) || allAgents[0]
      if (defaultAgent) {
        setSelectedAgentId(defaultAgent.id)
      }
    }).catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [conversationId])

  // Keep warming and sends behind the switch until the old runtime is released.
  const handleAgentChange = async (newAgentId: string) => {
    if (switchingRef.current || newAgentId === selectedAgentIdRef.current) return
    setSwitching(true); setError('')
    const change = (async () => {
      await startingRef.current?.catch(() => undefined)
      await agentSessionApi.stopByTaskId(conversationId)
      endSession(conversationId)
      if (!mountedRef.current) return
      selectedAgentIdRef.current = newAgentId
      setSelectedAgentId(newAgentId)
      await settingsApi.set(`mastermind_agent:${conversationId}`, newAgentId)
    })()
    switchingRef.current = change
    try { await change } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      switchingRef.current = null
      if (mountedRef.current) setSwitching(false)
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
    try { await switchingRef.current } catch { return false }
    if (!mountedRef.current) return false
    const live = useAgentStore.getState().sessions.get(conversationId)
    if (live?.sessionId) return true

    const agentId = selectedAgentIdRef.current
    if (!agentId) return false

    if (!startingRef.current) {
      startingRef.current = (async () => {
        // skipInitialPrompt keeps the agent quiet until the user speaks.
        // initSession preserves the durable transcript across agent changes.
        await start(agentId, conversationId, undefined, true)
        // Small delay to ensure session is fully initialized
        await new Promise((resolve) => setTimeout(resolve, 100))
      })().finally(() => {
        startingRef.current = null
      })
    }

    try {
      await startingRef.current
      // A choice made during warm-up wins over sends waiting on that old start.
      if (switchingRef.current) { await switchingRef.current; return ensureSession() }
      return Boolean(useAgentStore.getState().sessions.get(conversationId)?.sessionId)
    } catch (err) {
      console.error('Failed to start mastermind session:', err)
      return false
    }
  }, [start, conversationId])

  // Send message - the session is usually warm already, so this just sends.
  const handleSendMessage = useCallback(
    async (message: string) => {
      if (!(await ensureSession())) throw new Error('The Mastermind agent session did not start. Please try again.')

      // Question answers should use approve() instead of sendMessage()
      const live = useAgentStore.getState().sessions.get(conversationId)
      const messages = live?.messages || []
      const lastMessage = messages[messages.length - 1]
      if (live?.status === SessionStatus.WAITING_APPROVAL && lastMessage?.partType === 'question' && lastMessage?.tool?.questions) {
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
    if (switching || !prewarm || !selectedAgentId || currentSession?.sessionId) return
    void ensureSession()
  }, [switching, prewarm, selectedAgentId, currentSession?.sessionId, ensureSession])

  // Listen for pre-fill messages from the dashboard command input
  useEffect(() => {
    const handlePrefill = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.message && typeof detail.message === 'string') {
        // Small delay to ensure the panel is mounted and agent is selected
        setTimeout(() => {
          void handleSendMessage(detail.message).catch(e => {
            if (mountedRef.current) setError(e instanceof Error ? e.message : String(e))
          })
        }, 200)
      }
    }
    window.addEventListener('mastermind-prefill', handlePrefill)
    return () => window.removeEventListener('mastermind-prefill', handlePrefill)
  }, [handleSendMessage])

  return (
    // Floats as a card, like the workspace and the sidebar: same radius,
    // hairline, fill and shadow. It was the one panel still sitting flush and
    // square against the work.
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-card">
      {/* Header with agent selector */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        {/* Switching keeps the conversation and releases only its reasoning session. */}
        <select
          value={selectedAgentId || ''}
          onChange={(e) => handleAgentChange(e.target.value)}
          className="text-xs bg-background border border-border rounded px-2 py-1 cursor-pointer hover:border-primary/50 transition-colors"
          aria-label="Mastermind agent"
          disabled={switching || agents.length === 0}
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

      {switching && <p role="status" className="px-4 py-2 text-xs text-muted-foreground">Switching agent… Conversation history is kept.</p>}
      {error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{error}</p>}

      {/* Chat interface */}
      {selectedAgentId && (
        <AgentTranscriptPanel
          title={project ? project.name : "Mastermind den"}
          messages={currentSession?.messages || []}
          status={switching ? SessionStatus.IDLE : currentSession?.status || SessionStatus.IDLE}
          systemStatus={currentSession?.systemStatus}
          onStop={stop}
          onSend={handleSendMessage}
          fileReferences
          draft={draft?.projectId === project?.id ? draft ?? undefined : undefined}
          onDraftApplied={clearDraft}
          className="flex-1 min-h-0"
          sessionId={currentSession?.sessionId}
          pendingApproval={currentSession?.pendingApproval ?? undefined}
          pendingSend={switching || currentSession?.pendingSend}
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
