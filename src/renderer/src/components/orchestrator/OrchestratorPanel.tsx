import { useState, useEffect, useCallback, useRef } from 'react'
import { Bot, X, BrainCircuit, Eraser } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { AgentHoverCard } from '@/components/usage/AgentHoverCard'
import { ProviderLogo } from '@/components/usage/ProviderLogo'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useAgentSession } from '@/hooks/use-agent-session'
import { agentApi, agentSessionApi, settingsApi, memoryApi, onMastermindMemoryContext, onMastermindMemorySaved } from '@/lib/ipc-client'
import { isUsageProvider } from '@shared/usage'
import { MASTERMIND_SAVE_WHAT_I_LEARNED_SETTING, MASTERMIND_SAVE_WHAT_I_LEARNED_PROMPT } from '@shared/mastermind-memory'
import type { Agent, MastermindMemory } from '@/types'

const MASTERMIND_SESSION_ID = 'mastermind-session'

/** How long the "saved a memory" toast stays up before it auto-dismisses. */
const MEMORY_SAVED_TOAST_MS = 6000

interface MemorySavedToastState {
  memory: MastermindMemory
  deduped: boolean
  updated: boolean
  previous?: MastermindMemory
}

/**
 * Who actually wrote a memory, for the save toast — `source` is always
 * derived server-side now (task-api-server.ts), so it's a real identity:
 * `agent:<id>` (Mastermind's own session, or any other trusted agent with
 * no task), `agent:<id>/task:<id>` (a trusted task agent), `user-stated`
 * (Settings UI) or `imported`. The toast used to just say "Mastermind
 * saved…" regardless of which of those actually wrote it.
 */
function describeMemorySource(source: string, agents: Agent[]): string {
  if (source === 'user-stated') return 'You'
  if (source === 'imported') return 'An import'
  const match = /^agent:([^/]+)/.exec(source)
  if (match) {
    const agent = agents.find((a) => a.id === match[1])
    return agent?.name ?? 'An agent'
  }
  return 'Mastermind'
}

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
  // "Remembering N things" indicator — set once per session when the
  // "what you remember" block is injected into the first prompt (see
  // AgentManager.buildMastermindMemoryInjection).
  const [rememberingCount, setRememberingCount] = useState<number | null>(null)
  // A burst of saves (e.g. "Save what I learned" proposing several memories
  // in a row) accumulates here instead of each new one replacing the last —
  // otherwise only the final save in a burst stayed undoable.
  const [savedToasts, setSavedToasts] = useState<MemorySavedToastState[]>([])
  const savedToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** True once "Save what I learned" has been asked for this conversation and a second click actually clears. */
  const [pendingClearAfterLearn, setPendingClearAfterLearn] = useState(false)

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

  // "Remembering N things" — fired once per session, right as the first
  // prompt goes out (fresh start or native resume).
  useEffect(() => {
    return onMastermindMemoryContext(({ count }) => setRememberingCount(count))
  }, [])

  // "Saved a memory" toast, with Undo. Dedup/update also reaches this path
  // (see buildMastermindMemoryInjection's sibling route handlers in
  // task-api-server.ts /remember) — `previous` is only set then, and Undo
  // uses it to put the exact prior content back instead of just deleting.
  // A burst of saves (e.g. "Save what I learned" proposing several at once)
  // accumulates into the same toast instead of each one replacing the
  // last — the whole burst stays undoable, not just whichever came last.
  useEffect(() => {
    return onMastermindMemorySaved((event) => {
      setSavedToasts((prev) => [...prev, event])
      if (savedToastTimerRef.current) clearTimeout(savedToastTimerRef.current)
      savedToastTimerRef.current = setTimeout(() => setSavedToasts([]), MEMORY_SAVED_TOAST_MS)
    })
  }, [])

  useEffect(() => {
    return () => {
      if (savedToastTimerRef.current) clearTimeout(savedToastTimerRef.current)
    }
  }, [])

  /** Reverts one save: restores the exact previous content (and its own source) on an update, or deletes a new memory. */
  const undoOneMemorySave = useCallback(async (toast: MemorySavedToastState) => {
    if (toast.previous) {
      await memoryApi.update(toast.memory.id, {
        content: toast.previous.content,
        kind: toast.previous.kind,
        scope: toast.previous.scope,
        importance: toast.previous.importance,
        pinned: toast.previous.pinned,
        source: toast.previous.source
      })
    } else {
      await memoryApi.delete(toast.memory.id)
    }
  }, [])

  const handleUndoMemorySave = useCallback(async () => {
    if (savedToasts.length !== 1) return
    await undoOneMemorySave(savedToasts[0])
    if (savedToastTimerRef.current) clearTimeout(savedToastTimerRef.current)
    setSavedToasts([])
  }, [savedToasts, undoOneMemorySave])

  /** Undoes every save in the current burst, most recent first. */
  const handleUndoAllMemorySaves = useCallback(async () => {
    const toUndo = [...savedToasts].reverse()
    if (savedToastTimerRef.current) clearTimeout(savedToastTimerRef.current)
    setSavedToasts([])
    for (const toast of toUndo) {
      await undoOneMemorySave(toast)
    }
  }, [savedToasts, undoOneMemorySave])

  const handleDismissMemorySaveToast = useCallback(() => {
    if (savedToastTimerRef.current) clearTimeout(savedToastTimerRef.current)
    setSavedToasts([])
  }, [])

  /**
   * "Clear conversation", with the optional "Save what I learned" offer
   * (off by default — see Settings → Memory). When the setting is on and
   * there is a live conversation, the first click only asks Mastermind to
   * propose memories (each proposal still goes through the normal save
   * toast + Undo above) — it does not clear yet, so nothing is lost while
   * the agent is still replying, and so it doesn't need its own
   * confirmation. The button becomes "Clear conversation now" until the
   * second click, which — like the direct-clear path below — actually
   * discards the conversation and is confirmed first.
   *
   * Clearing goes through agentSessionApi.clearMastermind(), not the plain
   * stop() used elsewhere: stop() only destroys the live backend session —
   * it never clears the persisted resume anchor (mastermind:harness-session-id),
   * so the *next* start would otherwise still try to resume this same
   * conversation. clearMastermind() is what actually drops that anchor.
   */
  const handleClearConversation = useCallback(async () => {
    if (pendingClearAfterLearn) {
      if (!confirm('Clear this conversation now? Mastermind starts fresh next time — this cannot be undone.')) return
      await agentSessionApi.clearMastermind()
      removeSession(MASTERMIND_SESSION_ID)
      setRememberingCount(null)
      setPendingClearAfterLearn(false)
      return
    }

    const offerLearn = (await settingsApi.get(MASTERMIND_SAVE_WHAT_I_LEARNED_SETTING)) === 'true'
    if (offerLearn && currentSession?.sessionId) {
      await sendMessage(MASTERMIND_SAVE_WHAT_I_LEARNED_PROMPT)
      setPendingClearAfterLearn(true)
      return
    }

    if (!confirm('Clear this conversation? Mastermind starts fresh next time — this cannot be undone.')) return
    await agentSessionApi.clearMastermind()
    removeSession(MASTERMIND_SESSION_ID)
    setRememberingCount(null)
  }, [pendingClearAfterLearn, currentSession?.sessionId, sendMessage, removeSession])

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
        setRememberingCount(null)
        setPendingClearAfterLearn(false)
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

  // A read-only badge, not a picker — a dropdown here just invited switching
  // mid-conversation, which the warm-up already treats as a reset. Hover
  // still gets the same plan/usage detail as a task's agent badge.
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null
  const agentIcon = selectedAgent?.config?.coding_agent && isUsageProvider(selectedAgent.config.coding_agent)
    ? <ProviderLogo provider={selectedAgent.config.coding_agent} className="h-3 w-3" />
    : <Bot className="h-3 w-3" />
  const agentBadge = (
    <AgentHoverCard agent={selectedAgent}>
      <span className="inline-flex h-[24px] max-w-[140px] items-center gap-1.5 rounded-full border border-border/50 bg-card px-2 text-[11px] text-muted-foreground">
        {agentIcon}
        <span className="truncate">{selectedAgent?.name || 'No agent'}</span>
      </span>
    </AgentHoverCard>
  )
  // "Remembering N things" — only shown once this session has actually
  // injected a non-empty memory block (see onMastermindMemoryContext above).
  const memoryBadge = rememberingCount !== null && rememberingCount > 0 ? (
    <span
      className="inline-flex h-[24px] items-center gap-1 rounded-full border border-border/50 bg-card px-2 text-[11px] text-muted-foreground"
      title="Memories injected into this session's first prompt"
    >
      <BrainCircuit className="h-3 w-3" />
      Remembering {rememberingCount} thing{rememberingCount === 1 ? '' : 's'}
    </span>
  ) : null
  const headerLeading = (
    <div className="flex items-center gap-1.5">
      {agentBadge}
      {memoryBadge}
    </div>
  )
  const clearButton = currentSession?.sessionId ? (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleClearConversation}
      aria-label={pendingClearAfterLearn ? 'Clear conversation now' : 'Clear conversation'}
      title={pendingClearAfterLearn ? 'Clear conversation now' : 'Clear conversation'}
    >
      <Eraser className="h-4 w-4" />
    </Button>
  ) : null
  const closeButton = (
    <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close Mastermind den">
      <X className="h-4 w-4" />
    </Button>
  )
  const headerTrailing = (
    <div className="flex items-center gap-0.5">
      {clearButton}
      {closeButton}
    </div>
  )

  return (
    // Floats as a card, like the workspace and the sidebar: same radius,
    // hairline, fill and shadow. It was the one panel still sitting flush and
    // square against the work.
    <div className="native-backdrop-panel relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-card">
      {/* "<source> saved a memory" toast, with Undo — groups into a single
          "Undo all" once a burst (e.g. "Save what I learned") lands more
          than one at a time. */}
      {savedToasts.length === 1 && (
        <div className="absolute bottom-3 left-3 right-3 z-10 flex items-center justify-between gap-3 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
          <span className="truncate text-popover-foreground">
            <BrainCircuit className="mr-1.5 inline h-3.5 w-3.5 text-muted-foreground" />
            {describeMemorySource(savedToasts[0].memory.source, agents)}{' '}
            {savedToasts[0].updated
              ? 'updated a memory: '
              : savedToasts[0].deduped
                ? 'merged a near-identical memory: '
                : 'saved a memory: '}
            <span className="text-muted-foreground">{savedToasts[0].memory.content}</span>
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" onClick={handleUndoMemorySave} className="h-6 px-2 text-xs">
              Undo
            </Button>
            <Button variant="ghost" size="icon" onClick={handleDismissMemorySaveToast} aria-label="Dismiss" className="h-6 w-6">
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}
      {savedToasts.length > 1 && (
        <div className="absolute bottom-3 left-3 right-3 z-10 flex items-center justify-between gap-3 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
          <span className="truncate text-popover-foreground">
            <BrainCircuit className="mr-1.5 inline h-3.5 w-3.5 text-muted-foreground" />
            Saved {savedToasts.length} memories
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" onClick={handleUndoAllMemorySaves} className="h-6 px-2 text-xs">
              Undo all
            </Button>
            <Button variant="ghost" size="icon" onClick={handleDismissMemorySaveToast} aria-label="Dismiss" className="h-6 w-6">
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}
      {/* Chat interface */}
      {selectedAgentId && (
        <AgentTranscriptPanel
          title="Mastermind den"
          headerLeading={headerLeading}
          headerTrailing={headerTrailing}
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
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="glass-bar glass-task-detail-bar flex h-[36px] shrink-0 items-center justify-between gap-2 px-3">
            <span className="text-sm font-medium">Mastermind den</span>
            <div className="flex items-center gap-2">{headerLeading}{headerTrailing}</div>
          </div>
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            No agent selected
          </div>
        </div>
      )}
    </div>
  )
}
