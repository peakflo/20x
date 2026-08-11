import { describe, it, expect, beforeEach, vi } from 'vitest'

// happy-dom has no microphone, so the real capture would fail and end the turn.
vi.mock('@/lib/voice-capture', () => ({
  voiceCapture: { isCapturing: false, start: vi.fn(async () => true), stop: vi.fn(), release: vi.fn(async () => undefined) },
}))

import { act, cleanup, render, screen } from '@testing-library/react'
import { VoiceRuntimeRow } from './VoiceRuntimeRow'
import { VoiceMicButton } from './VoiceMicButton'
import { useVoiceStore } from '@/stores/voice-store'
import { getDictationTarget, clearDictationTarget } from '@/lib/voice-dictation-target'
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
  label: 'English — small',
  description: 'Fast and light.',
  license: 'Apache-2.0',
  licenseUrl: 'https://example.invalid',
  languages: ['en'],
  active: true,
  installed: false,
  installing: false,
  progress: 0,
  sizeBytes: 73_440_167,
  downloadable: true,
}

function reset(runtime: VoiceRuntimeStatus = ABSENT, modelInstalled = false): void {
  clearDictationTarget()
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

describe('microphone button — click to start, click to stop', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    reset(PRESENT, true)
    useVoiceStore.setState({ turnId: null, state: 'idle' })
  })

  it('starts on the first click', async () => {
    render(
      <div data-voice-composer="">
        <textarea />
        <VoiceMicButton />
      </div>
    )
    await act(async () => {
      screen.getByTestId('voice-mic-button').click()
    })
    expect(window.electronAPI.voice.startTurn).toHaveBeenCalledTimes(1)
    expect(window.electronAPI.voice.endTurn).not.toHaveBeenCalled()
  })

  it('stops on the second click', async () => {
    render(
      <div data-voice-composer="">
        <textarea />
        <VoiceMicButton />
      </div>
    )
    await act(async () => {
      screen.getByTestId('voice-mic-button').click()
    })
    await act(async () => {
      screen.getByTestId('voice-mic-button').click()
    })
    expect(window.electronAPI.voice.endTurn).toHaveBeenCalledTimes(1)
  })

  it('claims the field beside it, so words land in one composer only', async () => {
    render(
      <>
        <div data-voice-composer="" id="mine">
          <textarea data-testid="mine" />
          <VoiceMicButton />
        </div>
        <div data-voice-composer="" id="other">
          <textarea data-testid="other" />
        </div>
      </>
    )
    await act(async () => {
      screen.getByTestId('voice-mic-button').click()
    })
    expect(getDictationTarget()).toBe(screen.getByTestId('mine'))
    expect(getDictationTarget()).not.toBe(screen.getByTestId('other'))
  })
})

describe('the microphone button stays usable', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    reset(PRESENT, true)
    useVoiceStore.setState({ turnId: null, state: 'idle' })
  })

  it('is enabled again once main reports idle after a stranded turn', () => {
    // A turn the renderer never cleared used to disable every microphone
    // button in the app, because each one saw another turn in progress.
    useVoiceStore.setState({ turnId: 'a-turn-that-main-forgot', state: 'listening' })
    render(<VoiceMicButton />)
    expect(screen.getByTestId('voice-mic-button')).toBeDisabled()

    act(() => {
      useVoiceStore.setState({ turnId: null, state: 'idle' })
    })
    expect(screen.getByTestId('voice-mic-button')).toBeEnabled()
  })

  it('is enabled after a model download finishes', () => {
    render(<VoiceMicButton />)
    // Downloading reloads the worker. While it loads the button is hidden, and
    // it must come back enabled, not stuck.
    act(() => {
      useVoiceStore.setState({ engine: { state: 'loading' } })
    })
    expect(screen.queryByTestId('voice-mic-button')).not.toBeInTheDocument()

    act(() => {
      useVoiceStore.setState({
        engine: { state: 'ready', modelId: MODEL.id, engine: 'sherpa-onnx' },
        turnId: null,
        state: 'idle',
      })
    })
    expect(screen.getByTestId('voice-mic-button')).toBeEnabled()
  })
})
