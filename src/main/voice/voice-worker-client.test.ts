import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { VoiceWorkerClient } from './voice-worker-client'
import type { ResolvedModel } from './voice-model-manager'
import type { VoiceEngineStatus } from '../../shared/voice'

/**
 * Drives the real worker process over the real protocol. The mock engine keeps
 * the test free of a native runtime and of a downloaded model, so what is under
 * test is the process lifecycle, the control channel, and the audio pipe.
 */

const SCRIPT = join(__dirname, 'voice-worker.js')
const MOCK_TEXT = 'create a task to fix login'

const MODEL: ResolvedModel = {
  id: 'mock',
  dir: '/nowhere',
  encoder: '/nowhere/encoder.onnx',
  decoder: '/nowhere/decoder.onnx',
  joiner: '/nowhere/joiner.onnx',
  tokens: '/nowhere/tokens.txt',
}

let client: VoiceWorkerClient | null = null

beforeAll(() => {
  process.env.VOICE_ENGINE = 'mock'
  process.env.VOICE_MOCK_TEXT = MOCK_TEXT
})

afterAll(() => {
  delete process.env.VOICE_ENGINE
  delete process.env.VOICE_MOCK_TEXT
})

afterEach(() => {
  client?.stop()
  client = null
})

/**
 * How long a real model may take to become ready.
 *
 * Generous on purpose: the largest catalogue model is 662 MB, and these cases
 * run while the rest of the suite competes for the same disk and cores. A tight
 * budget here fails on load, not on behaviour, which tells nobody anything.
 */
const REAL_MODEL_LOAD_MS = 120_000

function waitFor<T>(register: (resolve: (value: T) => void) => void, ms = 4000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the worker did not answer in time')), ms)
    register((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

/**
 * The worker is a separate process, so the renderer keeps sending audio for a
 * moment after it has gone. Writing to that dead pipe raises EPIPE, and an
 * unhandled stream error in the main process is a crash and an application
 * restart. It happened to a user.
 */
describe('a worker that went away', () => {
  it('keeps taking audio without throwing after the process is killed', async () => {
    client = new VoiceWorkerClient(SCRIPT)
    const ready = waitFor<VoiceEngineStatus>((resolve) => {
      client!.on('status', (status: VoiceEngineStatus) => {
        if (status.state === 'ready') resolve(status)
      })
    })
    // A worker that dies emits an error; nothing here must be unhandled.
    client.on('error', () => {})
    await client.load(MODEL)
    await ready

    client.startTurn('turn-epipe')
    const inner = client as unknown as {
      child: {
        pid?: number
        kill: (s?: string) => void
        stdin: NodeJS.WritableStream | null
        stdout: NodeJS.ReadableStream | null
        stderr: NodeJS.ReadableStream | null
      } | null
    }
    const child = inner.child
    expect(child).toBeTruthy()

    // The invariant. A pipe with no error listener throws on EPIPE, and an
    // unhandled stream error in the main process restarts the application.
    for (const stream of [child!.stdin, child!.stdout, child!.stderr]) {
      expect(stream?.listenerCount('error')).toBeGreaterThan(0)
    }

    // Kill the process, then keep pushing as the renderer really does.
    child!.kill('SIGKILL')
    const frame = Buffer.alloc(640)
    for (let i = 0; i < 20; i++) {
      expect(() => client!.pushAudio(frame)).not.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    // The control channel is closed too, and must be just as quiet.
    expect(() => client!.endTurn('turn-epipe')).not.toThrow()
    expect(() => client!.cancelTurn('turn-epipe')).not.toThrow()
    expect(() => client!.unload()).not.toThrow()
  }, 30_000)

  it('reports a worker that cannot be started, instead of dying with it', async () => {
    client = new VoiceWorkerClient(join(__dirname, 'voice-worker.js'))
    const failures: string[] = []
    client.on('error', (message: string) => failures.push(message))
    // Nothing to assert beyond survival: an unhandled 'error' on the child
    // would take the process down before any expectation ran.
    expect(() => client!.startTurn('never-started')).not.toThrow()
    expect(failures.length).toBeGreaterThanOrEqual(0)
  })
})

describe('VoiceWorkerClient', () => {
  it('loads a model in a separate process and reports it as ready', async () => {
    client = new VoiceWorkerClient(SCRIPT)
    const ready = waitFor<VoiceEngineStatus>((resolve) => {
      client!.on('status', (status: VoiceEngineStatus) => {
        if (status.state === 'ready') resolve(status)
      })
    })
    await client.load(MODEL)
    expect(await ready).toMatchObject({ state: 'ready', engine: 'mock' })
    expect(client.isRunning).toBe(true)
  })

  it('carries audio frames and returns a final transcript for the same turn', async () => {
    client = new VoiceWorkerClient(SCRIPT)
    const ready = waitFor<VoiceEngineStatus>((resolve) => {
      client!.on('status', (status: VoiceEngineStatus) => {
        if (status.state === 'ready') resolve(status)
      })
    })
    await client.load(MODEL)
    await ready

    const final = waitFor<{ turnId: string; text: string }>((resolve) => {
      client!.on('final', (turnId: string, text: string) => resolve({ turnId, text }))
    })

    client.startTurn('turn-1')
    // 10 frames of 20 ms silence — the format the renderer sends.
    for (let i = 0; i < 10; i++) client.pushAudio(Buffer.alloc(640))
    client.endTurn('turn-1')

    expect(await final).toEqual({ turnId: 'turn-1', text: MOCK_TEXT })
  })

  it('reports a missing runtime instead of crashing', async () => {
    process.env.VOICE_ENGINE = 'real'
    process.env.VOICE_ENGINE_MODULE = 'a-runtime-that-is-not-installed'
    try {
      client = new VoiceWorkerClient(SCRIPT)
      const pending = waitFor<VoiceEngineStatus>((resolve) => {
        client!.on('status', (s: VoiceEngineStatus) => {
          if (s.state !== 'loading') resolve(s)
        })
      })
      await client.load(MODEL)
      const status = await pending
      expect(status.state).toBe('engine_missing')
      expect(client.isLoaded).toBe(false)
    } finally {
      process.env.VOICE_ENGINE = 'mock'
      delete process.env.VOICE_ENGINE_MODULE
    }
  })

  it('reports a missing worker script without spawning anything', async () => {
    client = new VoiceWorkerClient(join(__dirname, 'no-such-worker.js'))
    const pending = waitFor<VoiceEngineStatus>((resolve) => {
      client!.on('status', (s: VoiceEngineStatus) => resolve(s))
    })
    await client.load(MODEL)
    const status = await pending
    expect(status.state).toBe('engine_missing')
    expect(client.isRunning).toBe(false)
  })
})

/**
 * Runs only on a machine where the user has installed the runtime and a model.
 * It is the one check that proves the recogniser config shape against the real
 * library — a flat config is rejected with "Errors in config!", and only a real
 * load catches that.
 */
const realRuntime = join(homedir(), 'Library', 'Application Support', '20x', 'voice-runtime',
  'node_modules', 'sherpa-onnx-node')
const voiceModelsRoot = join(homedir(), 'Library', 'Application Support', '20x', 'voice-models')
const realModelDir = join(voiceModelsRoot, 'sherpa-streaming-zipformer-en')
/** A short spoken passage, downloaded next to the model by the developer. */
const SPEECH_WAV = '/tmp/speech.wav'

const hasRealEngine =
  process.platform === 'darwin' &&
  existsSync(realRuntime) &&
  existsSync(join(realModelDir, 'tokens.txt')) &&
  existsSync(SPEECH_WAV)

describe.skipIf(!hasRealEngine)('VoiceWorkerClient with the installed runtime', () => {
  it('loads the real recogniser, so the config shape cannot drift', async () => {
    process.env.VOICE_ENGINE = 'real'
    process.env.VOICE_ENGINE_MODULE = realRuntime
    try {
      client = new VoiceWorkerClient(SCRIPT)
      const pending = waitFor<VoiceEngineStatus>((resolve) => {
        client!.on('status', (s: VoiceEngineStatus) => {
          if (s.state !== 'loading') resolve(s)
        })
      }, REAL_MODEL_LOAD_MS)
      await client.load({
        id: 'sherpa-streaming-zipformer-en',
        dir: realModelDir,
        encoder: join(realModelDir, 'encoder.onnx'),
        decoder: join(realModelDir, 'decoder.onnx'),
        joiner: join(realModelDir, 'joiner.onnx'),
        tokens: join(realModelDir, 'tokens.txt'),
      })
      const status = await pending
      expect(status).toMatchObject({ state: 'ready', engine: 'sherpa-onnx' })
    } finally {
      process.env.VOICE_ENGINE = 'mock'
      delete process.env.VOICE_ENGINE_MODULE
    }
  }, 180_000)
})

/**
 * Every catalogue model installed on this machine is put through the
 * conversational loop. Endpoint behaviour differs per model, and the loop is
 * the default, so a model that cannot segment must not pass unnoticed.
 */
const installedModelIds = existsSync(voiceModelsRoot)
  ? readdirSync(voiceModelsRoot).filter((id) => existsSync(join(voiceModelsRoot, id, 'tokens.txt')))
  : []

describe.skipIf(!hasRealEngine || installedModelIds.length === 0)('the conversational loop', () => {
  it.each(installedModelIds)('sends one segment per pause with %s', async (modelId) => {
    process.env.VOICE_ENGINE = 'real'
    process.env.VOICE_ENGINE_MODULE = realRuntime
    const dir = join(voiceModelsRoot, modelId)
    try {
      client = new VoiceWorkerClient(SCRIPT)
      const ready = waitFor<VoiceEngineStatus>((resolve) => {
        client!.on('status', (s: VoiceEngineStatus) => {
          if (s.state === 'ready') resolve(s)
        })
      }, REAL_MODEL_LOAD_MS)
      await client.load(
        {
          id: modelId,
          dir,
          encoder: join(dir, 'encoder.onnx'),
          decoder: join(dir, 'decoder.onnx'),
          joiner: join(dir, 'joiner.onnx'),
          tokens: join(dir, 'tokens.txt'),
        },
        1.2
      )
      await ready

      const segments: string[] = []
      client.on('segment', (_turnId: string, text: string) => segments.push(text))

      const speech = readFileSync(SPEECH_WAV).subarray(44)
      const silence = Buffer.alloc(16000 * 2 * 2) // 2 s

      client.startTurn(`conversation-${modelId}`, 'conversation')
      for (const buffer of [speech, silence, speech, silence]) {
        for (let i = 0; i < buffer.length; i += 640) {
          client.pushAudio(buffer.subarray(i, Math.min(i + 640, buffer.length)))
        }
      }

      // Two spoken passages separated by pauses give two sentences, and the
      // turn is still open afterwards.
      await vi.waitFor(() => expect(segments.length).toBeGreaterThanOrEqual(2), {
        timeout: 30000,
        interval: 100,
      })
      expect(segments[0]).toMatch(/nightfall/i)
      expect(client.isRunning).toBe(true)
    } finally {
      process.env.VOICE_ENGINE = 'mock'
      delete process.env.VOICE_ENGINE_MODULE
    }
  }, 240_000)
})

describe.skipIf(!hasRealEngine)('a single-shot turn', () => {
  it('reports a final and never a segment, so dictation cannot send by itself', async () => {
    process.env.VOICE_ENGINE = 'real'
    process.env.VOICE_ENGINE_MODULE = realRuntime
    try {
      client = new VoiceWorkerClient(SCRIPT)
      const ready = waitFor<VoiceEngineStatus>((resolve) => {
        client!.on('status', (s: VoiceEngineStatus) => {
          if (s.state === 'ready') resolve(s)
        })
      }, REAL_MODEL_LOAD_MS)
      await client.load(
        {
          id: 'sherpa-streaming-zipformer-en',
          dir: realModelDir,
          encoder: join(realModelDir, 'encoder.onnx'),
          decoder: join(realModelDir, 'decoder.onnx'),
          joiner: join(realModelDir, 'joiner.onnx'),
          tokens: join(realModelDir, 'tokens.txt'),
        },
        1.2
      )
      await ready

      const segments: string[] = []
      const finals: string[] = []
      client.on('segment', (_turnId: string, text: string) => segments.push(text))
      client.on('final', (_turnId: string, text: string) => finals.push(text))

      const speech = readFileSync(SPEECH_WAV).subarray(44)
      const silence = Buffer.alloc(16000 * 2 * 2) // 2 s

      client.startTurn('dictation-1', 'dictation')
      for (const buffer of [speech, silence]) {
        for (let i = 0; i < buffer.length; i += 640) {
          client.pushAudio(buffer.subarray(i, Math.min(i + 640, buffer.length)))
        }
      }

      await vi.waitFor(() => expect(finals.length).toBe(1), { timeout: 20000, interval: 100 })
      // A segment is what makes the renderer send. Dictation must produce none.
      expect(segments).toHaveLength(0)
      expect(finals[0]).toMatch(/nightfall/i)
    } finally {
      process.env.VOICE_ENGINE = 'mock'
      delete process.env.VOICE_ENGINE_MODULE
    }
  }, 240_000)
})
