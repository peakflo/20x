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

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MASTERMIND_COMPOSER_KEY, TopBarVoiceButton } from './TopBarVoiceButton'
import { VoiceMicButton } from './VoiceMicButton'
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

  /**
   * The recording state belongs where the words land, not only where the click
   * happened. Starting from the top bar used to leave the microphone beside the
   * Mastermind box looking idle — and disabled — while that box was receiving
   * every word.
   */
  it('lights the microphone inside the Mastermind box as well', async () => {
    mountMastermindComposer()
    await act(async () => {
      render(
        <>
          <div data-testid="top-bar">
            <TopBarVoiceButton />
          </div>
          <div data-voice-composer={MASTERMIND_COMPOSER_KEY} data-testid="chat">
            <VoiceMicButton mode="dictation" onSubmit={vi.fn()} />
          </div>
        </>
      )
    })

    const topBarMic = within(screen.getByTestId('top-bar')).getByTestId('voice-mic-button')
    const chatMic = within(screen.getByTestId('chat')).getByTestId('voice-mic-button')
    expect(chatMic).toHaveAttribute('aria-pressed', 'false')

    await act(async () => {
      fireEvent.click(topBarMic)
      useVoiceStore.setState({ turnId: 'turn-1', state: 'listening' })
    })

    expect(topBarMic).toHaveAttribute('aria-pressed', 'true')
    expect(chatMic).toHaveAttribute('aria-pressed', 'true')
    // It must be usable, not greyed out: it is the box being dictated into.
    expect(chatMic).not.toBeDisabled()
  })

  it('lets the microphone in the box stop a turn the top bar started', async () => {
    const endTurn = vi.fn(async () => undefined)
    mountMastermindComposer()
    await act(async () => {
      render(
        <>
          <div data-testid="top-bar">
            <TopBarVoiceButton />
          </div>
          <div data-voice-composer={MASTERMIND_COMPOSER_KEY} data-testid="chat">
            <VoiceMicButton mode="dictation" onSubmit={vi.fn()} />
          </div>
        </>
      )
    })

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('top-bar')).getByTestId('voice-mic-button'))
      useVoiceStore.setState({ turnId: 'turn-1', state: 'listening', endTurn: endTurn as never })
    })

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('chat')).getByTestId('voice-mic-button'))
    })
    expect(endTurn).toHaveBeenCalledTimes(1)
  })

  it('still greys out a microphone that belongs to another box', async () => {
    mountMastermindComposer()
    await act(async () => {
      render(
        <>
          <div data-testid="top-bar">
            <TopBarVoiceButton />
          </div>
          <div data-voice-composer="some-other-task" data-testid="other">
            <VoiceMicButton mode="dictation" onSubmit={vi.fn()} />
          </div>
        </>
      )
    })

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('top-bar')).getByTestId('voice-mic-button'))
      useVoiceStore.setState({ turnId: 'turn-1', state: 'listening' })
    })

    const otherMic = within(screen.getByTestId('other')).getByTestId('voice-mic-button')
    expect(otherMic).toHaveAttribute('aria-pressed', 'false')
    expect(otherMic).toBeDisabled()
  })

  it('stands out by colour, and never by size', async () => {
    mountMastermindComposer()
    await act(async () => {
      render(
        <>
          <div data-testid="top-bar">
            <TopBarVoiceButton />
          </div>
          <div data-voice-composer="a-task" data-testid="chat">
            <VoiceMicButton mode="dictation" onSubmit={vi.fn()} />
          </div>
        </>
      )
    })
    const mic = within(screen.getByTestId('top-bar')).getByTestId('voice-mic-button')
    const quiet = within(screen.getByTestId('chat')).getByTestId('voice-mic-button')

    // Accent tint while idle, so it reads as an invitation.
    expect(mic.className).toContain('text-primary')
    expect(mic.className).toContain('bg-primary/10')
    // A microphone that grows is a different-looking control. Same size.
    expect(mic.querySelector('svg')?.getAttribute('class')).toBe(
      quiet.querySelector('svg')?.getAttribute('class')
    )

    await act(async () => {
      fireEvent.click(mic)
      useVoiceStore.setState({ turnId: 'turn-1', state: 'listening' })
    })
    // Listening is the filled state, and the idle tint gets out of its way.
    expect(mic.className).toContain('bg-primary text-primary-foreground')
    expect(mic.className).not.toContain('bg-primary/10')
  })
})
