import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
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

function waitFor<T>(register: (resolve: (value: T) => void) => void, ms = 4000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the worker did not answer in time')), ms)
    register((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

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
