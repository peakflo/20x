import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
}))

import { act, cleanup, render } from '@testing-library/react'
import { UI_PUBLISH_THROTTLE_MS, useUiRemoteControl } from './use-ui-remote-control'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import type { UiCommand } from '@shared/ui-commands'

/**
 * The window reports the screen and takes commands.
 *
 * The rule this file protects: the throttle must not lose the last change. An
 * agent that reads a screen frozen mid-change acts on a view the user left.
 */

function Harness(): null {
  useUiRemoteControl()
  return null
}

let published: Array<Record<string, unknown>>
let commandListener: ((command: UiCommand) => void) | null

beforeEach(() => {
  vi.useFakeTimers()
  published = []
  commandListener = null
  useTaskStore.setState({ tasks: [{ id: 't1', title: 'Fix login' }] as never, selectedTaskId: null })
  useUIStore.setState({ sidebarView: 'dashboard', activeModal: null, dashboardPreviewTaskId: null })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    ui: {
      publishState: vi.fn(async (state: Record<string, unknown>) => {
        published.push(state)
      }),
      onCommand: (callback: (command: UiCommand) => void) => {
        commandListener = callback
        return () => {
          commandListener = null
        }
      },
    },
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useUiRemoteControl', () => {
  it('publishes the screen as soon as it is mounted', () => {
    render(<Harness />)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ view: 'dashboard' })
  })

  it('publishes the last change after the throttle, never a screen the user left', () => {
    render(<Harness />)
    published.length = 0

    act(() => {
      useUIStore.getState().setSidebarView('canvas')
      useUIStore.getState().setSidebarView('skills')
    })
    // Both changes fall inside one window, so nothing goes out yet.
    expect(published).toHaveLength(0)

    act(() => {
      vi.advanceTimersByTime(UI_PUBLISH_THROTTLE_MS)
    })
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ view: 'skills' })
  })

  it('stays quiet when nothing changes', () => {
    render(<Harness />)
    published.length = 0
    act(() => {
      vi.advanceTimersByTime(UI_PUBLISH_THROTTLE_MS * 4)
    })
    expect(published).toHaveLength(0)
  })

  it('applies a command and reports the result at once', () => {
    render(<Harness />)
    published.length = 0

    act(() => {
      commandListener?.({ kind: 'navigate', view: 'canvas' })
    })

    expect(useUIStore.getState().sidebarView).toBe('canvas')
    // The next tool call must see the screen this command produced.
    expect(published.at(-1)).toMatchObject({ view: 'canvas' })
  })

  it('stops listening when it is unmounted', () => {
    const view = render(<Harness />)
    view.unmount()
    expect(commandListener).toBeNull()
  })
})
