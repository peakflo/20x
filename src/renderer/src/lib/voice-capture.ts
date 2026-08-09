/**
 * Microphone capture for voice control (design §5.1 "Renderer process").
 *
 * The renderer captures audio and nothing else. It does no recognition, keeps
 * no recording, and never writes audio to disk. Audio leaves as 16 kHz mono
 * signed 16-bit PCM in about 100 ms batches.
 *
 * There is one capture object for the whole window, so two components can never
 * hold the microphone at the same time.
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
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private pending: number[] = []
  private handlers: VoiceCaptureHandlers | null = null

  get isCapturing(): boolean {
    return this.stream !== null
  }

  async start(handlers: VoiceCaptureHandlers, deviceId?: string): Promise<boolean> {
    if (this.stream) return true
    this.handlers = handlers
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      // Chromium resamples to the requested rate, so no decimation is needed
      // here and the audio thread stays cheap.
      this.context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE })
      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      try {
        await this.context.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }

      this.node = new AudioWorkletNode(this.context, 'voice-pcm')
      this.node.port.onmessage = (event: MessageEvent<{ samples: Int16Array; level: number }>) => {
        this.handlers?.onLevel?.(event.data.level)
        this.collect(event.data.samples)
      }
      this.source = this.context.createMediaStreamSource(this.stream)
      this.source.connect(this.node)
      // The worklet emits no audio, so it is not connected to the destination:
      // the user never hears their own microphone.
      return true
    } catch (err) {
      this.stop()
      const message =
        err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
          ? 'Microphone access was refused.'
          : err instanceof DOMException && err.name === 'NotFoundError'
            ? 'No microphone was found.'
            : err instanceof Error
              ? err.message
              : 'The microphone could not be opened.'
      handlers.onError?.(message)
      return false
    }
  }

  /** Flushes whatever is buffered and releases the microphone. */
  stop(): void {
    this.flush()
    this.node?.port.close()
    this.node?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close().catch(() => undefined)
    this.node = null
    this.source = null
    this.stream = null
    this.context = null
    this.pending = []
    this.handlers?.onLevel?.(0)
    this.handlers = null
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

/** The single microphone owner for this window. */
export const voiceCapture = new VoiceCapture()
