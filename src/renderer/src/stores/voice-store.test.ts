import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/voice-capture', () => ({
  voiceCapture: {
    isCapturing: false,
    start: vi.fn(async () => true),
    stop: vi.fn(),
  },
}))

const { useVoiceStore } = await import('./voice-store')
const { voiceCapture } = await import('@/lib/voice-capture')

// The store subscribes once when the module loads. Capture those callbacks now,
// before any test clears the mock call history.
const voiceBridge = window.electronAPI.voice
const onPartial = vi.mocked(voiceBridge.onPartial).mock.calls[0][0]
const onOutcome = vi.mocked(voiceBridge.onOutcome).mock.calls[0][0]
const onFinal = vi.mocked(voiceBridge.onFinal).mock.calls[0][0]
const onState = vi.mocked(voiceBridge.onState).mock.calls[0][0]

function reset(): void {
  useVoiceStore.setState({
    available: true,
    enabled: true,
    state: 'idle',
    turnId: null,
    partial: '',
    final: '',
    level: 0,
    confirmation: null,
    result: null,
  })
}

/**
 * The reported failure: the words were recognised and sent, and 20x carried on
 * reading. If words reach the recogniser then the gate was not holding, and a
 * gate that is not holding never fires barge-in — so nothing stopped the
 * playback. This is the net under that.
 */
describe('voice store — words heard while reading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function readingWithTurnOpen() {
    await useVoiceStore.getState().startTurn('conversation')
    const { voicePlayback } = await import('@/lib/voice-playback')
    vi.spyOn(voicePlayback, 'isPlaying', 'get').mockReturnValue(true)
    // Opening the turn stops any playback of its own, which is not what is
    // being measured here.
    return vi.spyOn(voicePlayback, 'stop')
  }

  it('stops reading as soon as any word is recognised', async () => {
    const stop = await readingWithTurnOpen()

    onPartial({ turnId: 'turn-1', text: 'stop' })

    expect(stop).toHaveBeenCalled()
  })

  it('leaves the reading alone when nothing was heard', async () => {
    const stop = await readingWithTurnOpen()

    onPartial({ turnId: 'turn-1', text: '   ' })

    expect(stop).not.toHaveBeenCalled()
  })
})

describe('voice store — turns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('does not open the microphone while voice is switched off', async () => {
    useVoiceStore.setState({ enabled: false })
    await useVoiceStore.getState().startTurn('command')
    expect(window.electronAPI.voice.startTurn).not.toHaveBeenCalled()
    expect(voiceCapture.start).not.toHaveBeenCalled()
  })

  it('opens the microphone only after main accepts the turn', async () => {
    await useVoiceStore.getState().startTurn('dictation')
    expect(window.electronAPI.voice.startTurn).toHaveBeenCalledWith('dictation', {})
    expect(voiceCapture.start).toHaveBeenCalledTimes(1)
    expect(useVoiceStore.getState().turnId).toBe('turn-1')
  })

  it('reports the reason when main refuses the turn', async () => {
    vi.mocked(window.electronAPI.voice.startTurn).mockResolvedValueOnce({ error: 'Voice is switched off.' })
    await useVoiceStore.getState().startTurn('command')
    expect(voiceCapture.start).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().result).toMatchObject({ kind: 'error', message: 'Voice is switched off.' })
  })

  it('releases the microphone when the turn ends', async () => {
    await useVoiceStore.getState().startTurn('command')
    await useVoiceStore.getState().endTurn()
    expect(voiceCapture.stop).toHaveBeenCalled()
    expect(window.electronAPI.voice.endTurn).toHaveBeenCalledWith('turn-1')
  })

  it('releases the microphone when the turn is cancelled', async () => {
    await useVoiceStore.getState().startTurn('command')
    await useVoiceStore.getState().cancel()
    expect(voiceCapture.stop).toHaveBeenCalled()
    expect(useVoiceStore.getState().turnId).toBeNull()
  })
})

describe('voice store — events from main', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('ignores partial text from an old turn', () => {
    useVoiceStore.setState({ turnId: 'turn-9' })
    onPartial({ turnId: 'an-old-turn', text: 'stale words' })
    expect(useVoiceStore.getState().partial).toBe('')

    onPartial({ turnId: 'turn-9', text: 'live words' })
    expect(useVoiceStore.getState().partial).toBe('live words')
  })

  it('shows a confirmation card instead of running the action', () => {
    onOutcome({
      status: 'needs_confirmation',
      turnId: 'turn-1',
      reason: 'destructive',
      proposal: {
        intent: { type: 'approve_checkpoint', taskRef: { kind: 'current' } },
        confidence: 1,
        transcript: 'approve',
        source: 'deterministic',
        summary: 'Approve the pending checkpoint',
      },
    })
    expect(useVoiceStore.getState().confirmation).toMatchObject({ turnId: 'turn-1', reason: 'destructive' })
  })

  it('shows the result of a finished action', () => {
    onOutcome({
      status: 'executed',
      turnId: 'turn-1',
      intent: 'create_task',
      message: 'Created “Fix login”.',
    })
    expect(useVoiceStore.getState().result).toMatchObject({ kind: 'ok', message: 'Created “Fix login”.' })
  })

  it('shows a refusal as an error', () => {
    onOutcome({
      status: 'rejected',
      turnId: 'turn-1',
      reason: 'no_pending_approval',
      message: 'There is no checkpoint waiting for an answer.',
    })
    expect(useVoiceStore.getState().result).toMatchObject({ kind: 'error' })
    expect(useVoiceStore.getState().turnId).toBeNull()
  })

  it('sends the picked record with the confirmation', async () => {
    useVoiceStore.setState({
      confirmation: {
        turnId: 'turn-4',
        reason: 'ambiguous_task',
        proposal: {
          intent: { type: 'start_task', taskRef: { kind: 'title', text: 'login' } },
          confidence: 1,
          transcript: 'start the task login',
          source: 'deterministic',
          summary: 'Start “login”',
        },
      },
    })
    await useVoiceStore.getState().confirm({ taskId: 't2' })
    expect(window.electronAPI.voice.confirm).toHaveBeenCalledWith('turn-4', { taskId: 't2' })
    expect(useVoiceStore.getState().confirmation).toBeNull()
  })
})

describe('a turn always closes', () => {
  // A turn that is never cleared leaves the microphone open, keeps the Stop
  // control on screen with nothing behind it, and disables every microphone
  // button in the app, because each one sees another turn in progress.
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('closes at once when the user stops, without waiting for main', async () => {
    await useVoiceStore.getState().startTurn('dictation')
    expect(useVoiceStore.getState().turnId).toBe('turn-1')

    await useVoiceStore.getState().endTurn()

    expect(useVoiceStore.getState().turnId).toBeNull()
    expect(voiceCapture.stop).toHaveBeenCalled()
  })

  it('closes when the worker ended the turn itself at a pause', async () => {
    await useVoiceStore.getState().startTurn('dictation')
    onFinal({ turnId: 'turn-1', text: 'what broke the build' })

    expect(useVoiceStore.getState().turnId).toBeNull()
    expect(voiceCapture.stop).toHaveBeenCalled()
  })

  it('closes on a dictation outcome', async () => {
    await useVoiceStore.getState().startTurn('dictation')
    onOutcome({ status: 'dictation', turnId: 'turn-1', text: 'hello' })
    expect(useVoiceStore.getState().turnId).toBeNull()
  })

  it('closes when main reports it is idle, whatever the renderer thinks', () => {
    useVoiceStore.setState({ turnId: 'a-turn-that-main-forgot', state: 'listening' })

    onState({ state: 'idle' })

    expect(useVoiceStore.getState().turnId).toBeNull()
    expect(voiceCapture.stop).toHaveBeenCalled()
  })

  it('keeps the turn while main is still listening', () => {
    useVoiceStore.setState({ turnId: 'turn-1', state: 'listening' })
    onState({ state: 'listening' })
    expect(useVoiceStore.getState().turnId).toBe('turn-1')
  })

  it('leaves a final from an older turn alone', async () => {
    await useVoiceStore.getState().startTurn('dictation')
    onFinal({ turnId: 'an-older-turn', text: 'stale' })
    expect(useVoiceStore.getState().turnId).toBe('turn-1')
  })
})
