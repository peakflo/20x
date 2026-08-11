import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VoiceOverlay } from './VoiceOverlay'
import { useVoiceStore } from '@/stores/voice-store'

/**
 * Reading an answer aloud draws nothing (design §5.3 and §5.7).
 *
 * The user can hear it. A bubble that says "Reading" repeats what the ears
 * already know and covers the screen while it does it. What must survive is
 * the way to stop: Escape, and simply speaking.
 */

const stopSpeaking = vi.fn(async () => undefined)

function reset(partial: Partial<ReturnType<typeof useVoiceStore.getState>> = {}): void {
  useVoiceStore.setState({
    available: true,
    enabled: true,
    runtime: { installed: true, version: '1.0.0', modulePath: '/tmp/voice', sizeBytes: 0 },
    engine: { state: 'ready', modelId: 'test', engine: 'sherpa-onnx' },
    state: 'idle',
    turnId: null,
    partial: '',
    final: '',
    level: 0,
    confirmation: null,
    result: null,
    speaking: false,
    speechText: '',
    stopSpeaking,
    ...partial,
  })
}

describe('reading an answer aloud', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    reset()
  })

  it('draws nothing at all', () => {
    reset({ speaking: true, speechText: 'The test failed because the token expired.' })
    render(<VoiceOverlay />)

    expect(screen.queryByTestId('voice-speaking')).not.toBeInTheDocument()
    expect(screen.queryByTestId('voice-speech-text')).not.toBeInTheDocument()
    expect(screen.queryByTestId('voice-overlay')).not.toBeInTheDocument()
  })

  it('draws nothing even when speech to text is not installed', () => {
    // The runtime is absent, so every microphone control is hidden. Speaking
    // still works through the system voice, and still shows nothing.
    reset({
      runtime: { installed: false, version: null, modulePath: null, sizeBytes: 0 },
      engine: { state: 'engine_missing', message: 'not installed' },
      speaking: true,
      speechText: 'Task created.',
    })
    render(<VoiceOverlay />)

    expect(screen.queryByTestId('voice-overlay')).not.toBeInTheDocument()
  })

  it('stops reading on Escape', () => {
    reset({ speaking: true, speechText: 'A long answer.' })
    render(<VoiceOverlay />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(stopSpeaking).toHaveBeenCalledTimes(1)
  })

  it('stops reading on Escape even with no speech runtime installed', () => {
    // Nothing is drawn, so the key handler is the only way out. It has to be
    // registered before the component decides it has nothing to draw.
    reset({
      runtime: { installed: false, version: null, modulePath: null, sizeBytes: 0 },
      engine: { state: 'engine_missing', message: 'not installed' },
      speaking: true,
    })
    render(<VoiceOverlay />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(stopSpeaking).toHaveBeenCalledTimes(1)
  })
})
