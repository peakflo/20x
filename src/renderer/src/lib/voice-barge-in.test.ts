import { describe, it, expect, vi } from 'vitest'
import { BARGE_IN_HOLD_MS, BargeInGate, rmsOfPcm16 } from './voice-barge-in'
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

  it('interrupts only once per answer', () => {
    const onBargeIn = vi.fn()
    const gate = new BargeInGate({ onBargeIn, holdMs: 200 })
    gate.setSpeaking(true)

    for (let i = 0; i < 10; i++) gate.push(SPEECH)

    expect(onBargeIn).toHaveBeenCalledTimes(1)
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
