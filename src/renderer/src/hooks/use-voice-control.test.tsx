import { describe, it, expect, beforeEach, vi } from 'vitest'

const hotkey = vi.hoisted(() => ({ fire: null as ((event: { action: string }) => void) | null }))
const segment = vi.hoisted(() => ({ fire: null as ((event: { turnId: string; text: string; index: number }) => void) | null }))

vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  // The store subscribes to every channel as it loads; only the hotkey matters
  // here, so the rest are quiet no-ops.
  voiceApi: new Proxy(
    {
      onHotkey: (cb: (event: { action: string }) => void) => {
        hotkey.fire = cb
        return () => {
          hotkey.fire = null
        }
      },
      onSegment: (cb: (event: { turnId: string; text: string; index: number }) => void) => {
        segment.fire = cb
        return () => {
          segment.fire = null
        }
      },
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        return prop.startsWith('on') ? () => () => {} : async () => undefined
      },
    }
  ),
}))

import { act, cleanup, render } from '@testing-library/react'
import { VOICE_SENTENCE_JOIN_MS, useVoiceControl } from './use-voice-control'
import { useVoiceStore } from '@/stores/voice-store'
import { useUIStore } from '@/stores/ui-store'
import {
  MASTERMIND_COMPOSER_KEY,
  clearDictationTarget,
  getActiveComposer,
  registerComposer,
  setActiveComposer,
} from '@/lib/voice-dictation-target'

/**
 * The global shortcut.
 *
 * The rule this file protects: speech goes to the agent. The shortcut used to
 * run the eight built-in command rules instead, so anything outside those
 * phrases was rejected — and the agent can do far more than eight things.
 */

function Harness(): null {
  useVoiceControl()
  return null
}

let toggleTurn: ReturnType<typeof vi.fn>

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  clearDictationTarget()
  hotkey.fire = null
  toggleTurn = vi.fn(async () => undefined)
  useUIStore.setState({ showOrchestrator: false })
  useVoiceStore.setState({
    conversation: true,
    toggleTurn: toggleTurn as never,
    initialize: (async () => undefined) as never,
    setContextProvider: vi.fn() as never,
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { voice: {}, ui: {} }
})

describe('the global shortcut', () => {
  it('talks to Mastermind rather than running a command', async () => {
    registerComposer(MASTERMIND_COMPOSER_KEY, { getField: () => null, submit: vi.fn() })
    await act(async () => {
      render(<Harness />)
    })

    await act(async () => {
      hotkey.fire?.({ action: 'toggle' })
    })

    // Never 'command': that mode is what rejected anything outside eight phrases.
    expect(toggleTurn).toHaveBeenCalledWith('conversation')
    expect(getActiveComposer()).toBe(MASTERMIND_COMPOSER_KEY)
    // Opened, so the words arrive somewhere the user can see.
    expect(useUIStore.getState().showOrchestrator).toBe(true)
  })

  it('dictates one turn when the loop is switched off', async () => {
    useVoiceStore.setState({ conversation: false })
    registerComposer(MASTERMIND_COMPOSER_KEY, { getField: () => null, submit: vi.fn() })
    await act(async () => {
      render(<Harness />)
    })

    await act(async () => {
      hotkey.fire?.({ action: 'toggle' })
    })
    expect(toggleTurn).toHaveBeenCalledWith('dictation')
  })

  it('dictates one turn when the drawer cannot send', async () => {
    // No submit registered: a loop would have nowhere to send each sentence.
    registerComposer(MASTERMIND_COMPOSER_KEY, { getField: () => null })
    await act(async () => {
      render(<Harness />)
    })

    await act(async () => {
      hotkey.fire?.({ action: 'toggle' })
    })
    expect(toggleTurn).toHaveBeenCalledWith('dictation')
  })
})

describe('spoken sentences in a conversation', () => {
  function composer() {
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    const sent: string[] = []
    registerComposer(MASTERMIND_COMPOSER_KEY, {
      getField: () => field,
      submit: () => {
        sent.push(field.value)
        field.value = ''
      },
    })
    setActiveComposer(MASTERMIND_COMPOSER_KEY)
    return sent
  }

  it('joins sentences said with a short pause into one message', async () => {
    vi.useFakeTimers()
    try {
      const sent = composer()
      await act(async () => {
        render(<Harness />)
      })
      await act(async () => {
        segment.fire?.({ turnId: 't1', text: 'Start the billing task', index: 0 })
        vi.advanceTimersByTime(VOICE_SENTENCE_JOIN_MS - 100)
        segment.fire?.({ turnId: 't1', text: 'and tell me when it is done.', index: 1 })
      })
      expect(sent).toEqual([])
      await act(async () => {
        vi.advanceTimersByTime(VOICE_SENTENCE_JOIN_MS)
      })
      expect(sent).toEqual(['Start the billing task and tell me when it is done.'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends a lone sentence once the pause is over', async () => {
    vi.useFakeTimers()
    try {
      const sent = composer()
      await act(async () => {
        render(<Harness />)
      })
      await act(async () => {
        segment.fire?.({ turnId: 't1', text: 'What is pending?', index: 0 })
        vi.advanceTimersByTime(VOICE_SENTENCE_JOIN_MS)
      })
      expect(sent).toEqual(['What is pending?'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits while the user is still talking', async () => {
    vi.useFakeTimers()
    try {
      const sent = composer()
      await act(async () => {
        render(<Harness />)
      })
      await act(async () => {
        segment.fire?.({ turnId: 't1', text: 'Create a task', index: 0 })
        useVoiceStore.setState({ partial: 'called fix the' })
        vi.advanceTimersByTime(VOICE_SENTENCE_JOIN_MS * 2)
      })
      expect(sent).toEqual([])
      await act(async () => {
        segment.fire?.({ turnId: 't1', text: 'called fix the export.', index: 1 })
        vi.advanceTimersByTime(VOICE_SENTENCE_JOIN_MS)
      })
      expect(sent).toEqual(['Create a task called fix the export.'])
    } finally {
      vi.useRealTimers()
    }
  })
})
