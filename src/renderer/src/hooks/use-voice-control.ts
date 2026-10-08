import { useEffect } from 'react'
import { voiceApi } from '@/lib/ipc-client'
import { useVoiceStore } from '@/stores/voice-store'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import {
  MASTERMIND_COMPOSER_KEY,
  clearActiveComposer,
  composerCanSubmit,
  getActiveComposer,
  insertAndSubmit,
  insertDictation,
  setActiveComposer,
  taskIdOfComposer
} from '@/lib/voice-dictation-target'
import { isNoise, spokenEcho } from '@/lib/voice-echo'
import type { VoiceUiContext } from '@shared/voice'

/** How long a finished sentence waits for the user to carry on before it is sent. */
export const VOICE_SENTENCE_JOIN_MS = 700
/** The longest a sentence is held while the user keeps talking. */
export const VOICE_SENTENCE_HOLD_MAX_MS = 8000

/**
 * Connects voice control to the application shell. Mount it once.
 *
 * It does three things:
 *  1. tells the voice session what the user is looking at, so main can
 *     resolve "this task",
 *  2. applies a navigation event that main has already validated,
 *  3. runs the global shortcut as a command turn.
 *
 * Publishing the screen for agent tools is a separate concern and lives in
 * `useUiRemoteControl`.
 */
export function useVoiceControl(): void {
  const initialize = useVoiceStore((s) => s.initialize)
  const initializeTts = useVoiceStore((s) => s.initializeTts)
  const setContextProvider = useVoiceStore((s) => s.setContextProvider)
  const toggleTurn = useVoiceStore((s) => s.toggleTurn)

  useEffect(() => {
    void initialize()
    // Spoken answers are read separately: they work without the microphone.
    void initializeTts()
  }, [initialize, initializeTts])

  useEffect(() => {
    // Read the stores at call time, so the context is always current without
    // re-subscribing this effect on every selection change.
    setContextProvider((): VoiceUiContext => {
      const selectedTaskId = useTaskStore.getState().selectedTaskId
      const view = useUIStore.getState().sidebarView
      const session = selectedTaskId ? useAgentStore.getState().sessions.get(selectedTaskId) : undefined
      const approval = session?.pendingApproval
      return {
        selectedTaskId,
        view,
        pendingApproval: approval && selectedTaskId ? { taskId: selectedTaskId, sessionId: approval.sessionId } : null,
        visibleTaskIds: useTaskStore
          .getState()
          .tasks.slice(0, 50)
          .map((task) => task.id)
      }
    })
    return () => setContextProvider(null)
  }, [setContextProvider])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.voice) return undefined

    const offNavigate = voiceApi.onNavigate(({ destination, taskId }) => {
      const ui = useUIStore.getState()
      if (taskId) useTaskStore.getState().selectTask(taskId)
      if (destination === 'settings') {
        ui.openSettings()
        return
      }
      if (destination === 'canvas' && taskId) {
        ui.openTaskOnCanvas(taskId)
        return
      }
      ui.setSidebarView(destination)
    })

    const offHotkey = voiceApi.onHotkey(({ action }) => {
      if (action !== 'toggle') return
      // The shortcut talks to Mastermind, exactly like the microphone in the
      // top bar. It used to run the built-in command rules instead, which is
      // the only place a spoken sentence could be rejected for not being one
      // of eight phrases — and the agent can do far more than those eight.
      useUIStore.getState().setShowOrchestrator(true)
      setActiveComposer(MASTERMIND_COMPOSER_KEY)
      const loop = useVoiceStore.getState().conversation && composerCanSubmit(MASTERMIND_COMPOSER_KEY)
      void toggleTurn(loop ? 'conversation' : 'dictation')
    })

    // Exactly one subscriber writes dictated words, into the one field the
    // microphone button claimed. Without this, every mounted transcript panel
    // would receive the same sentence.
    const offDictate = voiceApi.onDictate(({ text }) => {
      if (isNoise(text)) {
        clearActiveComposer()
        return
      }
      const inserted = insertDictation(text)
      clearActiveComposer()
      if (!inserted) useVoiceStore.setState({ testTranscript: text.trim() })
    })

    // A conversation stays open: each pause finishes one sentence and the
    // microphone keeps listening. Sentences are held for a moment before they
    // are sent, and joined if the user carries on talking, so a thought with a
    // pause in the middle reaches the agent as one message instead of two that
    // interrupt each other.
    let held: { turnId: string; composer: string | null; texts: string[] } | null = null
    let flushTimer: number | null = null
    let fallbackTimer: number | null = null

    const clearTimers = () => {
      if (flushTimer !== null) window.clearTimeout(flushTimer)
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer)
      flushTimer = null
      fallbackTimer = null
    }

    const flush = () => {
      clearTimers()
      const batch = held
      held = null
      if (!batch || batch.texts.length === 0) return
      const text = batch.texts.join(' ')
      const sent = insertAndSubmit(text)
      if (sent) {
        useVoiceStore.setState((state) => ({
          sentSentences: [...state.sentSentences, text].slice(-5),
          // The sentence has gone. Leaving it in the bubble shows the user
          // words they have already sent, as though 20x were still hearing
          // them.
          partial: ''
        }))
        // The sentence has gone to an agent, so the answer that comes back is
        // the reply to it and may be read aloud. Without this the loop stops
        // after one turn: 20x hears the reply but never speaks the answer.
        void voiceApi.expectAnswer(batch.turnId, taskIdOfComposer(batch.composer))
      } else {
        // No composer to send from — show it instead of losing it.
        useVoiceStore.setState({ testTranscript: text })
      }
    }

    const offSegment = voiceApi.onSegment(({ turnId, text }) => {
      // A cough decoded as "uh", or 20x's own answer heard through the
      // loudspeaker, is not something the user said and must not be sent.
      if (isNoise(text) || spokenEcho.isEcho(text)) {
        console.info('[voice] dropped a sentence that was noise or an echo of the answer', { text })
        return
      }
      if (held && held.turnId !== turnId) flush()
      if (!held) held = { turnId, composer: getActiveComposer(), texts: [] }
      held.texts.push(text)
      // The words are queued to send, so the listening bubble starts fresh.
      useVoiceStore.setState({ partial: '' })
      clearTimers()
      flushTimer = window.setTimeout(flush, VOICE_SENTENCE_JOIN_MS)
    })

    // Words arriving while a sentence is held mean the user is still talking:
    // wait for the next pause instead, but never hold on for ever.
    const offPartial = useVoiceStore.subscribe((state, previous) => {
      if (held && state.partial && state.partial !== previous.partial && flushTimer !== null) {
        window.clearTimeout(flushTimer)
        flushTimer = null
        if (fallbackTimer === null) fallbackTimer = window.setTimeout(flush, VOICE_SENTENCE_HOLD_MAX_MS)
      }
      // The microphone closed: send what is held straight away.
      if (held && previous.turnId && !state.turnId) flush()
    })

    return () => {
      offNavigate()
      offHotkey()
      offDictate()
      offSegment()
      offPartial()
      flush()
    }
  }, [toggleTurn])
}
