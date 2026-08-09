/**
 * Microphone capture for voice control (design §5.1 "Renderer process").
 *
 * The renderer captures audio and nothing else. It does no recognition, keeps
 * no recording, and never writes audio to disk. Audio leaves as 16 kHz mono
 * signed 16-bit PCM in about 100 ms batches.
 *
 * There is one capture object for the whole window, so two components can never
 * hold the microphone at the same time.
 *
 * The AudioContext and the worklet are created once and then reused. Chromium
 * allows only a small number of AudioContexts per document (six), and
 * `close()` frees the slot asynchronously, so a context per turn stops working
 * after a few turns. Only the microphone stream is per turn.
 */

import { VOICE_SAMPLE_RATE } from '@shared/voice'

/** Send about this much audio per IPC message. */
const BATCH_SAMPLES = VOICE_SAMPLE_RATE / 10

/**
 * Runs inside the audio thread. It only converts float samples to 16-bit and
 * reports a level, so it cannot stall the user interface.
 */
const WORKLET_SOURCE = `
class VoicePcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    const samples = new Int16Array(channel.length)
    let sum = 0
    for (let i = 0; i < channel.length; i++) {
      const clamped = Math.max(-1, Math.min(1, channel[i]))
      samples[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      sum += clamped * clamped
    }
    this.port.postMessage(
      { samples, level: Math.sqrt(sum / channel.length) },
      [samples.buffer]
    )
    return true
  }
}
registerProcessor('voice-pcm', VoicePcmProcessor)
`

export interface VoiceCaptureHandlers {
  /** One batch of 16-bit little-endian PCM. */
  onAudio: (chunk: Uint8Array) => void
  /** 0..1 microphone level, for the audio state indicator. */
  onLevel?: (level: number) => void
  onError?: (message: string) => void
}

export class VoiceCapture {
  // Reused for the lifetime of the window.
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private ready: Promise<void> | null = null
  // Per turn.
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private pending: number[] = []
  private handlers: VoiceCaptureHandlers | null = null

  get isCapturing(): boolean {
    return this.stream !== null
  }

  /** Builds the audio graph once. Later turns reuse it. */
  private async ensureGraph(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE })
      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      try {
        await context.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const node = new AudioWorkletNode(context, 'voice-pcm')
      node.port.onmessage = (event: MessageEvent<{ samples: Int16Array; level: number }>) => {
        // Frames that arrive between turns are dropped: no handlers, no audio.
        if (!this.handlers) return
        this.handlers.onLevel?.(event.data.level)
        this.collect(event.data.samples)
      }
      this.context = context
      this.node = node
    })().catch((err) => {
      // Let the next turn try again rather than fail for ever.
      this.ready = null
      throw err
    })
    return this.ready
  }

  async start(handlers: VoiceCaptureHandlers, deviceId?: string): Promise<boolean> {
    if (this.stream) return true
    try {
      await this.ensureGraph()
      const context = this.context
      const node = this.node
      if (!context || !node) throw new Error('The audio graph is not available.')

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      // A context can be suspended by the browser between turns.
      if (context.state === 'suspended') await context.resume()

      this.handlers = handlers
      this.source = context.createMediaStreamSource(this.stream)
      this.source.connect(node)
      // The worklet emits no audio, so it is not connected to the destination:
      // the user never hears their own microphone.
      return true
    } catch (err) {
      this.stop()
      handlers.onError?.(describe(err))
      return false
    }
  }

  /** Flushes whatever is buffered and releases the microphone. */
  stop(): void {
    this.flush()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.source = null
    this.stream = null
    this.pending = []
    this.handlers?.onLevel?.(0)
    this.handlers = null
    // The context and the worklet stay alive for the next turn.
  }

  /** Releases the audio graph as well. Used when voice is switched off. */
  async release(): Promise<void> {
    this.stop()
    const context = this.context
    this.node?.disconnect()
    this.node = null
    this.context = null
    this.ready = null
    await context?.close().catch(() => undefined)
  }

  private collect(samples: Int16Array): void {
    for (let i = 0; i < samples.length; i++) this.pending.push(samples[i])
    while (this.pending.length >= BATCH_SAMPLES) {
      this.emit(this.pending.splice(0, BATCH_SAMPLES))
    }
  }

  private flush(): void {
    if (this.pending.length === 0) return
    this.emit(this.pending.splice(0, this.pending.length))
  }

  private emit(samples: number[]): void {
    const buffer = new ArrayBuffer(samples.length * 2)
    const view = new DataView(buffer)
    for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true)
    this.handlers?.onAudio(new Uint8Array(buffer))
  }
}

function describe(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      return 'Microphone access was refused.'
    }
    if (err.name === 'NotFoundError') return 'No microphone was found.'
    if (err.name === 'NotReadableError') return 'The microphone is in use by another application.'
  }
  return err instanceof Error ? err.message : 'The microphone could not be opened.'
}

/** The single microphone owner for this window. */
export const voiceCapture = new VoiceCapture()
