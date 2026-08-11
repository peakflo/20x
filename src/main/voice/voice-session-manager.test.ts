import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { VoiceSessionManager, VOICE_ENGINE_READY_TIMEOUT_MS } from './voice-session-manager'
import type { VoiceWorkerClient } from './voice-worker-client'
import type { VoiceActionOutcome } from '../../shared/voice'

/** A worker stand-in. Nothing here decodes audio; the tests drive it directly. */
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

function makeManager(settings: Record<string, string> = { voice_enabled: 'true' }) {
  const store = { ...settings }
  const notify = vi.fn()
  const worker = new FakeWorker()
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
  })
  return { manager, worker, notify, db, agents, store }
}

/** Puts the manager in the ready state without touching the file system. */
function makeReadyManager(settings?: Record<string, string>) {
  const ctx = makeManager(settings)
  // Pretend the runtime and a model are both present.
  ;(ctx.manager as unknown as { runtime: unknown }).runtime = {
    installed: true,
    version: '1.0.0',
    modulePath: '/tmp/voice',
    sizeBytes: 0,
  }
  ;(ctx.manager as unknown as { models: { resolve: () => Promise<unknown> } }).models.resolve =
    async () => ({
      id: 'test-model',
      dir: '/tmp/model',
      encoder: '/tmp/model/encoder.onnx',
      decoder: '/tmp/model/decoder.onnx',
      joiner: '/tmp/model/joiner.onnx',
      tokens: '/tmp/model/tokens.txt',
    })
  ctx.worker.emit('status', { state: 'ready', modelId: 'test-model', engine: 'fake' })
  return ctx
}

function outcomes(notify: ReturnType<typeof vi.fn>): VoiceActionOutcome[] {
  return notify.mock.calls.filter(([channel]) => channel === 'voice:outcome').map(([, data]) => data)
}

describe('VoiceSessionManager — turns', () => {
  let ctx: ReturnType<typeof makeReadyManager>
  beforeEach(() => {
    ctx = makeReadyManager()
  })

  /**
   * The bug a user hit: click the microphone, and nothing happens at all.
   *
   * Loading a model takes seconds and the worker answers late. `startTurn` used
   * to read the engine state immediately after asking for the load, find
   * "loading", and refuse — so every first click after the idle unload, a
   * restart, or a model change was swallowed.
   */
  it('waits for a model that is still loading instead of refusing the click', async () => {
    const ctx = makeReadyManager()
    ctx.worker.isLoaded = false
    // The real client reports `loading` when asked, and `ready` later.
    ctx.worker.load.mockImplementation(async () => {
      ctx.worker.emit('status', { state: 'loading' })
      setTimeout(() => {
        ctx.worker.emit('status', { state: 'ready', modelId: 'test-model', engine: 'fake' })
      }, 20)
    })

    const result = await ctx.manager.startTurn('conversation', {})

    expect('turnId' in result).toBe(true)
    expect(ctx.manager.getState()).toBe('listening')
  })

  it('gives up on a load that never finishes, rather than hanging the click', async () => {
    const ctx = makeReadyManager()
    ctx.worker.isLoaded = false
    ctx.worker.load.mockImplementation(async () => {
      ctx.worker.emit('status', { state: 'loading' })
    })

    vi.useFakeTimers()
    try {
      const pending = ctx.manager.startTurn('conversation', {})
      await vi.advanceTimersByTimeAsync(VOICE_ENGINE_READY_TIMEOUT_MS + 10)
      const result = await pending
      expect(result).toEqual({ error: 'The speech model is still loading.' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops waiting when the load fails, and says why', async () => {
    const ctx = makeReadyManager()
    ctx.worker.isLoaded = false
    ctx.worker.load.mockImplementation(async () => {
      ctx.worker.emit('status', { state: 'loading' })
      setTimeout(() => {
        ctx.worker.emit('status', { state: 'error', message: 'The speech model failed to load.' })
      }, 20)
    })

    const result = await ctx.manager.startTurn('conversation', {})
    expect(result).toEqual({ error: 'The speech model failed to load.' })
  })

  it('loads the model again after the worker released it', async () => {
    // The worker gives the memory back after an idle period. A later turn must
    // reload rather than fail for ever.
    const ctx = makeReadyManager()
    ctx.worker.isLoaded = false
    ctx.worker.load.mockClear()

    const result = await ctx.manager.startTurn('command', {})

    expect(ctx.worker.load).toHaveBeenCalledTimes(1)
    expect('turnId' in result).toBe(true)
  })

  it('refuses a turn while voice is switched off', async () => {
    const off = makeManager({ voice_enabled: 'false' })
    expect(await off.manager.startTurn('command', {})).toEqual({ error: 'Voice is switched off.' })
  })

  it('refuses a turn before the model is ready', async () => {
    const notReady = makeManager()
    const result = await notReady.manager.startTurn('command', {})
    expect('error' in result).toBe(true)
  })

  it('opens a turn and reports the listening state', async () => {
    const result = await ctx.manager.startTurn('command', {})
    expect('turnId' in result).toBe(true)
    expect(ctx.manager.getState()).toBe('listening')
    expect(ctx.worker.startTurn).toHaveBeenCalledTimes(1)
  })

  it('drops audio that belongs to an older turn', async () => {
    const first = await ctx.manager.startTurn('command', {}) as { turnId: string }
    ctx.manager.pushAudio(first.turnId, Buffer.alloc(4))
    expect(ctx.worker.pushAudio).toHaveBeenCalledTimes(1)

    ctx.manager.cancelTurn(first.turnId)
    ctx.manager.pushAudio(first.turnId, Buffer.alloc(4))
    expect(ctx.worker.pushAudio).toHaveBeenCalledTimes(1)
  })

  it('ignores partial text from a stale turn', async () => {
    const turn = await ctx.manager.startTurn('command', {}) as { turnId: string }
    ctx.worker.emit('partial', 'an-old-turn', 'stale words')
    ctx.worker.emit('partial', turn.turnId, 'live words')
    const partials = ctx.notify.mock.calls.filter(([channel]) => channel === 'voice:partial')
    expect(partials).toHaveLength(1)
    expect(partials[0][1]).toEqual({ turnId: turn.turnId, text: 'live words' })
  })

  it('ignores a final transcript from a stale turn', async () => {
    await ctx.manager.startTurn('command', {})
    ctx.worker.emit('final', 'an-old-turn', 'create a task to delete everything')
    await Promise.resolve()
    expect(outcomes(ctx.notify)).toHaveLength(0)
  })

  it('starting a new turn cancels the previous one', async () => {
    const first = await ctx.manager.startTurn('command', {}) as { turnId: string }
    const second = await ctx.manager.startTurn('command', {}) as { turnId: string }
    expect(second.turnId).not.toBe(first.turnId)
    expect(ctx.worker.cancelTurn).toHaveBeenCalledWith(first.turnId)
  })
})

describe('VoiceSessionManager — dictation and commands', () => {
  it('sends dictated words to the renderer and runs no action', async () => {
    const ctx = makeReadyManager()
    const turn = await ctx.manager.startTurn('dictation', {}) as { turnId: string }
    ctx.worker.emit('final', turn.turnId, 'approve this checkpoint')
    await vi.waitFor(() => expect(outcomes(ctx.notify)).toHaveLength(1))

    expect(ctx.notify).toHaveBeenCalledWith('voice:dictate', {
      turnId: turn.turnId,
      text: 'approve this checkpoint',
    })
    expect(outcomes(ctx.notify)[0]).toMatchObject({ status: 'dictation' })
    expect(ctx.agents.respondToPermission).not.toHaveBeenCalled()
  })

  it('reports speech that is not a command', async () => {
    const ctx = makeReadyManager()
    const turn = await ctx.manager.startTurn('command', {}) as { turnId: string }
    ctx.worker.emit('final', turn.turnId, 'the weather is nice today')
    await vi.waitFor(() => expect(outcomes(ctx.notify)).toHaveLength(1))
    expect(outcomes(ctx.notify)[0]).toMatchObject({ status: 'rejected', reason: 'unrecognized' })
  })

  it('reports empty speech without an action', async () => {
    const ctx = makeReadyManager()
    const turn = await ctx.manager.startTurn('command', {}) as { turnId: string }
    ctx.worker.emit('final', turn.turnId, '   ')
    await vi.waitFor(() => expect(outcomes(ctx.notify)).toHaveLength(1))
    expect(outcomes(ctx.notify)[0]).toMatchObject({ status: 'rejected', reason: 'unrecognized' })
  })

  it('asks for a confirmation before it creates a task', async () => {
    const ctx = makeReadyManager()
    const turn = await ctx.manager.startTurn('command', {}) as { turnId: string }
    ctx.worker.emit('final', turn.turnId, 'create a task to fix login')
    await vi.waitFor(() => expect(outcomes(ctx.notify)).toHaveLength(1))

    const outcome = outcomes(ctx.notify)[0]
    expect(outcome).toMatchObject({ status: 'needs_confirmation' })
    expect(ctx.manager.getState()).toBe('awaiting_confirmation')
    expect(ctx.db.createTask).not.toHaveBeenCalled()

    await ctx.manager.confirm(turn.turnId)
    expect(ctx.db.createTask).toHaveBeenCalledTimes(1)
    expect(ctx.manager.getState()).toBe('idle')
  })

  it('refuses a confirmation for a turn it does not hold', async () => {
    const ctx = makeReadyManager()
    await ctx.manager.confirm('a-turn-that-never-existed')
    expect(outcomes(ctx.notify)[0]).toMatchObject({ status: 'rejected', reason: 'stale_turn' })
    expect(ctx.db.createTask).not.toHaveBeenCalled()
  })

  it('runs nothing when the user dismisses the card', async () => {
    const ctx = makeReadyManager()
    const turn = await ctx.manager.startTurn('command', {}) as { turnId: string }
    ctx.worker.emit('final', turn.turnId, 'create a task to fix login')
    await vi.waitFor(() => expect(outcomes(ctx.notify)).toHaveLength(1))

    ctx.manager.dismiss(turn.turnId)
    expect(ctx.db.createTask).not.toHaveBeenCalled()
    await ctx.manager.confirm(turn.turnId)
    expect(ctx.db.createTask).not.toHaveBeenCalled()
  })
})

describe('VoiceSessionManager — optional runtime', () => {
  it('reports the runtime as absent before it is installed', async () => {
    const ctx = makeManager()
    const runtime = await ctx.manager.refreshRuntime()
    expect(runtime.installed).toBe(false)
    expect(runtime.modulePath).toBeNull()
  })

  it('loads no model while the runtime is missing', async () => {
    const ctx = makeManager()
    await ctx.manager.refreshRuntime()
    await ctx.manager.prepareEngine()
    expect(ctx.worker.load).not.toHaveBeenCalled()
    expect(ctx.manager.getState()).toBe('model_needed')
  })

  it('refuses a turn while the runtime is missing', async () => {
    const ctx = makeManager()
    await ctx.manager.refreshRuntime()
    await ctx.manager.prepareEngine()
    const result = await ctx.manager.startTurn('command', {})
    expect('error' in result).toBe(true)
    expect(ctx.worker.startTurn).not.toHaveBeenCalled()
  })

  it('reports the runtime in the snapshot the renderer reads', async () => {
    const ctx = makeManager()
    const snapshot = await ctx.manager.snapshot()
    expect(snapshot.runtime).toMatchObject({ installed: false })
  })
})

describe('VoiceSessionManager — engine and shutdown', () => {
  it('keeps voice off when the runtime is missing', async () => {
    const ctx = makeManager()
    ctx.worker.emit('status', { state: 'engine_missing', message: 'no runtime' })
    expect(ctx.manager.getState()).toBe('model_needed')
    expect('error' in await ctx.manager.startTurn('command', {})).toBe(true)
  })

  it('reports a worker failure without leaving the turn open', async () => {
    const ctx = makeReadyManager()
    await ctx.manager.startTurn('command', {})
    ctx.worker.emit('error', 'the worker stopped', 'worker_exit')
    expect(ctx.manager.getState()).toBe('idle')
    expect(outcomes(ctx.notify).at(-1)).toMatchObject({ status: 'rejected', reason: 'failed' })
  })

  it('stops the worker and switches off on request', async () => {
    const ctx = makeReadyManager()
    await ctx.manager.setEnabled(false)
    expect(ctx.worker.stop).toHaveBeenCalled()
    expect(ctx.manager.getState()).toBe('disabled')
    expect(ctx.store.voice_enabled).toBe('false')
  })
})

describe('VoiceSessionManager — the conversational loop', () => {
  function segments(notify: ReturnType<typeof vi.fn>): Array<{ text: string; index: number }> {
    return notify.mock.calls
      .filter(([channel]) => channel === 'voice:segment')
      .map(([, data]) => data as { text: string; index: number })
  }

  it('tells the worker to keep the microphone open', async () => {
    const ctx = makeReadyManager()
    await ctx.manager.startTurn('conversation', {})
    expect(ctx.worker.startTurn).toHaveBeenCalledWith(expect.any(String), 'conversation')
  })

  it('sends each sentence and stays listening', async () => {
    const ctx = makeReadyManager()
    const turn = (await ctx.manager.startTurn('conversation', {})) as { turnId: string }

    ctx.worker.emit('segment', turn.turnId, 'what broke the build', 1)
    ctx.worker.emit('segment', turn.turnId, 'show me the failing test', 2)

    expect(segments(ctx.notify)).toEqual([
      { turnId: turn.turnId, text: 'what broke the build', index: 1 },
      { turnId: turn.turnId, text: 'show me the failing test', index: 2 },
    ])
    // The turn is still open, so the next sentence needs no new click.
    expect(ctx.manager.getState()).toBe('listening')
  })

  it('never runs a task action from a spoken sentence', async () => {
    const ctx = makeReadyManager()
    const turn = (await ctx.manager.startTurn('conversation', {})) as { turnId: string }

    ctx.worker.emit('segment', turn.turnId, 'approve this checkpoint', 1)

    expect(ctx.agents.respondToPermission).not.toHaveBeenCalled()
    expect(ctx.db.createTask).not.toHaveBeenCalled()
  })

  /**
   * The tail of a conversation — whatever was still being spoken when the turn
   * was stopped — arrives as a final, not a segment. That final used to go to
   * the command parser, so a sentence meant for an agent could run a task
   * action, and a mis-heard one was rejected as a bad command and thrown away.
   */
  it('dictates the tail of a conversation, and never runs an action from it', async () => {
    const ctx = makeReadyManager()
    const turn = (await ctx.manager.startTurn('conversation', {})) as { turnId: string }

    ctx.worker.emit('final', turn.turnId, 'approve this checkpoint')
    await Promise.resolve()

    expect(ctx.agents.respondToPermission).not.toHaveBeenCalled()
    expect(outcomes(ctx.notify)).toEqual([
      { status: 'dictation', turnId: turn.turnId, text: 'approve this checkpoint' },
    ])
  })

  it('keeps mis-heard words instead of calling them a bad command', async () => {
    const ctx = makeReadyManager()
    const turn = (await ctx.manager.startTurn('conversation', {})) as { turnId: string }

    // Real transcription noise from a user, reported as a confusing error.
    ctx.worker.emit('final', turn.turnId, 'Same enable paradise will be adjust')
    await Promise.resolve()

    const outcome = outcomes(ctx.notify)[0]
    expect(outcome.status).toBe('dictation')
    expect(JSON.stringify(outcome)).not.toContain('not one of the spoken commands')
  })

  it('drops noise that is too short to be a sentence', async () => {
    const ctx = makeReadyManager()
    const turn = (await ctx.manager.startTurn('conversation', {})) as { turnId: string }

    ctx.worker.emit('segment', turn.turnId, 'a', 1)
    ctx.worker.emit('segment', turn.turnId, '  ', 2)

    expect(segments(ctx.notify)).toHaveLength(0)
  })

  it('ignores a sentence from a turn that already ended', async () => {
    const ctx = makeReadyManager()
    await ctx.manager.startTurn('conversation', {})
    ctx.worker.emit('segment', 'an-old-turn', 'stale words', 1)
    expect(segments(ctx.notify)).toHaveLength(0)
  })

  /**
   * Stopping a conversation is not a failure. Every sentence has already left
   * as a segment and the recogniser was reset after each one, so the closing
   * transcript is empty by design — reporting "Nothing was heard." for it told
   * the user their speech was lost when it had all been delivered.
   */
  it('ends quietly after the sentences it delivered', async () => {
    const ctx = makeReadyManager()
    const turn = (await ctx.manager.startTurn('conversation', {})) as { turnId: string }

    ctx.worker.emit('segment', turn.turnId, 'what broke the build', 1)
    ctx.worker.emit('segment', turn.turnId, 'show me the failing test', 2)
    ctx.manager.endTurn(turn.turnId)
    ctx.worker.emit('final', turn.turnId, '')
    await Promise.resolve()

    expect(outcomes(ctx.notify)).toEqual([{ status: 'completed', turnId: turn.turnId, segments: 2 }])
    expect(ctx.manager.getState()).toBe('idle')
  })

  it('still says so when a turn heard nothing at all', async () => {
    const ctx = makeReadyManager()
    const turn = (await ctx.manager.startTurn('conversation', {})) as { turnId: string }

    ctx.manager.endTurn(turn.turnId)
    ctx.worker.emit('final', turn.turnId, '   ')
    await Promise.resolve()

    expect(outcomes(ctx.notify)).toEqual([
      expect.objectContaining({ status: 'rejected', message: 'Nothing was heard.' }),
    ])
  })

  it('counts sentences per turn, so an earlier conversation cannot mask a silent one', async () => {
    const ctx = makeReadyManager()
    const first = (await ctx.manager.startTurn('conversation', {})) as { turnId: string }
    ctx.worker.emit('segment', first.turnId, 'first sentence', 1)
    ctx.manager.endTurn(first.turnId)
    ctx.worker.emit('final', first.turnId, '')
    await Promise.resolve()

    const second = (await ctx.manager.startTurn('conversation', {})) as { turnId: string }
    ctx.manager.endTurn(second.turnId)
    ctx.worker.emit('final', second.turnId, '')
    await Promise.resolve()

    expect(outcomes(ctx.notify).at(-1)).toMatchObject({
      status: 'rejected',
      message: 'Nothing was heard.',
    })
  })
})
