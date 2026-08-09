import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { VoiceRuntimeRow } from './VoiceRuntimeRow'
import { VoiceMicButton } from './VoiceMicButton'
import { useVoiceStore } from '@/stores/voice-store'
import type { VoiceRuntimeStatus } from '@shared/voice'

const ABSENT: VoiceRuntimeStatus = {
  installed: false,
  version: null,
  modulePath: null,
  sizeBytes: 188_743_680,
}
const PRESENT: VoiceRuntimeStatus = {
  installed: true,
  version: '1.12.0',
  modulePath: '/tmp/voice',
  sizeBytes: 188_743_680,
}

const MODEL = {
  id: 'sherpa-streaming-zipformer-en',
  label: 'Streaming Zipformer — English',
  license: 'Apache-2.0',
  languages: ['en'],
  installed: false,
  installing: false,
  progress: 0,
  sizeBytes: 73_440_167,
  downloadable: true,
}

function reset(runtime: VoiceRuntimeStatus = ABSENT, modelInstalled = false): void {
  useVoiceStore.setState({
    available: true,
    enabled: true,
    runtime,
    models: [{ ...MODEL, installed: modelInstalled }],
    engine: modelInstalled
      ? { state: 'ready', modelId: MODEL.id, engine: 'sherpa-onnx' }
      : { state: 'model_missing', message: 'No speech model is installed yet.' },
    install: { running: false, percent: 0, log: '', error: null },
  })
}

describe('VoiceRuntimeRow', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    reset()
  })

  it('offers one install and names the total download size', () => {
    render(<VoiceRuntimeRow />)
    expect(screen.getByTestId('voice-runtime-install')).toBeInTheDocument()
    // The runtime and the model together, so the user sees one number.
    expect(screen.getByTestId('voice-runtime-row')).toHaveTextContent('262 MB')
    expect(screen.getByTestId('voice-runtime-row')).toHaveTextContent('optional')
  })

  it('offers to finish the setup when only the model is missing', () => {
    reset(PRESENT, false)
    render(<VoiceRuntimeRow />)
    expect(screen.getByTestId('voice-runtime-install')).toHaveTextContent('Finish setup')
    expect(screen.getByTestId('voice-runtime-row')).toHaveTextContent('73 MB')
  })

  it('downloads nothing until the user asks', () => {
    render(<VoiceRuntimeRow />)
    expect(window.electronAPI.voice.installRuntime).not.toHaveBeenCalled()
  })

  it('installs when the user asks', async () => {
    render(<VoiceRuntimeRow />)
    await act(async () => {
      screen.getByTestId('voice-runtime-install').click()
    })
    expect(window.electronAPI.voice.installRuntime).toHaveBeenCalledTimes(1)
  })

  it('shows the version and a remove control once it is installed', () => {
    reset(PRESENT, true)
    render(<VoiceRuntimeRow />)
    expect(screen.queryByTestId('voice-runtime-install')).not.toBeInTheDocument()
    expect(screen.getByTestId('voice-runtime-row')).toHaveTextContent('v1.12.0')
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument()
  })

  it('keeps the onboarding row free of the remove control', () => {
    reset(PRESENT, true)
    render(<VoiceRuntimeRow variant="compact" />)
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument()
  })

  it('reports a failed install', () => {
    useVoiceStore.setState({
      install: { running: false, percent: 0, log: '', error: 'npm was not found.' },
    })
    render(<VoiceRuntimeRow />)
    expect(screen.getByTestId('voice-runtime-error')).toHaveTextContent('npm was not found.')
  })
})

describe('voice controls without the runtime', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('hides the microphone button until the runtime is installed', () => {
    reset(ABSENT)
    const { container } = render(<VoiceMicButton />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the microphone button once the runtime and a model are ready', () => {
    reset(PRESENT, true)
    render(<VoiceMicButton />)
    expect(screen.getByTestId('voice-mic-button')).toBeInTheDocument()
  })

  it('hides the microphone button while no model is loaded', () => {
    reset(PRESENT, false)
    const { container } = render(<VoiceMicButton />)
    expect(container).toBeEmptyDOMElement()
  })

  it('hides the microphone button while voice is switched off', () => {
    reset(PRESENT, true)
    useVoiceStore.setState({ enabled: false })
    const { container } = render(<VoiceMicButton />)
    expect(container).toBeEmptyDOMElement()
  })
})
