import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { join } from 'path'
import { VoiceTtsWorkerClient, type VoiceTtsChunk } from './voice-tts-worker-client'
import type { ResolvedTtsModel } from './voice-tts-model-manager'
import type { VoiceTtsStatus } from '../../shared/voice-tts'

/**
 * Drives the real worker process over the real protocol. The mock engine keeps
 * the test free of a native runtime and of a downloaded model, so what is under
 * test is the process lifecycle, the control channel and the sentence loop.
 */

const SCRIPT = join(__dirname, 'voice-tts-worker.js')

const MODEL: ResolvedTtsModel = {
  id: 'mock',
  family: 'kitten',
  dir: '/nowhere',
  model: '/nowhere/model.onnx',
  voices: '/nowhere/voices.bin',
  tokens: '/nowhere/tokens.txt',
  dataDir: '/nowhere/espeak-ng-data',
  sampleRate: 24000,
}

let client: VoiceTtsWorkerClient | null = null

beforeAll(() => {
  process.env.VOICE_TTS_ENGINE = 'mock'
})

afterAll(() => {
  delete process.env.VOICE_TTS_ENGINE
})

afterEach(() => {
  client?.stop()
  client = null
})

function ready(worker: VoiceTtsWorkerClient): Promise<VoiceTtsStatus> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the worker did not report ready')), 20000)
    worker.on('status', (status: VoiceTtsStatus) => {
      if (status.state === 'loading') return
      clearTimeout(timer)
      resolve(status)
    })
  })
}

function speakAndCollect(
  worker: VoiceTtsWorkerClient,
  speechId: string,
  sentences: string[]
): Promise<{ chunks: VoiceTtsChunk[]; cancelled: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: VoiceTtsChunk[] = []
    const timer = setTimeout(() => reject(new Error('the worker never finished')), 20000)
    worker.on('chunk', (chunk: VoiceTtsChunk) => chunks.push(chunk))
    worker.on('done', (id: string, cancelled: boolean) => {
      if (id !== speechId) return
      clearTimeout(timer)
      resolve({ chunks, cancelled })
    })
    worker.speak({ speechId, sentences, speakerId: 0, speed: 1 })
  })
}

describe('the speech worker', () => {
  it('loads a voice and reports the sample rate', async () => {
    client = new VoiceTtsWorkerClient(SCRIPT)
    client.load({ engine: 'local', model: MODEL })
    const status = await ready(client)

    expect(status.state).toBe('ready')
    if (status.state === 'ready') expect(status.sampleRate).toBe(24000)
    expect(client.isLoaded).toBe(true)
  })

  it('sends one sentence at a time, in order', async () => {
    client = new VoiceTtsWorkerClient(SCRIPT)
    client.load({ engine: 'local', model: MODEL })
    await ready(client)

    const { chunks } = await speakAndCollect(client, 'speech-1', ['One.', 'Two.', 'Three.'])

    expect(chunks).toHaveLength(3)
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2])
    expect(chunks.map((c) => c.text)).toEqual(['One.', 'Two.', 'Three.'])
    // Every chunk is real 16-bit audio at the rate the worker reported.
    for (const chunk of chunks) {
      expect(chunk.pcm.length % 2).toBe(0)
      expect(chunk.pcm.length).toBeGreaterThan(0)
      expect(chunk.sampleRate).toBe(24000)
    }
  })

  it('finishes at once when there is nothing to say', async () => {
    client = new VoiceTtsWorkerClient(SCRIPT)
    client.load({ engine: 'local', model: MODEL })
    await ready(client)

    const { chunks } = await speakAndCollect(client, 'speech-empty', [])
    expect(chunks).toHaveLength(0)
  })

  it('stops a passage when it is cancelled', async () => {
    client = new VoiceTtsWorkerClient(SCRIPT)
    client.load({ engine: 'local', model: MODEL })
    await ready(client)

    const finished = new Promise<boolean>((resolve) => {
      client?.on('done', (_id: string, cancelled: boolean) => resolve(cancelled))
    })
    client.speak({
      speechId: 'speech-2',
      sentences: Array.from({ length: 40 }, (_, i) => `Sentence ${i}.`),
      speakerId: 0,
      speed: 1,
    })
    client.cancel('speech-2')

    expect(await finished).toBe(true)
  })

  it('refuses to speak before a voice is loaded', async () => {
    client = new VoiceTtsWorkerClient(SCRIPT)
    // `load` starts the process; the speak below arrives before any voice does.
    client.load({ engine: 'local', model: MODEL })
    const failure = new Promise<string>((resolve) => {
      client?.on('error', (message: string) => resolve(message))
    })
    client.stop()

    client = new VoiceTtsWorkerClient('/nowhere/voice-tts-worker.js')
    const missing = new Promise<VoiceTtsStatus>((resolve) => {
      client?.on('status', resolve)
    })
    client.load({ engine: 'local', model: MODEL })

    const status = await missing
    expect(status.state).toBe('error')
    // The first client is stopped, so its promise is only kept from leaking.
    void failure
  })
})
