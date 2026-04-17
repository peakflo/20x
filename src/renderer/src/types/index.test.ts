import { describe, it, expect } from 'vitest'
import { CLAUDE_MODELS, ClaudeModel, CODEX_MODELS, CodexModel } from './index'

describe('CLAUDE_MODELS', () => {
  it('includes Claude Opus 4.7', () => {
    expect(CLAUDE_MODELS).toContainEqual({
      id: ClaudeModel.OPUS_4_7,
      name: 'Claude Opus 4.7'
    })
  })
})

describe('CODEX_MODELS', () => {
  it('lists GPT-5.4 first as the recommended model', () => {
    expect(CODEX_MODELS[0]).toEqual({
      id: CodexModel.GPT_5_4,
      name: 'GPT-5.4 (Recommended)'
    })
  })

  it('still includes the prior GPT-5.3 Codex model', () => {
    expect(CODEX_MODELS).toContainEqual({
      id: CodexModel.GPT_5_3_CODEX,
      name: 'GPT-5.3 Codex'
    })
  })

  it('does not include unsupported GPT-5.4 Codex model', () => {
    expect(CODEX_MODELS.some((model) => model.name.includes('GPT-5.4 Codex'))).toBe(false)
  })
})
