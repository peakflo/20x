import { describe, it, expect, beforeEach, vi } from 'vitest'

const hotkey = vi.hoisted(() => ({ fire: null as ((event: { action: string }) => void) | null }))

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
import { useVoiceControl } from './use-voice-control'
import { useVoiceStore } from '@/stores/voice-store'
import { useUIStore } from '@/stores/ui-store'
import {
  MASTERMIND_COMPOSER_KEY,
  clearDictationTarget,
  getActiveComposer,
  registerComposer,
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
