import { describe, it, expect, beforeEach, vi } from 'vitest'

// happy-dom has no microphone, so the real capture would end the turn at once.
vi.mock('@/lib/voice-capture', () => ({
  voiceCapture: {
    isCapturing: false,
    start: vi.fn(async () => true),
    stop: vi.fn(),
    release: vi.fn(async () => undefined),
  },
}))

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MASTERMIND_COMPOSER_KEY, TopBarVoiceButton } from './TopBarVoiceButton'
import { useVoiceStore } from '@/stores/voice-store'
import { useUIStore } from '@/stores/ui-store'
import {
  clearDictationTarget,
  insertAndSubmit,
  insertDictation,
  registerComposer,
} from '@/lib/voice-dictation-target'

/**
 * The top-bar microphone.
 *
 * The rule this file protects: a control that sits outside every text box must
 * say where the words go. A turn started away from a composer writes the words
 * nowhere, which is what the global shortcut does on purpose — and would be a
 * bug here.
 */

const RUNTIME = { installed: true, version: '1.0.0', modulePath: '/tmp/voice', sizeBytes: 0 }

function voiceReady(conversation = true): void {
  useVoiceStore.setState({
    available: true,
    enabled: true,
    runtime: RUNTIME,
    engine: { state: 'ready', modelId: 'test', engine: 'sherpa-onnx' },
    conversation,
    turnId: null,
    state: 'idle',
  })
}

/** Stands in for the Mastermind drawer, which registers the same key. */
function mountMastermindComposer(): { field: HTMLTextAreaElement; submit: ReturnType<typeof vi.fn> } {
  const field = document.createElement('textarea')
  document.body.appendChild(field)
  const submit = vi.fn()
  registerComposer(MASTERMIND_COMPOSER_KEY, { getField: () => field, submit })
  return { field, submit }
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  document.body.innerHTML = ''
  clearDictationTarget()
  useUIStore.setState({ showOrchestrator: false })
  voiceReady()
})

describe('TopBarVoiceButton', () => {
  it('offers a microphone once voice is ready', async () => {
    await act(async () => {
      render(<TopBarVoiceButton />)
    })
    expect(screen.getByTestId('voice-mic-button')).toBeInTheDocument()
  })

  it('stays hidden while voice is switched off', async () => {
    useVoiceStore.setState({ enabled: false })
    await act(async () => {
      render(<TopBarVoiceButton />)
    })
    expect(screen.queryByTestId('voice-mic-button')).not.toBeInTheDocument()
  })

  it('stays hidden while the runtime is missing', async () => {
    useVoiceStore.setState({ runtime: { installed: false, version: null, modulePath: null, sizeBytes: 0 } })
    await act(async () => {
      render(<TopBarVoiceButton />)
    })
    expect(screen.queryByTestId('voice-mic-button')).not.toBeInTheDocument()
  })

  it('opens the drawer, so the words arrive somewhere the user can see', async () => {
    mountMastermindComposer()
    await act(async () => {
      render(<TopBarVoiceButton />)
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-mic-button'))
    })

    expect(useUIStore.getState().showOrchestrator).toBe(true)
  })

  it('sends the words to Mastermind, not to nowhere', async () => {
    const { field, submit } = mountMastermindComposer()
    await act(async () => {
      render(<TopBarVoiceButton />)
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-mic-button'))
    })

    // This is what the renderer does when a sentence finishes.
    expect(insertAndSubmit('what is blocking the release')).toBe(true)
    expect(field.value).toBe('what is blocking the release')
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('runs a conversation when the composer can send, and one turn when it cannot', async () => {
    const startTurn = vi.fn(async () => undefined)
    useVoiceStore.setState({ startTurn: startTurn as never })

    mountMastermindComposer()
    await act(async () => {
      render(<TopBarVoiceButton />)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-mic-button'))
    })
    expect(startTurn).toHaveBeenLastCalledWith('conversation')

    // "Keep talking" off: one sentence, written into the box for the user to send.
    cleanup()
    clearDictationTarget()
    voiceReady(false)
    useVoiceStore.setState({ startTurn: startTurn as never })
    mountMastermindComposer()
    await act(async () => {
      render(<TopBarVoiceButton />)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-mic-button'))
    })
    expect(startTurn).toHaveBeenLastCalledWith('dictation')
  })

  it('writes into the Mastermind box even when the drawer was rebuilt mid-turn', async () => {
    mountMastermindComposer()
    await act(async () => {
      render(<TopBarVoiceButton />)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-mic-button'))
    })

    // The drawer remounts — a new field under the same key.
    const replacement = mountMastermindComposer()
    expect(insertDictation('still listening')).toBe(true)
    expect(replacement.field.value).toBe('still listening')
  })
})
