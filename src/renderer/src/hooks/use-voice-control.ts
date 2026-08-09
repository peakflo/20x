import { useEffect } from 'react'
import { voiceApi } from '@/lib/ipc-client'
import { useVoiceStore } from '@/stores/voice-store'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
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
      if (action === 'toggle') void toggleTurn('command')
    })

    return () => {
      offNavigate()
      offHotkey()
    }
  }, [toggleTurn])
}
