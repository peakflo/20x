import { useEffect } from 'react'
import { voiceApi } from '@/lib/ipc-client'
import { useVoiceStore } from '@/stores/voice-store'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { clearActiveComposer, insertAndSubmit, insertDictation } from '@/lib/voice-dictation-target'
import type { VoiceUiContext } from '@shared/voice'

/**
 * Connects voice control to the application shell. Mount it once.
 *
 * It does three things:
 *  1. reports what the user is looking at, so main can resolve "this task",
 *  2. applies a navigation event that main has already validated,
 *  3. runs the global shortcut as a command turn.
 */
export function useVoiceControl(): void {
  const initialize = useVoiceStore((s) => s.initialize)
  const setContextProvider = useVoiceStore((s) => s.setContextProvider)
  const toggleTurn = useVoiceStore((s) => s.toggleTurn)

  useEffect(() => {
    void initialize()
  }, [initialize])

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
        pendingApproval:
          approval && selectedTaskId ? { taskId: selectedTaskId, sessionId: approval.sessionId } : null,
        visibleTaskIds: useTaskStore
          .getState()
          .tasks.slice(0, 50)
          .map((task) => task.id),
      }
    })
    return () => setContextProvider(null)
  }, [setContextProvider])

  // Publish what the user is looking at, so an agent tool can read it without
  // waiting for the window. Throttled, because an agent must never be able to
  // make the renderer busy by asking often.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.ui) return undefined

    let timer: ReturnType<typeof setTimeout> | null = null
    const publish = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        const ui = useUIStore.getState()
        const tasks = useTaskStore.getState()
        const selected = tasks.selectedTaskId
        const session = selected ? useAgentStore.getState().sessions.get(selected) : undefined
        void window.electronAPI.ui.publishState({
          view: ui.sidebarView,
          modal: ui.activeModal,
          selectedTaskId: selected,
          selectedTaskTitle: tasks.tasks.find((task) => task.id === selected)?.title ?? null,
          dashboardPreviewTaskId: ui.dashboardPreviewTaskId,
          mastermindOpen: ui.showOrchestrator,
          settingsTab: ui.activeModal === 'settings' ? ui.settingsTab : null,
          waitingForYou: Boolean(session?.pendingApproval),
          visibleTaskIds: tasks.tasks.slice(0, 50).map((task) => task.id)
        })
      }, 250)
    }

    publish()
    const offUi = useUIStore.subscribe(publish)
    const offTasks = useTaskStore.subscribe(publish)
    const offAgents = useAgentStore.subscribe(publish)
    return () => {
      if (timer) clearTimeout(timer)
      offUi()
      offTasks()
      offAgents()
    }
  }, [])

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
      if (action === 'toggle') {
        // The shortcut is not tied to a text field, so it never dictates.
        clearActiveComposer()
        void toggleTurn('command')
      }
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
    const offSegment = voiceApi.onSegment(({ text }) => {
      const sent = insertAndSubmit(text)
      if (sent) {
        useVoiceStore.setState((state) => ({
          sentSentences: [...state.sentSentences, text].slice(-5),
        }))
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
