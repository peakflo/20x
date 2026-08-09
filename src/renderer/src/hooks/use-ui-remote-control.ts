import { useEffect } from 'react'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { applyUiCommand, collectUiState } from '@/lib/ui-remote-control'

/** How long the window waits before republishing. */
export const UI_PUBLISH_THROTTLE_MS = 250

/**
 * Lets an agent read the screen and drive it. Mount it once.
 *
 * Reading: the window pushes what it is showing whenever it changes, so a tool
 * call is answered from a cache and never waits for the renderer. It is
 * throttled, because asking often must not be able to make the window busy.
 *
 * Driving: one command arrives per action and is applied to the stores. The
 * channel carries intent only — the renderer stays the only place that knows
 * how a view is assembled.
 */
export function useUiRemoteControl(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.ui) return undefined

    let timer: ReturnType<typeof setTimeout> | null = null
    let pending = false

    const publishNow = (): void => {
      pending = false
      if (timer) clearTimeout(timer)
      void window.electronAPI.ui.publishState({ ...collectUiState() })
      timer = setTimeout(() => {
        timer = null
        if (!pending) return
        publishNow()
      }, UI_PUBLISH_THROTTLE_MS)
    }

    const publish = (): void => {
      if (timer) {
        // A change during the window must not be lost: republish once the
        // window closes, or the agent reads a screen that has moved on.
        pending = true
        return
      }
      publishNow()
    }

    publish()
    const offUi = useUIStore.subscribe(publish)
    const offTasks = useTaskStore.subscribe(publish)
    const offAgents = useAgentStore.subscribe(publish)
    // Panels and viewport only: a panel drag writes `liveDrag` every frame and
    // must not push the whole screen out with it.
    const offPanels = useCanvasStore.subscribe((s) => s.panels, publish)
    const offViewport = useCanvasStore.subscribe((s) => s.viewport, publish)

    const offCommand = window.electronAPI.ui.onCommand?.((command) => {
      applyUiCommand(command)
      // Past the throttle on purpose: the next tool call must see the result of
      // this command, not the screen that was there before it. A command is one
      // tool call, so this cannot be used to make the window busy.
      publishNow()
    })

    return () => {
      if (timer) clearTimeout(timer)
      offUi()
      offTasks()
      offAgents()
      offPanels()
      offViewport()
      offCommand?.()
    }
  }, [])
}
