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
import type { VoiceUiContext } from '@shared/voice'

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
      const inserted = insertDictation(text)
      clearActiveComposer()
      if (!inserted) useVoiceStore.setState({ testTranscript: text.trim() })
    })

    // A conversation stays open: each pause finishes one sentence, the sentence
    // is sent, and the microphone keeps listening for the next one.
    const offSegment = voiceApi.onSegment(({ turnId, text }) => {
      const composer = getActiveComposer()
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
        void voiceApi.expectAnswer(turnId, taskIdOfComposer(composer))
      } else {
        // No composer to send from — show it instead of losing it.
        useVoiceStore.setState({ testTranscript: text })
      }
    })

    return () => {
      offNavigate()
      offHotkey()
      offDictate()
      offSegment()
    }
  }, [toggleTurn])
}
