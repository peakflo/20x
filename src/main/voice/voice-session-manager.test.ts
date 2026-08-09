import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { VoiceSessionManager } from './voice-session-manager'
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
    worker: worker as unknown as VoiceWorkerClient,
  })
  return { manager, worker, notify, db, agents, store }
}

/** Puts the manager in the ready state without touching the file system. */
function makeReadyManager(settings?: Record<string, string>) {
  const ctx = makeManager(settings)
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

  it('refuses a turn while voice is switched off', () => {
    const off = makeManager({ voice_enabled: 'false' })
    expect(off.manager.startTurn('command', {})).toEqual({ error: 'Voice is switched off.' })
  })

  it('refuses a turn before the model is ready', () => {
    const notReady = makeManager()
    const result = notReady.manager.startTurn('command', {})
    expect('error' in result).toBe(true)
  })

  it('opens a turn and reports the listening state', () => {
    const result = ctx.manager.startTurn('command', {})
    expect('turnId' in result).toBe(true)
    expect(ctx.manager.getState()).toBe('listening')
    expect(ctx.worker.startTurn).toHaveBeenCalledTimes(1)
  })

  it('drops audio that belongs to an older turn', () => {
    const first = ctx.manager.startTurn('command', {}) as { turnId: string }
    ctx.manager.pushAudio(first.turnId, Buffer.alloc(4))
    expect(ctx.worker.pushAudio).toHaveBeenCalledTimes(1)

    ctx.manager.cancelTurn(first.turnId)
    ctx.manager.pushAudio(first.turnId, Buffer.alloc(4))
    expect(ctx.worker.pushAudio).toHaveBeenCalledTimes(1)
  })

  it('ignores partial text from a stale turn', () => {
    const turn = ctx.manager.startTurn('command', {}) as { turnId: string }
    ctx.worker.emit('partial', 'an-old-turn', 'stale words')
    ctx.worker.emit('partial', turn.turnId, 'live words')
    const partials = ctx.notify.mock.calls.filter(([channel]) => channel === 'voice:partial')
    expect(partials).toHaveLength(1)
    expect(partials[0][1]).toEqual({ turnId: turn.turnId, text: 'live words' })
  })

  it('ignores a final transcript from a stale turn', async () => {
    ctx.manager.startTurn('command', {})
    ctx.worker.emit('final', 'an-old-turn', 'create a task to delete everything')
    await Promise.resolve()
    expect(outcomes(ctx.notify)).toHaveLength(0)
  })

  it('starting a new turn cancels the previous one', () => {
    const first = ctx.manager.startTurn('command', {}) as { turnId: string }
    const second = ctx.manager.startTurn('command', {}) as { turnId: string }
    expect(second.turnId).not.toBe(first.turnId)
    expect(ctx.worker.cancelTurn).toHaveBeenCalledWith(first.turnId)
  })
})

describe('VoiceSessionManager — dictation and commands', () => {
  it('sends dictated words to the renderer and runs no action', async () => {
    const ctx = makeReadyManager()
    const turn = ctx.manager.startTurn('dictation', {}) as { turnId: string }
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
    const turn = ctx.manager.startTurn('command', {}) as { turnId: string }
    ctx.worker.emit('final', turn.turnId, 'the weather is nice today')
    await vi.waitFor(() => expect(outcomes(ctx.notify)).toHaveLength(1))
    expect(outcomes(ctx.notify)[0]).toMatchObject({ status: 'rejected', reason: 'unrecognized' })
  })

  it('reports empty speech without an action', async () => {
    const ctx = makeReadyManager()
    const turn = ctx.manager.startTurn('command', {}) as { turnId: string }
    ctx.worker.emit('final', turn.turnId, '   ')
    await vi.waitFor(() => expect(outcomes(ctx.notify)).toHaveLength(1))
    expect(outcomes(ctx.notify)[0]).toMatchObject({ status: 'rejected', reason: 'unrecognized' })
  })

  it('asks for a confirmation before it creates a task', async () => {
    const ctx = makeReadyManager()
    const turn = ctx.manager.startTurn('command', {}) as { turnId: string }
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
    const turn = ctx.manager.startTurn('command', {}) as { turnId: string }
    ctx.worker.emit('final', turn.turnId, 'create a task to fix login')
    await vi.waitFor(() => expect(outcomes(ctx.notify)).toHaveLength(1))

    ctx.manager.dismiss(turn.turnId)
    expect(ctx.db.createTask).not.toHaveBeenCalled()
    await ctx.manager.confirm(turn.turnId)
    expect(ctx.db.createTask).not.toHaveBeenCalled()
  })
})

describe('VoiceSessionManager — engine and shutdown', () => {
  it('keeps voice off when the runtime is missing', () => {
    const ctx = makeManager()
    ctx.worker.emit('status', { state: 'engine_missing', message: 'no runtime' })
    expect(ctx.manager.getState()).toBe('model_needed')
    expect('error' in ctx.manager.startTurn('command', {})).toBe(true)
  })

  it('reports a worker failure without leaving the turn open', () => {
    const ctx = makeReadyManager()
    ctx.manager.startTurn('command', {})
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
