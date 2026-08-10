import { describe, it, expect, vi } from 'vitest'
import { BARGE_IN_HOLD_MS, BARGE_IN_LEVEL, BargeInGate, rmsOfPcm16 } from './voice-barge-in'
import { VOICE_SAMPLE_RATE } from '@shared/voice'

/**
 * Talking over an answer (design §5.7).
 *
 * Two things have to hold at once while 20x is reading: the recogniser must
 * never be given 20x's own voice, and the user must still be able to interrupt
 * by simply speaking.
 */

/** One batch of microphone audio: `ms` of a tone at the given loudness. */
function chunk(ms: number, amplitude: number): Uint8Array {
  const samples = Math.round((VOICE_SAMPLE_RATE * ms) / 1000)
  const bytes = new Uint8Array(samples * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples; i++) {
    // A square wave, so the loudness is exactly the amplitude.
    const value = (i % 2 === 0 ? amplitude : -amplitude) * 32767
    view.setInt16(i * 2, Math.round(value), true)
  }
  return bytes
}

const SILENCE = chunk(100, 0)
/** What the echo canceller leaves behind while the loudspeaker is on. */
const ECHO = chunk(100, 0.01)
/** A person talking into the microphone. */
const SPEECH = chunk(100, 0.2)

describe('while 20x is not talking', () => {
  it('passes the microphone straight through', () => {
    const gate = new BargeInGate({ onBargeIn: vi.fn() })
    expect(gate.push(SPEECH)).toEqual([SPEECH])
    expect(gate.push(SILENCE)).toEqual([SILENCE])
    expect(gate.isHolding).toBe(false)
  })
})

describe('while 20x is talking', () => {
  it('gives the recogniser nothing, so an answer cannot be heard as the user', () => {
    const gate = new BargeInGate({ onBargeIn: vi.fn() })
    gate.setSpeaking(true)

    // The loudspeaker is playing the answer; this is what leaks back in.
    for (let i = 0; i < 40; i++) {
      expect(gate.push(ECHO)).toEqual([])
    }
    expect(gate.isHolding).toBe(true)
  })

  it('does not mistake one short knock for the user', () => {
    const onBargeIn = vi.fn()
    const gate = new BargeInGate({ onBargeIn })

    gate.setSpeaking(true)
    gate.push(SPEECH) // 100 ms — shorter than the hold
    gate.push(ECHO)
    gate.push(ECHO)

    expect(onBargeIn).not.toHaveBeenCalled()
    expect(gate.isHolding).toBe(true)
  })

  it('stops the answer once the user keeps talking', () => {
    const onBargeIn = vi.fn()
    const gate = new BargeInGate({ onBargeIn })
    gate.setSpeaking(true)

    let released: Uint8Array[] = []
    for (let i = 0; i < BARGE_IN_HOLD_MS / 100; i++) {
      released = gate.push(SPEECH)
    }

    expect(onBargeIn).toHaveBeenCalledTimes(1)
    expect(released.length).toBeGreaterThan(0)
    expect(gate.isHolding).toBe(false)
  })

  it('hands over what it held, so the first word is not lost', () => {
    const gate = new BargeInGate({ onBargeIn: vi.fn(), holdMs: 300, preRollMs: 600 })
    gate.setSpeaking(true)

    gate.push(SPEECH)
    gate.push(SPEECH)
    const released = gate.push(SPEECH)

    // All three batches come back, not only the one that tipped the balance.
    expect(released).toHaveLength(3)
  })

  it('keeps the held audio to a pre-roll, not a recording', () => {
    const gate = new BargeInGate({ onBargeIn: vi.fn(), holdMs: 300, preRollMs: 300 })
    gate.setSpeaking(true)

    // A long quiet passage while the answer plays.
    for (let i = 0; i < 50; i++) gate.push(ECHO)
    // Then the user speaks.
    gate.push(SPEECH)
    gate.push(SPEECH)
    const released = gate.push(SPEECH)

    // Only the tail is released, so 5 seconds of echo cannot reach the
    // recogniser at once.
    expect(released.length).toBeLessThanOrEqual(4)
  })

  it('passes audio through again once the answer has finished', () => {
    const gate = new BargeInGate({ onBargeIn: vi.fn() })
    gate.setSpeaking(true)
    expect(gate.push(ECHO)).toEqual([])

    gate.setSpeaking(false)
    expect(gate.push(SPEECH)).toEqual([SPEECH])
  })

  /**
   * The reported failure. The microphone runs with echo cancellation, noise
   * suppression and automatic gain control all on, and all three fight the
   * user's voice at the moment it overlaps the loudspeaker. A quiet talker,
   * or one a metre away, never reached the old fixed level of 0.06 — so the
   * gate held every word and 20x carried on as if nothing had been said.
   */
  it('hears a quiet talker over a loud answer', () => {
    const onBargeIn = vi.fn()
    const gate = new BargeInGate({ onBargeIn, holdMs: 300 })
    gate.setSpeaking(true)

    // The answer is playing; this is the leak the echo canceller leaves.
    for (let i = 0; i < 10; i++) gate.push(ECHO)

    // The user speaks, but quietly — well under the old fixed threshold.
    const QUIET_SPEECH = chunk(100, 0.04)
    for (let i = 0; i < 3; i++) gate.push(QUIET_SPEECH)

    expect(onBargeIn).toHaveBeenCalledTimes(1)
  })

  it('still refuses to hear the loudspeaker leak itself', () => {
    const onBargeIn = vi.fn()
    const gate = new BargeInGate({ onBargeIn, holdMs: 300 })
    gate.setSpeaking(true)

    // A steady leak, for five seconds. It never counts, however long it runs.
    for (let i = 0; i < 50; i++) gate.push(ECHO)

    expect(onBargeIn).not.toHaveBeenCalled()
    expect(gate.isHolding).toBe(true)
  })

  it('measures the room instead of assuming it', () => {
    // A hold no passage can reach, so the bar can be read without the gate
    // firing and resetting what it has measured.
    const gate = new BargeInGate({ onBargeIn: vi.fn(), holdMs: 1_000_000 })
    gate.setSpeaking(true)

    // Nothing measured yet: only the absolute minimum applies.
    expect(gate.threshold).toBeCloseTo(BARGE_IN_LEVEL, 4)

    // A noisy room raises the bar to three times what it measures.
    for (let i = 0; i < 10; i++) gate.push(chunk(100, 0.05))
    expect(gate.threshold).toBeCloseTo(0.15, 2)

    // A quiet one lowers it again, never below the absolute minimum.
    for (let i = 0; i < 10; i++) gate.push(SILENCE)
    expect(gate.threshold).toBeCloseTo(BARGE_IN_LEVEL, 4)
  })

  it('interrupts only once per answer', () => {
    const onBargeIn = vi.fn()
    const gate = new BargeInGate({ onBargeIn, holdMs: 200 })
    gate.setSpeaking(true)

    for (let i = 0; i < 10; i++) gate.push(SPEECH)

    expect(onBargeIn).toHaveBeenCalledTimes(1)
  })

  /**
   * `reset` alone leaves the gate holding, and a gate left holding swallows
   * every word into an open turn. Whoever stops the playback has to say so.
   */
  it('is opened again by being told the answer has stopped, not by reset', () => {
    const gate = new BargeInGate({ onBargeIn: vi.fn(), holdMs: 300 })
    gate.setSpeaking(true)

    gate.reset()
    expect(gate.isHolding).toBe(true)
    expect(gate.push(SILENCE)).toEqual([])

    gate.setSpeaking(false)
    expect(gate.isHolding).toBe(false)
    expect(gate.push(SILENCE)).toEqual([SILENCE])
  })

  it('forgets what it held when the turn ends', () => {
    const gate = new BargeInGate({ onBargeIn: vi.fn(), holdMs: 300 })
    gate.setSpeaking(true)
    gate.push(SPEECH)
    gate.push(SPEECH)

    gate.reset()
    // The two batches above are gone, so this one alone cannot reach the hold.
    const released = gate.push(SPEECH)
    expect(released).toEqual([])
  })
})

describe('rmsOfPcm16', () => {
  it('measures how loud a batch is', () => {
    expect(rmsOfPcm16(SILENCE)).toBe(0)
    expect(rmsOfPcm16(SPEECH)).toBeCloseTo(0.2, 2)
    expect(rmsOfPcm16(ECHO)).toBeCloseTo(0.01, 3)
  })

  it('copes with an empty batch', () => {
    expect(rmsOfPcm16(new Uint8Array(0))).toBe(0)
  })
})
