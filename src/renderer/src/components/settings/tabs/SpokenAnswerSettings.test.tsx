import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SpokenAnswerSettings } from './SpokenAnswerSettings'
import { useVoiceStore } from '@/stores/voice-store'
import type { VoiceTtsSnapshot } from '@shared/voice-tts'

/**
 * The speaking half of Settings → Voice.
 *
 * Two controls are shown by default; the rest arrives with the page's Advanced
 * switch, which this component receives as a prop. Everything with a privacy or
 * a disk cost stays explicit wherever it appears (design §5.9 and §5.10).
 */

const setTtsEnabled = vi.fn(async () => undefined)
const setTtsEngine = vi.fn(async () => undefined)
const installTtsModel = vi.fn(async () => undefined)
const setTtsVoice = vi.fn(async () => undefined)
const previewVoice = vi.fn(async () => undefined)
const initializeTts = vi.fn(async () => undefined)

const SNAPSHOT: VoiceTtsSnapshot = {
  enabled: false,
  engine: 'system',
  status: { state: 'ready', engine: 'system', modelId: '', voiceId: 'system:Samantha', sampleRate: 24000 },
  voices: [
    {
      id: 'system:Samantha',
      label: 'Samantha',
      engine: 'system',
      speakerId: 0,
      modelId: '',
      language: 'en-US',
      description: '',
    },
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
      licenseUrl: 'https://github.com/KittenML/KittenTTS',
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

function reset(tts: Partial<VoiceTtsSnapshot> | null = {}): void {
  useVoiceStore.setState({
    tts: tts === null ? null : { ...SNAPSHOT, ...tts },
    speaking: false,
    initializeTts,
    setTtsEnabled,
    setTtsEngine,
    setTtsVoice,
    installTtsModel,
    previewVoice,
  })
}

describe('Settings → Voice → Spoken answers', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    reset()
  })

  it('offers a switch that starts reading answers aloud', () => {
    render(<SpokenAnswerSettings />)

    expect(screen.getByText('Read agent answers aloud')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('tts-enabled-switch'))
    expect(setTtsEnabled).toHaveBeenCalledWith(true)
  })

  it('offers both engines and says what each one costs', () => {
    render(<SpokenAnswerSettings advanced />)

    expect(screen.getByTestId('tts-engine-system')).toHaveTextContent('No download')
    expect(screen.getByTestId('tts-engine-local')).toHaveTextContent(
      'It needs the speech runtime and a model on disk.'
    )

    fireEvent.click(screen.getByTestId('tts-engine-local'))
    expect(setTtsEngine).toHaveBeenCalledWith('local')
  })

  it('offers the download, with its size and its licence beside it', () => {
    render(<SpokenAnswerSettings advanced />)
    const row = screen.getByTestId('tts-model-kitten-nano-en-v0_2')

    // The user reads the cost before anything is downloaded.
    expect(row).toHaveTextContent('27 MB to download')
    expect(row).toHaveTextContent('42 MB on disk')
    expect(row).toHaveTextContent('8 voices')
    expect(row).toHaveTextContent('Apache-2.0')

    fireEvent.click(screen.getByTestId('tts-model-download-kitten-nano-en-v0_2'))
    expect(installTtsModel).toHaveBeenCalledWith('kitten-nano-en-v0_2')
  })

  it('refuses a download that has no recorded checksum', () => {
    reset({ models: [{ ...SNAPSHOT.models[0], downloadable: false }] })
    render(<SpokenAnswerSettings advanced />)

    expect(screen.getByTestId('tts-model-download-kitten-nano-en-v0_2')).toBeDisabled()
    expect(screen.getByText('The checksum for this voice is not recorded yet.')).toBeInTheDocument()
  })

  it('shows how far a download has got', () => {
    reset({ models: [{ ...SNAPSHOT.models[0], installing: true, progress: 0.42 }] })
    render(<SpokenAnswerSettings advanced />)

    expect(screen.getByTestId('tts-model-download-kitten-nano-en-v0_2')).toHaveTextContent('42%')
  })

  it('lets the user hear the chosen voice before using it', () => {
    render(<SpokenAnswerSettings />)

    fireEvent.click(screen.getByTestId('tts-preview'))
    expect(previewVoice).toHaveBeenCalledWith('system:Samantha')
  })

  it('says what is missing instead of failing quietly', () => {
    reset({
      status: { state: 'model_missing', message: 'Download “English — fast” to use this voice.' },
      voices: [],
      engine: 'local',
    })
    render(<SpokenAnswerSettings />)

    expect(screen.getByTestId('tts-status')).toHaveTextContent(
      'Download “English — fast” to use this voice.'
    )
    expect(screen.getByText('Switch on Advanced below to download a voice.')).toBeInTheDocument()
  })

  it('keeps only the switch and the voice until Advanced is on', () => {
    render(<SpokenAnswerSettings />)

    expect(screen.getByTestId('tts-enabled-switch')).toBeInTheDocument()
    expect(screen.getByTestId('tts-voice-select')).toBeInTheDocument()
    expect(screen.queryByText('Voice engine')).not.toBeInTheDocument()
    expect(screen.queryByText('Downloaded voices')).not.toBeInTheDocument()
  })

  it('says so plainly when the build has no spoken answers at all', () => {
    reset(null)
    render(<SpokenAnswerSettings />)

    expect(screen.getByText('Spoken answers are not available in this build.')).toBeInTheDocument()
  })
})
