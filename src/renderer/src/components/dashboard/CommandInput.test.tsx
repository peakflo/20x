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

import { act, cleanup, render, screen } from '@testing-library/react'
import { CommandInput } from './CommandInput'
import { useVoiceStore } from '@/stores/voice-store'
import {
  clearDictationTarget,
  insertAndSubmit,
  setActiveComposer,
} from '@/lib/voice-dictation-target'

const RUNTIME = { installed: true, version: '1.0.0', modulePath: '/tmp/voice', sizeBytes: 0 }

function voiceReady(): void {
  useVoiceStore.setState({
    available: true,
    enabled: true,
    runtime: RUNTIME,
    engine: { state: 'ready', modelId: 'test', engine: 'sherpa-onnx' },
    conversation: true,
    turnId: null,
    state: 'idle',
  })
}

describe('CommandInput — dictation', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    clearDictationTarget()
    voiceReady()
  })

  it('offers a microphone once voice is ready', async () => {
    await act(async () => {
      render(<CommandInput onSendToMastermind={vi.fn()} onCreateTask={vi.fn()} />)
    })
    expect(screen.getByTestId('voice-mic-button')).toBeInTheDocument()
  })

  it('hides the microphone while voice is switched off', async () => {
    useVoiceStore.setState({ enabled: false })
    await act(async () => {
      render(<CommandInput onSendToMastermind={vi.fn()} onCreateTask={vi.fn()} />)
    })
    expect(screen.queryByTestId('voice-mic-button')).not.toBeInTheDocument()
  })

  it('sends the words it just heard, not the value React held before', async () => {
    // This box is controlled. A send that read React state would send the
    // previous value, because dictation writes and sends in the same tick.
    const onSendToMastermind = vi.fn()
    await act(async () => {
      render(<CommandInput onSendToMastermind={onSendToMastermind} onCreateTask={vi.fn()} />)
    })
    setActiveComposer('dashboard-command')

    await act(async () => {
      expect(insertAndSubmit('what is blocking the release')).toBe(true)
    })

    expect(onSendToMastermind).toHaveBeenCalledWith('what is blocking the release')
  })

  it('clears the box after each sentence, so a conversation does not repeat itself', async () => {
    const onSendToMastermind = vi.fn()
    await act(async () => {
      render(<CommandInput onSendToMastermind={onSendToMastermind} onCreateTask={vi.fn()} />)
    })
    setActiveComposer('dashboard-command')

    await act(async () => {
      insertAndSubmit('first sentence')
    })
    await act(async () => {
      insertAndSubmit('second sentence')
    })

    expect(onSendToMastermind.mock.calls.map((call) => call[0])).toEqual([
      'first sentence',
      'second sentence',
    ])
  })
})
