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
 * The quietest a held passage may be and still count as a person speaking.
 *
 * Root-mean-square of the samples, 0..1. This is only the floor under the
 * measured threshold below: it stops a silent room from ever counting, and
 * nothing more.
 */
export const BARGE_IN_LEVEL = 0.015

/**
 * How much louder than the room the user has to be.
 *
 * A fixed level cannot work. The old one was 0.06, chosen from "ordinary
 * speech sits near 0.05 to 0.2" — but the microphone runs with echo
 * cancellation, noise suppression and automatic gain control all on, and all
 * three fight the user's voice at exactly the moment it overlaps the
 * loudspeaker. Two people talking at once is where they are weakest. A quiet
 * talker, or a talker one metre away, never reached 0.06, so the gate held
 * every word and 20x carried on as if nothing had been said.
 *
 * The level to beat is now measured, not assumed: whatever the echo canceller
 * leaves behind is the floor, and speech is several times that.
 */
export const BARGE_IN_FLOOR_FACTOR = 3

/**
 * How many recent batches the floor is measured over.
 *
 * The quietest of the last second. A window, not an all-time minimum: the room
 * changes, and a single quiet moment must not set the bar for the rest of the
 * answer.
 */
export const BARGE_IN_FLOOR_WINDOW = 10

/**
 * How many batches are needed before the measurement is trusted.
 *
 * Until then only the absolute minimum applies. Without this, a user who
 * speaks from the very first batch sets the floor to their own voice and
 * raises the bar above themselves.
 */
export const BARGE_IN_FLOOR_MIN_SAMPLES = 3

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
  floorFactor?: number
  floorWindow?: number
}

export class BargeInGate {
  private speaking = false
  private held: Uint8Array[] = []
  private heldMs = 0
  private loudMs = 0
  /** Loudness of the most recent batches, for measuring the room. */
  private levels: number[] = []

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
  private get floorFactor(): number {
    return this.options.floorFactor ?? BARGE_IN_FLOOR_FACTOR
  }
  private get floorWindow(): number {
    return this.options.floorWindow ?? BARGE_IN_FLOOR_WINDOW
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
    this.levels = []
  }

  /**
   * What a batch has to beat right now: several times the quietest of the last
   * second, and never less than the absolute minimum.
   */
  get threshold(): number {
    if (this.levels.length < BARGE_IN_FLOOR_MIN_SAMPLES) return this.levelThreshold
    return Math.max(this.levelThreshold, Math.min(...this.levels) * this.floorFactor)
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

    const level = rmsOfPcm16(chunk)
    // The threshold is read before this batch joins the window, so a batch
    // cannot raise the bar it has to clear.
    const threshold = this.threshold
    this.levels.push(level)
    if (this.levels.length > this.floorWindow) this.levels.shift()

    this.loudMs = level >= threshold ? this.loudMs + ms : 0
    if (this.loudMs < this.holdMs) return []

    // The user is talking. Stop the answer and hand over what was held, so the
    // reply is recognised from its first word.
    const release = this.held
    this.speaking = false
    this.levels = []
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
