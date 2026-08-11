import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VoiceSettings } from './VoiceSettings'
import { useVoiceStore } from '@/stores/voice-store'
import type { VoiceTtsSnapshot } from '@shared/voice-tts'

/**
 * One voice page, in two parts, each with a disclosure of its own.
 *
 * A page of twelve controls hides the ones that matter, so the main view keeps
 * what a user acts on — switch each half on, pick a voice, hear it, download a
 * model — and each half hides its own tuning behind its own named disclosure.
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
  models: [
    {
      id: 'kitten-nano-en-v0_2',
      label: 'English — fast',
      description: 'Small and quick.',
      license: 'Apache-2.0',
      licenseUrl: 'https://example.invalid',
      languages: ['en'],
      installed: false,
      active: false,
      installing: false,
      progress: 0,
      sizeBytes: 26_586_708,
      unpackedBytes: 41_817_958,
      downloadable: true,
      speakerCount: 8,
    },
  ],
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
    models: [
      {
        id: 'sherpa-streaming-zipformer-en',
        label: 'English — small',
        description: 'Fast and light.',
        license: 'Apache-2.0',
        licenseUrl: 'https://example.invalid',
        languages: ['en'],
        installed: false,
        active: true,
        installing: false,
        progress: 0,
        sizeBytes: 73_000_000,
        downloadable: true,
      },
    ],
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

  it('gives each half its own disclosure, named for that half', async () => {
    render(<VoiceSettings />)

    expect(await screen.findByTestId('voice-advanced-stt')).toHaveTextContent(
      'Advanced options (speech to text)'
    )
    expect(await screen.findByTestId('tts-advanced')).toHaveTextContent(
      'Advanced options (text to speech)'
    )
  })

  it('keeps both model catalogues in view, not behind a disclosure', () => {
    render(<VoiceSettings />)

    expect(screen.getByText('Speech models')).toBeInTheDocument()
    expect(screen.getByText('Downloaded voices')).toBeInTheDocument()
    expect(screen.getByTestId('voice-model-sherpa-streaming-zipformer-en')).toBeInTheDocument()
    expect(screen.getByTestId('tts-model-kitten-nano-en-v0_2')).toBeInTheDocument()
    // And so is the button that plays a voice.
    expect(screen.getByTestId('tts-preview')).toBeInTheDocument()
  })

  it('hides only the tuning of each half', () => {
    render(<VoiceSettings />)

    // Listening.
    expect(screen.queryByTestId('voice-test')).not.toBeInTheDocument()
    expect(screen.queryByTestId('voice-conversation-switch')).not.toBeInTheDocument()
    expect(screen.queryByText('Global shortcut')).not.toBeInTheDocument()
    // Speaking.
    expect(screen.queryByText('Voice engine')).not.toBeInTheDocument()
    expect(screen.queryByText('Reading speed')).not.toBeInTheDocument()
  })

  it('opens each half on its own, not both at once', async () => {
    render(<VoiceSettings />)

    fireEvent.click(await screen.findByTestId('voice-advanced-stt'))

    expect(screen.getByTestId('voice-test')).toBeInTheDocument()
    expect(screen.getByText('Global shortcut')).toBeInTheDocument()
    // The speaking half stayed shut.
    expect(screen.queryByText('Voice engine')).not.toBeInTheDocument()

    fireEvent.click(await screen.findByTestId('tts-advanced'))
    expect(screen.getByText('Voice engine')).toBeInTheDocument()
  })

  it('remembers each half separately', async () => {
    render(<VoiceSettings />)

    fireEvent.click(await screen.findByTestId('voice-advanced-stt'))
    expect(setSetting).toHaveBeenCalledWith('voice_advanced_stt', 'true')

    fireEvent.click(await screen.findByTestId('tts-advanced'))
    expect(setSetting).toHaveBeenCalledWith('voice_advanced_tts', 'true')
  })

  it('says what is wrong without opening anything', () => {
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
