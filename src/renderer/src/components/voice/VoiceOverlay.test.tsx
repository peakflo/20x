import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import { VoiceOverlay } from './VoiceOverlay'
import { useVoiceStore } from '@/stores/voice-store'
import type { VoiceIntentProposal } from '@shared/voice'

const CREATE_PROPOSAL: VoiceIntentProposal = {
  intent: { type: 'create_task', title: 'Fix login' },
  confidence: 0.95,
  transcript: 'create a task to fix login',
  source: 'deterministic',
  summary: 'Create task “Fix login”',
}

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
    ...partial,
  })
}

describe('VoiceOverlay', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    reset()
  })

  it('shows nothing while voice is switched off', () => {
    reset({ enabled: false, state: 'listening' })
    const { container } = render(<VoiceOverlay />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows nothing while the speech runtime is not installed', () => {
    reset({
      state: 'listening',
      partial: 'create a task',
      runtime: { installed: false, version: null, modulePath: null, sizeBytes: 0 },
    })
    const { container } = render(<VoiceOverlay />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows nothing while the session is idle', () => {
    const { container } = render(<VoiceOverlay />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the live transcript while listening', () => {
    reset({ state: 'listening', turnId: 'turn-1', partial: 'create a task to' })
    render(<VoiceOverlay />)
    expect(screen.getByTestId('voice-transcript')).toHaveTextContent('create a task to')
  })

  it('asks for a confirmation before the action runs', async () => {
    reset({ confirmation: { turnId: 'turn-1', proposal: CREATE_PROPOSAL, reason: 'policy' } })
    render(<VoiceOverlay />)

    expect(screen.getByTestId('voice-confirmation')).toHaveTextContent('Create task “Fix login”')
    const confirmButton = screen.getByTestId('voice-confirm-yes')

    await act(async () => {
      confirmButton.click()
    })
    expect(window.electronAPI.voice.confirm).toHaveBeenCalledWith('turn-1', undefined)
  })

  it('offers the matching records when a name is ambiguous', async () => {
    reset({
      confirmation: {
        turnId: 'turn-2',
        proposal: CREATE_PROPOSAL,
        reason: 'ambiguous_task',
        candidates: [
          { id: 't1', label: 'Fix login', kind: 'task' },
          { id: 't2', label: 'Fix login on mobile', kind: 'task' },
        ],
      },
    })
    render(<VoiceOverlay />)

    await act(async () => {
      screen.getByRole('button', { name: 'Fix login on mobile' }).click()
    })
    expect(window.electronAPI.voice.confirm).toHaveBeenCalledWith('turn-2', { taskId: 't2' })
  })

  it('runs nothing when the user cancels the card', async () => {
    reset({ confirmation: { turnId: 'turn-3', proposal: CREATE_PROPOSAL, reason: 'destructive' } })
    render(<VoiceOverlay />)

    await act(async () => {
      screen.getByRole('button', { name: /cancel/i }).click()
    })
    expect(window.electronAPI.voice.dismiss).toHaveBeenCalledWith('turn-3')
    expect(window.electronAPI.voice.confirm).not.toHaveBeenCalled()
  })

  it('reports the result of an action', () => {
    reset({ result: { kind: 'ok', message: 'Created “Fix login”.', at: Date.now() } })
    render(<VoiceOverlay />)
    expect(screen.getByTestId('voice-result')).toHaveTextContent('Created “Fix login”.')
  })
})
