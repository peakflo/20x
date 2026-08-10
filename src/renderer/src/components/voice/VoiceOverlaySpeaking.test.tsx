import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VoiceOverlay } from './VoiceOverlay'
import { useVoiceStore } from '@/stores/voice-store'

/**
 * The speaking half of the voice surface (design §5.3 and §5.7).
 *
 * It has to appear on a machine that has no microphone set up at all, because
 * the system voice needs neither the runtime nor a downloaded model.
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
    speechLevel: 0,
    stopSpeaking,
    ...partial,
  })
}

describe('the speaking bubble', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    reset()
  })

  it('shows what is being read', () => {
    reset({ speaking: true, speechText: 'The test failed because the token expired.' })
    render(<VoiceOverlay />)

    expect(screen.getByTestId('voice-speaking')).toBeInTheDocument()
    expect(screen.getByTestId('voice-speech-text')).toHaveTextContent(
      'The test failed because the token expired.'
    )
  })

  it('stays hidden while nothing is being read', () => {
    render(<VoiceOverlay />)
    expect(screen.queryByTestId('voice-speaking')).not.toBeInTheDocument()
  })

  it('appears even when speech to text is not installed', () => {
    // The runtime is absent, so every microphone control is hidden — but the
    // system voice still works and 20x can still read an answer.
    reset({
      runtime: { installed: false, version: null, modulePath: null, sizeBytes: 0 },
      engine: { state: 'engine_missing', message: 'not installed' },
      speaking: true,
      speechText: 'Task created.',
    })
    render(<VoiceOverlay />)

    expect(screen.getByTestId('voice-speaking')).toBeInTheDocument()
  })

  it('stops reading when the indicator is clicked', () => {
    reset({ speaking: true, speechText: 'A long answer.' })
    render(<VoiceOverlay />)

    fireEvent.click(screen.getByTestId('voice-speaking'))

    expect(stopSpeaking).toHaveBeenCalledTimes(1)
  })

  it('stops reading on Escape', () => {
    reset({ speaking: true, speechText: 'A long answer.' })
    render(<VoiceOverlay />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(stopSpeaking).toHaveBeenCalledTimes(1)
  })
})
