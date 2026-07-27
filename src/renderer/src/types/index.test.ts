import { describe, it, expect } from 'vitest'
import { CLAUDE_MODELS, ClaudeModel, CODEX_MODELS, CodexModel } from './index'

describe('CLAUDE_MODELS', () => {
  it('lists the latest Claude models first in preferred order', () => {
    expect(CLAUDE_MODELS.slice(0, 4)).toEqual([
      { id: ClaudeModel.FABLE_5, name: 'Claude Fable 5' },
      { id: ClaudeModel.OPUS_5, name: 'Claude Opus 5' },
      { id: ClaudeModel.SONNET_5, name: 'Claude Sonnet 5' },
      { id: ClaudeModel.OPUS_4_8, name: 'Claude Opus 4.8' }
    ])
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
