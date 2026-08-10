import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VoiceSettings } from './VoiceSettings'
import { useVoiceStore } from '@/stores/voice-store'
import type { VoiceTtsSnapshot } from '@shared/voice-tts'

/**
 * One voice page, in two parts, with everything optional behind one switch.
 *
 * A page of twelve controls hides the two that matter, so only the controls a
 * user needs are shown: switch listening on, switch reading aloud on, and pick
 * a voice. The rest has a default that works.
 */

const setSetting = vi.fn(async () => undefined)

// The store subscribes to every main-process event as it loads, so the whole
// surface is stubbed rather than the few calls this page makes.
vi.mock('@/lib/ipc-client', () => {
  const noop = (): (() => void) => () => undefined
  const listeners = Object.fromEntries(
    [
      'onState', 'onPartial', 'onFinal', 'onSegment', 'onOutcome', 'onStatus', 'onError',
      'onNavigate', 'onDictate', 'onRuntimeProgress', 'onHotkey',
      'onSpeechStart', 'onSpeechChunk', 'onSpeechEnd', 'onModelProgress',
    ].map((name) => [name, noop])
  )
  return {
    settingsApi: {
      get: vi.fn(async () => null),
      set: (...args: unknown[]) => setSetting(...(args as [])),
    },
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

const TTS: VoiceTtsSnapshot = {
  enabled: false,
  engine: 'system',
  status: { state: 'ready', engine: 'system', modelId: '', voiceId: 'system:Samantha', sampleRate: 24000 },
  voices: [
    { id: 'system:Samantha', label: 'Samantha', engine: 'system', speakerId: 0, modelId: '', language: 'en-US', description: '' },
  ],
  voiceId: 'system:Samantha',
  speed: 1,
  maxChars: 1200,
  speakActionResults: true,
  onlyVoiceTurns: true,
  models: [],
  speaking: false,
}

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
    tts: TTS,
    speaking: false,
    initialize: vi.fn(async () => undefined),
    initializeTts: vi.fn(async () => undefined),
  })
})

describe('Settings → Voice', () => {
  it('is one page with a listening part and a speaking part', () => {
    render(<VoiceSettings />)

    expect(screen.getByText('Speech to text — what 20x hears')).toBeInTheDocument()
    expect(screen.getByText('Text to speech — what 20x says')).toBeInTheDocument()
  })

  it('shows only the controls that matter until Advanced is switched on', () => {
    render(<VoiceSettings />)

    // Kept: switch each half on, and pick a voice.
    expect(screen.getByText('Enable voice control')).toBeInTheDocument()
    expect(screen.getByText('Read agent answers aloud')).toBeInTheDocument()
    expect(screen.getByTestId('tts-voice-select')).toBeInTheDocument()

    // Hidden: everything with a default that works.
    expect(screen.queryByTestId('voice-test')).not.toBeInTheDocument()
    expect(screen.queryByTestId('voice-conversation-switch')).not.toBeInTheDocument()
    expect(screen.queryByText('Global shortcut')).not.toBeInTheDocument()
    expect(screen.queryByText('Speech models')).not.toBeInTheDocument()
    expect(screen.queryByText('Voice engine')).not.toBeInTheDocument()
    expect(screen.queryByText('Reading speed')).not.toBeInTheDocument()
    expect(screen.queryByText('Downloaded voices')).not.toBeInTheDocument()
    expect(screen.queryByTestId('voice-status')).not.toBeInTheDocument()
  })

  it('reveals the rest of both halves from one switch', () => {
    render(<VoiceSettings />)

    fireEvent.click(screen.getByTestId('voice-advanced-switch'))

    // Listening.
    expect(screen.getByTestId('voice-test')).toBeInTheDocument()
    expect(screen.getByTestId('voice-conversation-switch')).toBeInTheDocument()
    expect(screen.getByText('Global shortcut')).toBeInTheDocument()
    expect(screen.getByText('Speech models')).toBeInTheDocument()
    // Speaking.
    expect(screen.getByText('Voice engine')).toBeInTheDocument()
    expect(screen.getByText('Reading speed')).toBeInTheDocument()
    expect(screen.getByText('Downloaded voices')).toBeInTheDocument()
  })

  it('remembers the choice', () => {
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-advanced-switch'))
    expect(setSetting).toHaveBeenCalledWith('voice_advanced_settings', 'true')
  })

  it('says what is wrong without waiting for Advanced', () => {
    useVoiceStore.setState({ permission: 'denied' })
    render(<VoiceSettings />)

    expect(screen.getByTestId('voice-problem')).toHaveTextContent('Microphone access is blocked')
  })

  it('keeps quiet when nothing is wrong', () => {
    render(<VoiceSettings />)
    expect(screen.queryByTestId('voice-problem')).not.toBeInTheDocument()
  })

  it('shows the speaking status only while a voice is missing', () => {
    useVoiceStore.setState({
      tts: { ...TTS, status: { state: 'model_missing', message: 'Download “English — fast”.' } },
    })
    render(<VoiceSettings />)

    expect(screen.getByTestId('tts-status')).toHaveTextContent('Download “English — fast”.')
  })
})
