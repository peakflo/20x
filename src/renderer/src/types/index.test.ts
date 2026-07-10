import { describe, it, expect } from 'vitest'
import { CLAUDE_MODELS, ClaudeModel, CODEX_MODELS, CodexModel } from './index'

describe('CLAUDE_MODELS', () => {
  it('includes Claude Fable 5', () => {
    expect(CLAUDE_MODELS).toContainEqual({
      id: ClaudeModel.FABLE_5,
      name: 'claude-fable-5'
    })
  })

  it('includes Claude Opus 4.8', () => {
    expect(CLAUDE_MODELS).toContainEqual({
      id: ClaudeModel.OPUS_4_8,
      name: 'claude-opus-4-8'
    })
  })

  it('includes Claude Opus 4.7', () => {
    expect(CLAUDE_MODELS).toContainEqual({
      id: ClaudeModel.OPUS_4_7,
      name: 'Claude Opus 4.7'
    })
  })
})

describe('CODEX_MODELS', () => {
  it('lists GPT-5.6 Sol first as the recommended model', () => {
    expect(CODEX_MODELS[0]).toEqual({
      id: CodexModel.GPT_5_6_SOL,
      name: 'GPT-5.6 Sol (Recommended)'
    })
  })

  it('lists the supported Codex models in preferred order', () => {
    expect(CODEX_MODELS).toEqual([
      { id: CodexModel.GPT_5_6_SOL, name: 'GPT-5.6 Sol (Recommended)' },
      { id: CodexModel.GPT_5_6_TERRA, name: 'GPT-5.6 Terra' },
      { id: CodexModel.GPT_5_6_LUNA, name: 'GPT-5.6 Luna' },
      { id: CodexModel.GPT_5_5, name: 'GPT-5.5' },
      { id: CodexModel.GPT_5_4, name: 'GPT-5.4' },
      { id: CodexModel.GPT_5_4_MINI, name: 'GPT-5.4 Mini' },
      { id: CodexModel.GPT_5_3_CODEX_SPARK, name: 'GPT-5.3 Codex Spark' }
    ])
  })

  it('does not include unsupported GPT-5.4 Codex model', () => {
    expect(CODEX_MODELS.some((model) => model.name.includes('GPT-5.4 Codex'))).toBe(false)
  })
})
