import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { VoiceSessionManager } from './voice-session-manager'
import type { VoiceWorkerClient } from './voice-worker-client'
import type { VoiceSpeechService } from './voice-speech-service'
import type { VoiceActionOutcome, VoiceState } from '../../shared/voice'

/**
 * How a spoken command turns into speech (design §5.3 and §5.7).
 *
 * A question to the agent waits, an action result is said, and the audio state
 * moves through the same state machine the microphone uses.
 */

class FakeWorker extends EventEmitter {
  load = vi.fn(async () => {
    this.emit('status', { state: 'ready', modelId: 'test-model', engine: 'fake' })
  })
  startTurn = vi.fn()
  pushAudio = vi.fn()
  endTurn = vi.fn()
  cancelTurn = vi.fn()
  unload = vi.fn()
  stop = vi.fn()
  setRuntimeModulePath = vi.fn()
  isRunning = true
  isLoaded = true
}

/** A speech service stand-in. Nothing here produces audio. */
class FakeSpeech {
  spoken: Array<{ text: string; source: string; taskId?: string; voiceTurnId?: string }> = []
  expectations: Array<{ taskId: string; voiceTurnId: string }> = []
  forgotten: string[] = []
  stops = 0
  /** What `speak` returns. Set to false to model "nothing was spoken". */
  willSpeak = true
  private listener: ((speaking: boolean) => void) | null = null

  setSpeakingListener(listener: ((speaking: boolean) => void) | null): void {
    this.listener = listener
  }
  setRuntimeModulePath = vi.fn()
  shutdown = vi.fn()
  prepare = vi.fn(async () => undefined)
  expectAnswer(taskId: string, voiceTurnId: string): void {
    this.expectations.push({ taskId, voiceTurnId })
  }
  forgetAnswer(taskId: string): void {
    this.forgotten.push(taskId)
  }
  async speak(request: { text: string; source: string; taskId?: string; voiceTurnId?: string }): Promise<boolean> {
    this.spoken.push(request)
    if (this.willSpeak) this.listener?.(true)
    return this.willSpeak
  }
  async speakAgentAnswer(taskId: string, text: string): Promise<boolean> {
    return this.speak({ text, source: 'agent_answer', taskId })
  }
  stop(): void {
    this.stops += 1
    this.listener?.(false)
  }
  /** Ends the passage, as the worker would when the last sentence is produced. */
  finish(): void {
    this.listener?.(false)
  }
}

function makeManager(settings: Record<string, string> = { voice_enabled: 'true' }) {
  const store = { ...settings }
  const notify = vi.fn()
  const worker = new FakeWorker()
  const speech = new FakeSpeech()
  const db = {
    getTasks: vi.fn(() => []),
    getTask: vi.fn(() => undefined),
    createTask: vi.fn(() => undefined),
    updateTask: vi.fn(() => undefined),
    getAgents: vi.fn(() => []),
    getTranscriptParts: vi.fn(() => []),
    getSetting: vi.fn((key: string) => store[key]),
    setSetting: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
  }
  const agents = {
    startTask: vi.fn(),
    sendByTaskId: vi.fn(),
    respondToPermission: vi.fn(),
    findSessionByTaskId: vi.fn(),
    getSessionStatus: vi.fn(),
    getLastAssistantMessage: vi.fn(),
  }
  const manager = new VoiceSessionManager({
    db: db as never,
    agents: agents as never,
    notify,
    modelRootDir: '/tmp/voice-models-test',
    runtimeRootDir: '/tmp/voice-runtime-test-absent',
    worker: worker as unknown as VoiceWorkerClient,
    speech: speech as unknown as VoiceSpeechService,
  })
  // Pretend the runtime and a model are both present.
  ;(manager as unknown as { runtime: unknown }).runtime = {
    installed: true,
    version: '1.0.0',
    modulePath: '/tmp/voice',
    sizeBytes: 0,
  }
  ;(manager as unknown as { models: { resolve: () => Promise<unknown> } }).models.resolve = async () => ({
    id: 'test-model',
    dir: '/tmp/model',
    encoder: '/tmp/model/encoder.onnx',
    decoder: '/tmp/model/decoder.onnx',
    joiner: '/tmp/model/joiner.onnx',
    tokens: '/tmp/model/tokens.txt',
  })
  worker.emit('status', { state: 'ready', modelId: 'test-model', engine: 'fake' })
  return { manager, worker, speech, notify, db, agents }
}

/**
 * Runs one command through the manager exactly as a finished turn does: the
 * user speaks, the words are recognised, the action service returns an
 * outcome, and the manager decides what happens next. Going through a real
 * turn matters, because the state machine only allows a command to run from
 * the states a turn actually passes through.
 */
async function applyOutcome(
  manager: VoiceSessionManager,
  outcome: Omit<VoiceActionOutcome, 'turnId'>
): Promise<string> {
  const started = await manager.startTurn('command', {})
  if ('error' in started) throw new Error(started.error)
  const turnId = started.turnId
  // The worker has the words; the manager is now writing them down.
  manager.endTurn(turnId)

  const internal = manager as unknown as {
    actions: { apply: () => Promise<VoiceActionOutcome> }
    runProposal: (
      turnId: string,
      proposal: unknown,
      context: unknown,
      confirmed: boolean
    ) => Promise<void>
  }
  internal.actions.apply = async () => ({ ...outcome, turnId }) as VoiceActionOutcome
  await internal.runProposal(
    turnId,
    {
      intent: { type: 'cancel' },
      confidence: 1,
      transcript: 'test',
      source: 'deterministic',
      summary: 'test',
    },
    {},
    false
  )
  return turnId
}

function states(notify: ReturnType<typeof vi.fn>): VoiceState[] {
  return notify.mock.calls
    .filter(([channel]) => channel === 'voice:state')
    .map(([, data]) => (data as { state: VoiceState }).state)
}

let ctx: ReturnType<typeof makeManager>
beforeEach(() => {
  ctx = makeManager()
})

describe('after a spoken command', () => {
  it('waits for the answer to a question, and speaks nothing yet', async () => {
    const turnId = await applyOutcome(ctx.manager, {
      status: 'executed',
      intent: 'reply_to_agent',
      message: 'Sent to the agent on “Fix login”.',
      taskId: 'task-1',
    } as never)

    expect(ctx.manager.getState()).toBe('waiting_for_agent')
    expect(ctx.speech.spoken).toHaveLength(0)
    expect(ctx.speech.expectations).toEqual([{ taskId: 'task-1', voiceTurnId: turnId }])
  })

  it('says the short result of every other command', async () => {
    await applyOutcome(ctx.manager, {
      status: 'executed',
      intent: 'create_task',
      message: 'Task created.',
      taskId: 'task-2',
    } as never)

    expect(ctx.speech.spoken[0]).toMatchObject({ text: 'Task created.', source: 'action_result' })
    expect(ctx.manager.getState()).toBe('speaking')
  })

  it('reads the last answer with its own reason', async () => {
    await applyOutcome(ctx.manager, {
      status: 'executed',
      intent: 'read_last_answer',
      message: 'The test failed because the token expired.',
      taskId: 'task-3',
    } as never)

    expect(ctx.speech.spoken[0].source).toBe('read_last_answer')
  })

  it('goes back to rest when nothing is spoken', async () => {
    ctx.speech.willSpeak = false
    await applyOutcome(ctx.manager, {
      status: 'executed',
      intent: 'create_task',
      message: 'Task created.',
    } as never)

    expect(ctx.manager.getState()).toBe('idle')
  })

  it('goes back to rest when the command was refused', async () => {
    await applyOutcome(ctx.manager, {
      status: 'rejected',
      reason: 'not_found',
      message: 'No task matches that.',
    } as never)

    expect(ctx.manager.getState()).toBe('idle')
    expect(ctx.speech.spoken).toHaveLength(0)
  })
})

describe('the audio state', () => {
  it('goes from waiting, to speaking, to rest', async () => {
    await applyOutcome(ctx.manager, {
      status: 'executed',
      intent: 'reply_to_agent',
      message: 'Sent.',
      taskId: 'task-1',
    } as never)
    await ctx.manager.speakAgentAnswer('task-1', 'It passed.')
    expect(ctx.manager.getState()).toBe('speaking')

    ctx.speech.finish()

    expect(ctx.manager.getState()).toBe('idle')
    expect(states(ctx.notify)).toContain('waiting_for_agent')
    expect(states(ctx.notify)).toContain('speaking')
  })

  it('leaves the waiting state when the answer is not read out', async () => {
    await applyOutcome(ctx.manager, {
      status: 'executed',
      intent: 'reply_to_agent',
      message: 'Sent.',
      taskId: 'task-1',
    } as never)
    ctx.speech.willSpeak = false

    await ctx.manager.speakAgentAnswer('task-1', 'A background answer.')

    expect(ctx.manager.getState()).toBe('idle')
  })
})

describe('barge-in', () => {
  it('stops speaking the moment a turn opens', async () => {
    await ctx.manager.startTurn('dictation', {})
    expect(ctx.speech.stops).toBeGreaterThan(0)
  })

  it('stops speaking when the user asks it to', () => {
    ctx.manager.stopSpeaking()
    expect(ctx.speech.stops).toBe(1)
  })

  it('stops the speech worker when the app shuts down', () => {
    ctx.manager.shutdown()
    expect(ctx.speech.shutdown).toHaveBeenCalled()
  })
})
