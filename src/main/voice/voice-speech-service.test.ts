import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { VOICE_TTS_EVENTS, VOICE_TTS_SETTING_KEYS, type VoiceTtsVoice } from '../../shared/voice-tts'
import { VoiceSpeechService, localVoicesForModel } from './voice-speech-service'
import type { VoiceTtsWorkerClient } from './voice-tts-worker-client'
import type { VoiceTtsModelManager } from './voice-tts-model-manager'

/**
 * The rules of design §5.7 live here: the reason for speaking decides whether a
 * passage is spoken, an answer is only read when the user asked for it by
 * voice, and speech stops the moment the user talks.
 */

const SYSTEM_VOICES: VoiceTtsVoice[] = [
  { id: 'system:Samantha', label: 'Samantha', engine: 'system', speakerId: 0, modelId: '', language: 'en-US', description: '' },
  { id: 'system:Anna', label: 'Anna', engine: 'system', speakerId: 0, modelId: '', language: 'de-DE', description: '' },
]

class FakeWorker extends EventEmitter {
  spoken: Array<{ speechId: string; sentences: string[]; speakerId: number; speed: number; systemVoice?: string }> = []
  cancelled: string[] = []
  loads: unknown[] = []

  load(request: unknown): void {
    this.loads.push(request)
    this.emit('status', { state: 'ready', engine: 'system', modelId: '', voiceId: '', sampleRate: 24000 })
  }
  speak(request: { speechId: string; sentences: string[]; speakerId: number; speed: number; systemVoice?: string }): void {
    this.spoken.push(request)
  }
  cancel(speechId?: string): void {
    if (speechId) this.cancelled.push(speechId)
  }
  unload(): void {}
  stop(): void {}
  setRuntimeModulePath(): void {}
}

function makeService(settings: Record<string, string> = {}) {
  const store = new Map(Object.entries(settings))
  const worker = new FakeWorker()
  const events: Array<{ channel: string; data: unknown }> = []
  const models = {
    list: async () => [],
    resolve: async () => null,
    install: async () => undefined,
    remove: async () => undefined,
  } as unknown as VoiceTtsModelManager

  const service = new VoiceSpeechService({
    db: {
      getSetting: (key) => store.get(key),
      setSetting: (key, value) => {
        store.set(key, value)
      },
    },
    notifyRenderer: (channel, data) => events.push({ channel, data }),
    modelRootDir: '/nowhere',
    worker: worker as unknown as VoiceTtsWorkerClient,
    models,
    listVoices: async () => SYSTEM_VOICES,
  })
  return { service, worker, events, store }
}

let clock = 0
beforeEach(() => {
  clock = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})

describe('the speaking policy', () => {
  it('reads an agent answer only when spoken answers are on', async () => {
    const off = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'false' })
    await off.service.prepare()
    expect(await off.service.speak({ text: 'Done.', source: 'agent_answer', voiceTurnId: 't1' })).toBe(false)

    const on = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await on.service.prepare()
    expect(await on.service.speak({ text: 'Done.', source: 'agent_answer', voiceTurnId: 't1' })).toBe(true)
  })

  it('refuses an agent answer with no voice turn while the rule is on', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    expect(await service.speak({ text: 'Done.', source: 'agent_answer' })).toBe(false)
  })

  it('reads any agent answer once the rule is switched off', async () => {
    const { service } = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.onlyVoiceTurns]: 'false',
    })
    await service.prepare()
    expect(await service.speak({ text: 'Done.', source: 'agent_answer' })).toBe(true)
  })

  it('reads a button press even when automatic reading is off', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'false' })
    await service.prepare()
    expect(await service.speak({ text: 'Read me.', source: 'manual' })).toBe(true)
    expect(await service.speak({ text: 'Sample.', source: 'preview' })).toBe(true)
    expect(await service.speak({ text: 'The answer.', source: 'read_last_answer' })).toBe(true)
  })

  it('says a short action result only when that switch is on', async () => {
    const off = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.speakActionResults]: 'false',
    })
    await off.service.prepare()
    expect(await off.service.speak({ text: 'Task created.', source: 'action_result' })).toBe(false)

    const on = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await on.service.prepare()
    expect(await on.service.speak({ text: 'Task created.', source: 'action_result' })).toBe(true)
  })

  it('never speaks empty text', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    expect(await service.speak({ text: '   ', source: 'manual' })).toBe(false)
  })
})

describe('answer correlation', () => {
  it('reads the answer to the question the user asked by voice', async () => {
    const { service, worker } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnswer('task-1', 'turn-9', clock)

    expect(await service.speakAgentAnswer('task-1', 'The test failed.')).toBe(true)
    expect(worker.spoken).toHaveLength(1)
  })

  it('says nothing about a task the user never asked about', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnswer('task-1', 'turn-9', clock)

    expect(await service.speakAgentAnswer('task-2', 'A background answer.')).toBe(false)
  })

  it('reads one answer per question, not every later answer', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnswer('task-1', 'turn-9', clock)

    expect(await service.speakAgentAnswer('task-1', 'First.')).toBe(true)
    expect(await service.speakAgentAnswer('task-1', 'Second.')).toBe(false)
  })

  it('forgets a question that was never answered in time', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnswer('task-1', 'turn-9', clock)
    clock += 11 * 60 * 1000

    expect(await service.speakAgentAnswer('task-1', 'Very late.')).toBe(false)
  })

  it('forgets a question when the turn is cancelled', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnswer('task-1', 'turn-9', clock)
    service.forgetAnswer('task-1')

    expect(await service.speakAgentAnswer('task-1', 'Dropped.')).toBe(false)
  })
})

describe('one voice at a time', () => {
  it('stops the passage being read before it starts the next one', async () => {
    const { service, worker } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    await service.speak({ text: 'First passage.', source: 'manual' })
    const first = worker.spoken[0].speechId

    await service.speak({ text: 'Second passage.', source: 'manual' })
    expect(worker.cancelled).toContain(first)
    expect(worker.spoken).toHaveLength(2)
  })

  it('stops at once when the user speaks', async () => {
    const { service, worker, events } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    await service.speak({ text: 'A long answer.', source: 'manual' })
    expect(service.speaking).toBe(true)

    service.stop('cancelled')

    expect(service.speaking).toBe(false)
    expect(worker.cancelled).toHaveLength(1)
    const end = events.filter((e) => e.channel === VOICE_TTS_EVENTS.speechEnd)
    expect(end).toHaveLength(1)
    expect((end[0].data as { reason: string }).reason).toBe('cancelled')
  })

  it('drops a sentence that belongs to a passage that was stopped', async () => {
    const { service, worker, events } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    await service.speak({ text: 'A long answer.', source: 'manual' })
    const speechId = worker.spoken[0].speechId
    service.stop('cancelled')

    worker.emit('chunk', { speechId, index: 0, pcm: Buffer.alloc(4), sampleRate: 24000, text: 'x' })

    expect(events.filter((e) => e.channel === VOICE_TTS_EVENTS.speechChunk)).toHaveLength(0)
  })

  it('reports the audio state to its listener', async () => {
    const { service, worker } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    const states: boolean[] = []
    service.setSpeakingListener((speaking) => states.push(speaking))

    await service.speak({ text: 'One.', source: 'manual' })
    worker.emit('done', worker.spoken[0].speechId, false)

    expect(states).toEqual([true, false])
  })
})

describe('what reaches the worker', () => {
  it('sends the cleaned passage, split into sentences', async () => {
    const { service, worker } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    await service.speak({ text: '## Result\n\nIt passed. Nothing else to do.', source: 'manual' })

    expect(worker.spoken[0].sentences).toEqual(['Result', 'It passed.', 'Nothing else to do.'])
  })

  it('sends the chosen system voice by name', async () => {
    const { service, worker } = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.voiceId]: 'system:Anna',
    })
    await service.prepare()
    await service.speak({ text: 'Hello.', source: 'manual' })

    expect(worker.spoken[0].systemVoice).toBe('Anna')
  })

  it('sends the speaker index of a downloaded voice', async () => {
    const { service, worker } = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.engine]: 'local',
      [VOICE_TTS_SETTING_KEYS.modelId]: 'kokoro-en-v0_19',
      [VOICE_TTS_SETTING_KEYS.voiceId]: 'local:kokoro-en-v0_19:7',
    })
    // The worker reports ready for whatever it is asked to load.
    worker.load({ engine: 'local' } as never)
    await service.speak({ text: 'Hello.', source: 'manual' })

    expect(worker.spoken[0].speakerId).toBe(7)
    expect(worker.spoken[0].systemVoice).toBeUndefined()
  })

  it('keeps a preview short whatever the reading limit says', async () => {
    const { service, worker } = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.maxChars]: '2400',
    })
    await service.prepare()
    await service.speak({ text: 'word '.repeat(400), source: 'preview' })

    expect(worker.spoken[0].sentences.join(' ').length).toBeLessThanOrEqual(300)
  })
})

describe('choosing a voice', () => {
  it('falls back to an English system voice when nothing is chosen', async () => {
    const { service } = makeService()
    await service.prepare()
    expect(service.voiceId()).toBe('system:Samantha')
  })

  it('ignores a stored voice that belongs to the other engine', async () => {
    const { service } = makeService({
      [VOICE_TTS_SETTING_KEYS.engine]: 'local',
      [VOICE_TTS_SETTING_KEYS.modelId]: 'kitten-nano-en-v0_2',
      [VOICE_TTS_SETTING_KEYS.voiceId]: 'system:Samantha',
    })
    expect(service.voiceId()).toBe('local:kitten-nano-en-v0_2:1')
  })

  it('offers only the speakers the catalogue publishes', () => {
    const voices = localVoicesForModel('kokoro-en-v0_19')
    expect(voices).toHaveLength(8)
    expect(voices.map((v) => v.speakerId)).not.toContain(4)
    expect(voices.every((v) => v.engine === 'local')).toBe(true)
  })
})
