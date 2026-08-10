/**
 * Playback of spoken answers (design §5.7).
 *
 * The renderer plays audio and nothing else. It never produces speech, never
 * decides what may be spoken, and keeps no recording.
 *
 * Sentences arrive one at a time while the rest are still being produced, so
 * each one is scheduled to start exactly where the previous one ends. That is
 * what makes an answer sound continuous even though the model is barely faster
 * than speech.
 *
 * There is one playback object for the whole window, so two answers can never
 * talk over each other. The AudioContext is created once and reused: Chromium
 * allows only a few per document, and `close()` frees the slot asynchronously.
 */

export interface VoicePlaybackHandlers {
  /** 0..1 loudness, for the audio state indicator. */
  onLevel?: (level: number) => void
  /** Called when every queued sentence has finished playing. */
  onDrained?: () => void
}

/** A gap this small is inaudible and protects against a late first chunk. */
const SCHEDULING_LEAD_SECONDS = 0.06

export class VoicePlayback {
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private speechId: string | null = null
  private nextStartTime = 0
  private pending = 0
  private levelTimer: number | null = null
  private handlers: VoicePlaybackHandlers = {}

  get isPlaying(): boolean {
    return this.speechId !== null
  }

  get currentSpeechId(): string | null {
    return this.speechId
  }

  /** Opens a new passage. Any passage still playing is dropped. */
  start(speechId: string, handlers: VoicePlaybackHandlers = {}): void {
    this.stop()
    this.handlers = handlers
    this.speechId = speechId
    this.pending = 0
    this.nextStartTime = 0
  }

  /**
   * Queues one sentence.
   *
   * A chunk from an older passage is dropped, so a cancelled answer cannot be
   * heard after the user has moved on.
   */
  play(speechId: string, pcm: Uint8Array, sampleRate: number): void {
    if (speechId !== this.speechId) return
    if (!pcm || pcm.length < 2 || sampleRate <= 0) return

    const context = this.ensureContext()
    if (!context) return
    if (context.state === 'suspended') void context.resume()

    const buffer = toAudioBuffer(context, pcm, sampleRate)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.analyser ?? context.destination)

    const startAt = Math.max(context.currentTime + SCHEDULING_LEAD_SECONDS, this.nextStartTime)
    this.nextStartTime = startAt + buffer.duration
    this.pending += 1
    source.onended = () => {
      this.sources.delete(source)
      this.pending -= 1
      if (this.pending <= 0 && this.speechId === speechId) this.handlers.onDrained?.()
    }
    this.sources.add(source)
    source.start(startAt)
    this.startLevelReporting()
  }

  /** Stops at once and forgets everything queued. This is barge-in. */
  stop(): void {
    for (const source of this.sources) {
      try {
        source.onended = null
        source.stop()
      } catch {
        /* the sentence had already finished */
      }
    }
    this.sources.clear()
    this.speechId = null
    this.pending = 0
    this.nextStartTime = 0
    this.stopLevelReporting()
    this.handlers.onLevel?.(0)
  }

  /** Releases the audio graph. Used when spoken answers are switched off. */
  async release(): Promise<void> {
    this.stop()
    const context = this.context
    this.analyser?.disconnect()
    this.analyser = null
    this.context = null
    await context?.close().catch(() => undefined)
  }

  // ── Internals ─────────────────────────────────────────────

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context
    if (typeof AudioContext === 'undefined') return null
    // No sample rate is requested: the samples are resampled by the buffer, and
    // forcing a rate here would fight the output device.
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    analyser.connect(context.destination)
    this.context = context
    this.analyser = analyser
    return context
  }

  private startLevelReporting(): void {
    if (this.levelTimer !== null || !this.handlers.onLevel || !this.analyser) return
    const data = new Uint8Array(this.analyser.frequencyBinCount)
    const tick = (): void => {
      const analyser = this.analyser
      if (!analyser || !this.speechId) return
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const centred = (data[i] - 128) / 128
        sum += centred * centred
      }
      this.handlers.onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 2))
      this.levelTimer = window.setTimeout(tick, 60)
    }
    tick()
  }

  private stopLevelReporting(): void {
    if (this.levelTimer !== null) window.clearTimeout(this.levelTimer)
    this.levelTimer = null
  }
}

/** Signed 16-bit little-endian PCM to one mono audio buffer. */
export function toAudioBuffer(context: BaseAudioContext, pcm: Uint8Array, sampleRate: number): AudioBuffer {
  const samples = Math.floor(pcm.length / 2)
  const buffer = context.createBuffer(1, samples, sampleRate)
  const channel = buffer.getChannelData(0)
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  for (let i = 0; i < samples; i++) {
    channel[i] = view.getInt16(i * 2, true) / 32768
  }
  return buffer
}

/** The single speaker for this window. */
export const voicePlayback = new VoicePlayback()
