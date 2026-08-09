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

function reset(runtime: VoiceRuntimeStatus = ABSENT): void {
  useVoiceStore.setState({
    available: true,
    enabled: true,
    runtime,
    install: { running: false, percent: 0, log: '', error: null },
  })
}

describe('VoiceRuntimeRow', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    reset()
  })

  it('offers the optional install and names the download size', () => {
    render(<VoiceRuntimeRow />)
    expect(screen.getByTestId('voice-runtime-install')).toBeInTheDocument()
    expect(screen.getByTestId('voice-runtime-row')).toHaveTextContent('189 MB')
    expect(screen.getByTestId('voice-runtime-row')).toHaveTextContent('optional')
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
    reset(PRESENT)
    render(<VoiceRuntimeRow />)
    expect(screen.queryByTestId('voice-runtime-install')).not.toBeInTheDocument()
    expect(screen.getByTestId('voice-runtime-row')).toHaveTextContent('v1.12.0')
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument()
  })

  it('keeps the onboarding row free of the remove control', () => {
    reset(PRESENT)
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

  it('shows the microphone button once the runtime is installed', () => {
    reset(PRESENT)
    render(<VoiceMicButton />)
    expect(screen.getByTestId('voice-mic-button')).toBeInTheDocument()
  })

  it('hides the microphone button while voice is switched off', () => {
    reset(PRESENT)
    useVoiceStore.setState({ enabled: false })
    const { container } = render(<VoiceMicButton />)
    expect(container).toBeEmptyDOMElement()
  })
})
