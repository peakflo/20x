import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'

/**
 * One user action must install everything voice needs. After it, the user has
 * only to switch voice on — no directory to pick, no second download to start.
 */

const installer = vi.hoisted(() => ({
  detectVoiceRuntime: vi.fn(),
  installVoiceRuntime: vi.fn(),
  removeVoiceRuntime: vi.fn(async () => undefined),
  VOICE_RUNTIME_APPROX_BYTES: 180 * 1024 * 1024,
}))
vi.mock('./voice-runtime-installer', () => installer)

const { VoiceSessionManager } = await import('./voice-session-manager')
const { DEFAULT_VOICE_MODEL_ID } = await import('./voice-model-manifest')
import type { VoiceModelManager } from './voice-model-manager'
import type { VoiceWorkerClient } from './voice-worker-client'

const ABSENT = { installed: false, version: null, modulePath: null, sizeBytes: 1 }
const PRESENT = {
  installed: true,
  version: '1.12.0',
  modulePath: '/data/voice-runtime/node_modules/sherpa-onnx-node',
  sizeBytes: 1,
}
const RESOLVED_MODEL = {
  id: DEFAULT_VOICE_MODEL_ID,
  dir: '/data/voice-models/en',
  encoder: '/data/voice-models/en/encoder.onnx',
  decoder: '/data/voice-models/en/decoder.onnx',
  joiner: '/data/voice-models/en/joiner.onnx',
  tokens: '/data/voice-models/en/tokens.txt',
}

class FakeWorker extends EventEmitter {
  load = vi.fn(async () => {
    this.emit('status', { state: 'ready', modelId: DEFAULT_VOICE_MODEL_ID, engine: 'sherpa-onnx' })
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

function makeManager(modelPresent: boolean) {
  const store: Record<string, string> = { voice_enabled: 'true' }
  const notify = vi.fn()
  const worker = new FakeWorker()
  const models = {
    list: vi.fn(async () => []),
    install: vi.fn(async () => ({ id: DEFAULT_VOICE_MODEL_ID, installed: true })),
    resolve: vi.fn(async () => (modelPresent ? RESOLVED_MODEL : null)),
    remove: vi.fn(async () => undefined),
    removeAll: vi.fn(async () => undefined),
    isInstalled: vi.fn(async () => modelPresent),
  }
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
  const manager = new VoiceSessionManager({
    db: db as never,
    agents: {} as never,
    notify,
    runtimeRootDir: '/data/voice-runtime',
    models: models as unknown as VoiceModelManager,
    worker: worker as unknown as VoiceWorkerClient,
  })
  return { manager, worker, notify, models, db, store }
}

function progressStages(notify: ReturnType<typeof vi.fn>): string[] {
  return notify.mock.calls
    .filter(([channel]) => channel === 'voice:runtimeProgress')
    .map(([, data]) => (data as { stage: string }).stage)
}

beforeEach(() => {
  installer.detectVoiceRuntime.mockReset()
  installer.installVoiceRuntime.mockReset()
})

describe('one-action voice setup', () => {
  it('installs the runtime and the model, then loads it', async () => {
    // Absent at the first check, present after the install.
    installer.detectVoiceRuntime
      .mockResolvedValueOnce(ABSENT)
      .mockResolvedValue(PRESENT)
    installer.installVoiceRuntime.mockResolvedValue(PRESENT)

    const ctx = makeManager(false)
    // The model appears once it has been installed.
    ctx.models.resolve
      .mockResolvedValueOnce(null)
      .mockResolvedValue(RESOLVED_MODEL)

    const runtime = await ctx.manager.installRuntime()

    expect(installer.installVoiceRuntime).toHaveBeenCalledTimes(1)
    expect(ctx.models.install).toHaveBeenCalledWith(DEFAULT_VOICE_MODEL_ID)
    expect(ctx.store.voice_model_id).toBe(DEFAULT_VOICE_MODEL_ID)
    // The model is loaded at the end, so the user has nothing left to do.
    expect(ctx.worker.load).toHaveBeenCalledWith(RESOLVED_MODEL)
    expect(runtime.installed).toBe(true)
    expect(progressStages(ctx.notify).at(-1)).toBe('complete')
  })

  it('downloads only the model when the runtime is already there', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(false)
    ctx.models.resolve.mockResolvedValueOnce(null).mockResolvedValue(RESOLVED_MODEL)

    await ctx.manager.installRuntime()

    expect(installer.installVoiceRuntime).not.toHaveBeenCalled()
    expect(ctx.models.install).toHaveBeenCalledTimes(1)
  })

  it('downloads nothing when both are already there', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(true)

    await ctx.manager.installRuntime()

    expect(installer.installVoiceRuntime).not.toHaveBeenCalled()
    expect(ctx.models.install).not.toHaveBeenCalled()
    expect(ctx.worker.load).toHaveBeenCalledWith(RESOLVED_MODEL)
  })

  it('reports a failed model download instead of claiming success', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(false)
    ctx.models.resolve.mockResolvedValue(null)
    ctx.models.install.mockRejectedValue(new Error('checksum mismatch'))

    await expect(ctx.manager.installRuntime()).rejects.toThrow(/checksum mismatch/)
    expect(progressStages(ctx.notify).at(-1)).toBe('error')
    expect(ctx.worker.load).not.toHaveBeenCalled()
  })

  it('reports a failed runtime install instead of downloading a model', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(ABSENT)
    installer.installVoiceRuntime.mockRejectedValue(new Error('npm was not found'))
    const ctx = makeManager(false)

    await expect(ctx.manager.installRuntime()).rejects.toThrow(/npm was not found/)
    expect(ctx.models.install).not.toHaveBeenCalled()
    expect(progressStages(ctx.notify).at(-1)).toBe('error')
  })
})
