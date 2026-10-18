import { describe, expect, it } from 'vitest'
import { supportsUltrafast } from './ultrafast'

describe('supportsUltrafast', () => {
  it('accepts only supported models for each harness', () => {
    expect(supportsUltrafast('claude-code', 'claude-opus-5-5')).toBe(true)
    expect(supportsUltrafast('claude-code', 'claude-opus-5')).toBe(true)
    expect(supportsUltrafast('claude-code', 'claude-opus-4-8')).toBe(true)
    expect(supportsUltrafast('claude-code', 'claude-sonnet-5-5')).toBe(false)
    expect(supportsUltrafast('codex', 'gpt-6-astra')).toBe(true)
    expect(supportsUltrafast('codex', 'gpt-6.1-sol')).toBe(true)
    expect(supportsUltrafast('codex', 'gpt-6-luna')).toBe(false)
    expect(supportsUltrafast('opencode', 'gpt-6-astra')).toBe(false)
  })
})
