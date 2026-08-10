/**
 * Listening while 20x is talking (design §5.7 barge-in).
 *
 * In a conversation the microphone stays open, so while an answer is being read
 * the microphone hears the loudspeaker. Two things must be true at once:
 *
 *  1. The recogniser must never be given 20x's own voice. Otherwise the answer
 *     is transcribed as if the user had said it, and 20x replies to itself.
 *  2. The user must still be able to interrupt by simply speaking, without
 *     pressing anything.
 *
 * The gate does both. While an answer is being read it holds the audio back
 * instead of sending it, and it watches how loud that held audio is. Speech from
 * a person in the room is far louder than what the echo canceller leaves behind,
 * so a sustained loud passage means the user is talking: the answer is stopped
 * and the held audio is released, so the first words of the reply are not lost.
 *
 * Echo cancellation is switched on at the microphone as well. This gate does
 * not trust it on its own: it is a browser feature whose reference signal
 * differs by platform, and a single leaked sentence would be enough to make 20x
 * answer itself.
 */

import { VOICE_SAMPLE_RATE } from '@shared/voice'

/**
 * A held passage must be this loud to count as a person speaking.
 *
 * Root-mean-square of the samples, 0..1. Ordinary speech at the microphone sits
 * near 0.05 to 0.2; what the echo canceller leaves behind is well under 0.02.
 */
export const BARGE_IN_LEVEL = 0.06

/**
 * And it must stay that loud for this long.
 *
 * One short knock or cough must not cut an answer off, so the level has to hold
 * rather than merely peak.
 */
export const BARGE_IN_HOLD_MS = 300

/**
 * How much held audio is released when the user interrupts.
 *
 * The interruption is only recognised after `BARGE_IN_HOLD_MS`, so without this
 * the recogniser would miss the first word of the reply.
 */
export const BARGE_IN_PREROLL_MS = 600

export interface BargeInGateOptions {
  /** Called once, when the held audio shows that the user has started talking. */
  onBargeIn: () => void
  levelThreshold?: number
  holdMs?: number
  preRollMs?: number
}

export class BargeInGate {
  private speaking = false
  private held: Uint8Array[] = []
  private heldMs = 0
  private loudMs = 0

  constructor(private options: BargeInGateOptions) {}

  private get levelThreshold(): number {
    return this.options.levelThreshold ?? BARGE_IN_LEVEL
  }
  private get holdMs(): number {
    return this.options.holdMs ?? BARGE_IN_HOLD_MS
  }
  private get preRollMs(): number {
    return this.options.preRollMs ?? BARGE_IN_PREROLL_MS
  }

  /** True while an answer is being read and audio is being held back. */
  get isHolding(): boolean {
    return this.speaking
  }

  /** Follows the audio state: 20x has started or stopped reading. */
  setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return
    this.speaking = speaking
    this.reset()
  }

  /** Forgets the held audio. Used when a turn ends. */
  reset(): void {
    this.held = []
    this.heldMs = 0
    this.loudMs = 0
  }

  /**
   * Takes one batch of microphone audio and returns what the recogniser may
   * have — nothing at all while an answer is being read, and the held passage
   * at the moment the user interrupts.
   */
  push(chunk: Uint8Array): Uint8Array[] {
    if (!this.speaking) return chunk.length > 0 ? [chunk] : []
    if (chunk.length < 2) return []

    const ms = (chunk.length / 2 / VOICE_SAMPLE_RATE) * 1000
    this.held.push(chunk)
    this.heldMs += ms
    // Keep only the tail: this is a pre-roll, not a recording.
    while (this.heldMs > this.preRollMs && this.held.length > 1) {
      const dropped = this.held.shift()
      if (dropped) this.heldMs -= (dropped.length / 2 / VOICE_SAMPLE_RATE) * 1000
    }

    this.loudMs = rmsOfPcm16(chunk) >= this.levelThreshold ? this.loudMs + ms : 0
    if (this.loudMs < this.holdMs) return []

    // The user is talking. Stop the answer and hand over what was held, so the
    // reply is recognised from its first word.
    const release = this.held
    this.speaking = false
    this.held = []
    this.heldMs = 0
    this.loudMs = 0
    this.options.onBargeIn()
    return release
  }
}

/** Loudness of one batch of signed 16-bit little-endian PCM, 0..1. */
export function rmsOfPcm16(chunk: Uint8Array): number {
  const samples = Math.floor(chunk.length / 2)
  if (samples === 0) return 0
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const value = view.getInt16(i * 2, true) / 32768
    sum += value * value
  }
  return Math.sqrt(sum / samples)
}
