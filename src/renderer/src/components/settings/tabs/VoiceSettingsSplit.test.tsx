import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { VoiceSettings } from './VoiceSettings'
import { useVoiceStore } from '@/stores/voice-store'

/**
 * Listening and speaking are separate pages.
 *
 * They share a name and nothing else: one needs a microphone, a granted
 * permission and a downloaded recogniser; the other needs none of those. Having
 * them on one page made both hard to read.
 */

// The store subscribes to every main-process event as it loads, so the whole
// surface is stubbed rather than the two calls this page makes.
vi.mock('@/lib/ipc-client', () => {
  const noop = (): (() => void) => () => undefined
  const listeners = Object.fromEntries(
    [
      'onState',
      'onPartial',
      'onFinal',
      'onSegment',
      'onOutcome',
      'onStatus',
      'onError',
      'onNavigate',
      'onDictate',
      'onRuntimeProgress',
      'onHotkey',
      'onSpeechStart',
      'onSpeechChunk',
      'onSpeechEnd',
      'onModelProgress',
    ].map((name) => [name, noop])
  )
  return {
    settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    voiceApi: {
      ...listeners,
      pickModelDir: vi.fn(async () => ({ dir: null })),
      setEndpointSilence: vi.fn(async () => ({ success: true })),
    },
    voiceTtsApi: { ...listeners, getSnapshot: vi.fn(async () => null) },
  }
})

vi.mock('@/components/voice/VoiceRuntimeRow', () => ({
  VoiceRuntimeRow: () => <div data-testid="voice-runtime-row" />,
}))

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  useVoiceStore.setState({
    available: true,
    enabled: true,
    runtime: { installed: true, version: '1.0.0', modulePath: '/tmp/voice', sizeBytes: 0 },
    engine: { state: 'ready', modelId: 'test', engine: 'sherpa-onnx' },
    models: [],
    permission: 'granted',
    shortcut: 'CommandOrControl+Shift+Space',
    state: 'idle',
    turnId: null,
    partial: '',
    testTranscript: '',
    level: 0,
    conversation: true,
    initialize: vi.fn(async () => undefined),
  })
})

describe('Settings → Voice', () => {
  it('is split into readable parts instead of one long block', () => {
    render(<VoiceSettings />)

    expect(screen.getByText('Voice control')).toBeInTheDocument()
    expect(screen.getByText('Listening')).toBeInTheDocument()
    expect(screen.getByText('Spoken commands')).toBeInTheDocument()
    expect(screen.getByText('Speech models')).toBeInTheDocument()
  })

  it('carries no spoken-answer control at all', () => {
    render(<VoiceSettings />)

    // These belong to Settings → Spoken answers.
    expect(screen.queryByText('Read agent answers aloud')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tts-enabled-switch')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tts-voice-select')).not.toBeInTheDocument()
    expect(screen.queryByText('Downloaded voices')).not.toBeInTheDocument()
  })

  it('says where the speaking settings went', () => {
    render(<VoiceSettings />)
    expect(screen.getByText(/Settings → Spoken answers/)).toBeInTheDocument()
  })
})
