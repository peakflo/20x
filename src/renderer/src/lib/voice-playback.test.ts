import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { VoicePlayback, toAudioBuffer } from './voice-playback'

/**
 * Playback is the only part of spoken answers that lives in the renderer, and
 * the two things it must get right are: sentences play back to back with no
 * gap, and a stopped passage is silent at once.
 */

interface FakeSource {
  buffer: { duration: number } | null
  startedAt: number | null
  stopped: boolean
  onended: (() => void) | null
  connect: () => void
  start: (when: number) => void
  stop: () => void
}

const sources: FakeSource[] = []
let currentTime = 0

class FakeAudioContext {
  state = 'running'
  destination = {}
  get currentTime(): number {
    return currentTime
  }
  createAnalyser() {
    return {
      fftSize: 0,
      frequencyBinCount: 128,
      connect: () => {},
      disconnect: () => {},
      getByteTimeDomainData: (data: Uint8Array) => data.fill(128),
    }
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length)
    return {
      duration: length / sampleRate,
      length,
      sampleRate,
      getChannelData: () => data,
    }
  }
  createBufferSource(): FakeSource {
    const source: FakeSource = {
      buffer: null,
      startedAt: null,
      stopped: false,
      onended: null,
      connect: () => {},
      start(when: number) {
        this.startedAt = when
      },
      stop() {
        this.stopped = true
      },
    }
    sources.push(source)
    return source
  }
  resume() {
    return Promise.resolve()
  }
  close() {
    return Promise.resolve()
  }
}

/** 100 ms of silence at 24 kHz, as signed 16-bit little-endian PCM. */
function pcm(seconds: number, sampleRate = 24000): Uint8Array {
  return new Uint8Array(Math.round(seconds * sampleRate) * 2)
}

beforeEach(() => {
  sources.length = 0
  currentTime = 0
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('window', { ...globalThis.window, setTimeout, clearTimeout })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('VoicePlayback', () => {
  it('plays each sentence where the last one ends', () => {
    const playback = new VoicePlayback()
    playback.start('s1')
    playback.play('s1', pcm(1), 24000)
    playback.play('s1', pcm(2), 24000)

    expect(sources).toHaveLength(2)
    const first = sources[0].startedAt ?? 0
    // The second starts exactly where the first ends, so there is no gap.
    expect(sources[1].startedAt).toBeCloseTo(first + 1, 5)
  })

  it('drops a sentence from a passage that is no longer current', () => {
    const playback = new VoicePlayback()
    playback.start('s1')
    playback.play('s2', pcm(1), 24000)
    expect(sources).toHaveLength(0)
  })

  it('drops a sentence with no audio in it', () => {
    const playback = new VoicePlayback()
    playback.start('s1')
    playback.play('s1', new Uint8Array(0), 24000)
    playback.play('s1', pcm(1), 0)
    expect(sources).toHaveLength(0)
  })

  it('stops everything queued at once', () => {
    const playback = new VoicePlayback()
    playback.start('s1')
    playback.play('s1', pcm(1), 24000)
    playback.play('s1', pcm(1), 24000)

    playback.stop()

    expect(sources.every((s) => s.stopped)).toBe(true)
    expect(playback.isPlaying).toBe(false)
    expect(playback.currentSpeechId).toBeNull()
  })

  it('drops the old passage when a new one starts', () => {
    const playback = new VoicePlayback()
    playback.start('s1')
    playback.play('s1', pcm(1), 24000)

    playback.start('s2')

    expect(sources[0].stopped).toBe(true)
    expect(playback.currentSpeechId).toBe('s2')
  })

  /**
   * Main announces the start of a passage on every push, not once per passage.
   * Dropping the queue on each announcement cut off the sentence that was
   * sounding, whenever the voice produced faster than it played.
   */
  it('keeps playing when the passage it already has is opened again', () => {
    const playback = new VoicePlayback()
    playback.start('s1')
    playback.play('s1', pcm(1), 24000)
    playback.play('s1', pcm(1), 24000)

    playback.start('s1')

    expect(sources.some((s) => s.stopped)).toBe(false)
    expect(playback.hasQueuedAudio).toBe(true)
    expect(playback.currentSpeechId).toBe('s1')
  })

  it('keeps the sentences already queued in order when reopened', () => {
    const playback = new VoicePlayback()
    playback.start('s1')
    playback.play('s1', pcm(1), 24000)
    const firstStart = sources[0].startedAt ?? 0

    playback.start('s1')
    playback.play('s1', pcm(1), 24000)

    // The second sentence is still scheduled after the first, not on top of it.
    expect(sources[1].startedAt ?? 0).toBeGreaterThan(firstStart)
  })

  it('reports when everything queued has been heard', () => {
    const playback = new VoicePlayback()
    const drained = vi.fn()
    playback.start('s1', { onDrained: drained })
    playback.play('s1', pcm(1), 24000)
    playback.play('s1', pcm(1), 24000)

    sources[0].onended?.()
    expect(drained).not.toHaveBeenCalled()
    sources[1].onended?.()
    expect(drained).toHaveBeenCalledTimes(1)
  })

  /**
   * The queue empties between one sentence and the next whenever the voice
   * produces the next sentence more slowly than the last one takes to play.
   * That is a pause, not the end of the answer — and the caller has to be able
   * to tell the two apart, because it opens the microphone gate on the end.
   */
  it('drains between sentences, so draining cannot mean the answer is over', () => {
    const playback = new VoicePlayback()
    const drained = vi.fn()
    playback.start('s1', { onDrained: drained })

    playback.play('s1', pcm(1), 24000)
    sources[0].onended?.()
    expect(drained).toHaveBeenCalledTimes(1)

    // The answer carries on: the next sentence arrives after the gap.
    playback.play('s1', pcm(1), 24000)
    sources[1].onended?.()
    expect(drained).toHaveBeenCalledTimes(2)
  })

  it('reports a level of zero when it stops', () => {
    const playback = new VoicePlayback()
    const onLevel = vi.fn()
    playback.start('s1', { onLevel })
    playback.play('s1', pcm(1), 24000)
    playback.stop()
    expect(onLevel).toHaveBeenLastCalledWith(0)
  })
})

describe('toAudioBuffer', () => {
  it('reads signed 16-bit little-endian samples', () => {
    const context = new FakeAudioContext() as unknown as BaseAudioContext
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0])
    const buffer = toAudioBuffer(context, bytes, 24000)
    const channel = buffer.getChannelData(0)

    expect(buffer.length).toBe(2)
    expect(channel[0]).toBeCloseTo(0.5, 3)
    expect(channel[1]).toBeCloseTo(-0.5, 3)
  })

  it('keeps the rate the worker reported', () => {
    const context = new FakeAudioContext() as unknown as BaseAudioContext
    expect(toAudioBuffer(context, pcm(1, 22050), 22050).sampleRate).toBe(22050)
  })
})
