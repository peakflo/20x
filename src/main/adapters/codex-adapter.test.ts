import { describe, it, expect } from 'vitest'
import { DEFAULT_CODEX_MODEL } from './codex-adapter'

describe('DEFAULT_CODEX_MODEL', () => {
  it('defaults Codex sessions to GPT-5.4 Codex', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.4-codex')
  })
})
