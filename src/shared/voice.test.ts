import { describe, it, expect } from 'vitest'
import {
  canTransition,
  MOBILE_VOICE_CAPABILITIES,
  VOICE_FRAME_SAMPLES,
  VOICE_SAMPLE_RATE,
  VOICE_TRANSITIONS,
  type VoiceState,
} from './voice'

const ALL_STATES = Object.keys(VOICE_TRANSITIONS) as VoiceState[]

describe('voice state machine', () => {
  it('follows the documented path of one spoken command', () => {
    const path: VoiceState[] = [
      'idle',
      'listening',
      'transcribing',
      'awaiting_confirmation',
      'executing',
      'idle',
    ]
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true)
    }
  })

  it('lets any state fall back to idle, error, or disabled', () => {
    for (const state of ALL_STATES) {
      expect(canTransition(state, 'idle')).toBe(true)
      expect(canTransition(state, 'error')).toBe(true)
      expect(canTransition(state, 'disabled')).toBe(true)
    }
  })

  it('blocks a jump that skips the spoken turn', () => {
    expect(canTransition('idle', 'transcribing')).toBe(false)
    expect(canTransition('idle', 'executing')).toBe(false)
    expect(canTransition('listening', 'executing')).toBe(false)
    expect(canTransition('listening', 'awaiting_confirmation')).toBe(false)
  })

  it('treats a repeated state as legal', () => {
    for (const state of ALL_STATES) expect(canTransition(state, state)).toBe(true)
  })
})

describe('voice audio format', () => {
  it('uses 16 kHz mono with 20 ms frames', () => {
    expect(VOICE_SAMPLE_RATE).toBe(16000)
    expect(VOICE_FRAME_SAMPLES / VOICE_SAMPLE_RATE).toBeCloseTo(0.02)
  })
})

describe('mobile capabilities', () => {
  it('reports voice as a desktop feature with a reason', () => {
    expect(MOBILE_VOICE_CAPABILITIES.available).toBe(false)
    expect(MOBILE_VOICE_CAPABILITIES.reason).toMatch(/desktop/i)
    expect(MOBILE_VOICE_CAPABILITIES.tts).toBe(false)
    expect(MOBILE_VOICE_CAPABILITIES.wakeWord).toBe(false)
  })
})
