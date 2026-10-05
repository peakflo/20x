import { describe, it, expect } from 'vitest'
import {
  claudeModelBase,
  resolveClaudeContextWindow,
  acpUsageUpdateContextUsage,
  claudeAssistantContextTokens,
  claudeCompactBoundaryTokens,
  claudeContextWindowsFromModelUsage,
  claudeFallbackContextWindow,
  codexContextUsageFromTokenUsage
} from './context-usage-normalize'

describe('claudeAssistantContextTokens', () => {
  it('sums fresh input, cache reads and writes, and output', () => {
    expect(claudeAssistantContextTokens({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        model: 'claude-opus-4-7',
        usage: { input_tokens: 3, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200, output_tokens: 40 }
      }
    })).toBe(1_243)
  })

  it('treats missing fields as zero and returns null without usage', () => {
    expect(claudeAssistantContextTokens({ message: { usage: { output_tokens: 7 } } })).toBe(7)
    expect(claudeAssistantContextTokens({ message: {} })).toBeNull()
    expect(claudeAssistantContextTokens({ message: { usage: {} } })).toBeNull()
  })
})

describe('claude context windows', () => {
  it('reads contextWindow per model from result.modelUsage', () => {
    expect(claudeContextWindowsFromModelUsage({
      'claude-opus-4-7[1m]': { contextWindow: 1_000_000 },
      'claude-haiku-4-5': { contextWindow: 200_000 },
      'no-window': { inputTokens: 1 }
    })).toEqual({ 'claude-opus-4-7[1m]': 1_000_000, 'claude-haiku-4-5': 200_000 })
    expect(claudeContextWindowsFromModelUsage(undefined)).toEqual({})
  })

  it('falls back to 1M for [1m] models and 200k otherwise', () => {
    expect(claudeFallbackContextWindow('claude-opus-4-7[1m]')).toBe(1_000_000)
    expect(claudeFallbackContextWindow('claude-sonnet-4-6')).toBe(200_000)
    expect(claudeFallbackContextWindow(undefined)).toBe(200_000)
  })
})

describe('claudeCompactBoundaryTokens', () => {
  it('returns compact_metadata.post_tokens when numeric', () => {
    expect(claudeCompactBoundaryTokens({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 180_000, post_tokens: 12_000 }
    })).toBe(12_000)
    expect(claudeCompactBoundaryTokens({ compact_metadata: { trigger: 'auto', pre_tokens: 1 } })).toBeNull()
  })
})

describe('codexContextUsageFromTokenUsage', () => {
  it('uses last.totalTokens and modelContextWindow', () => {
    expect(codexContextUsageFromTokenUsage({
      threadId: 'thread-1',
      tokenUsage: {
        total: { totalTokens: 9_999_999 },
        last: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        modelContextWindow: 272_000
      }
    })).toEqual({ usedTokens: 120, maxTokens: 272_000 })
  })

  it('falls back to input + output when totalTokens is missing', () => {
    expect(codexContextUsageFromTokenUsage({
      tokenUsage: { last: { inputTokens: 100, outputTokens: 20 }, modelContextWindow: null }
    })).toEqual({ usedTokens: 120, maxTokens: null })
  })

  it('returns null without any usable figure', () => {
    expect(codexContextUsageFromTokenUsage({ tokenUsage: {} })).toBeNull()
    expect(codexContextUsageFromTokenUsage(null)).toBeNull()
  })
})

describe('acpUsageUpdateContextUsage', () => {
  it('maps used / size', () => {
    expect(acpUsageUpdateContextUsage({ sessionUpdate: 'usage_update', used: 53_000, size: 200_000 })).toEqual({
      usedTokens: 53_000,
      maxTokens: 200_000
    })
  })

  it('ignores updates without numeric used and a positive size', () => {
    expect(acpUsageUpdateContextUsage({ used: 10 })).toBeNull()
    expect(acpUsageUpdateContextUsage({ used: 10, size: 0 })).toBeNull()
    expect(acpUsageUpdateContextUsage({ used: '10', size: 100 })).toBeNull()
  })
})

describe('claude context window resolution', () => {
  it('strips the [1m] marker and dated suffix to a base id', () => {
    expect(claudeModelBase('claude-opus-4-7[1m]')).toBe('claude-opus-4-7')
    expect(claudeModelBase('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
  })

  it('prefers an exact modelUsage key, then the variant matching the configured marker', () => {
    const windows = { 'claude-opus-4-7': 200_000, 'claude-opus-4-7[1m]': 1_000_000 }
    expect(resolveClaudeContextWindow(windows, 'claude-opus-4-7', 'claude-opus-4-7[1m]')).toBe(200_000)
    expect(resolveClaudeContextWindow({ 'claude-opus-4-7[1m]': 1_000_000 }, 'claude-opus-4-7', 'claude-opus-4-7[1m]')).toBe(1_000_000)
    expect(resolveClaudeContextWindow(windows, 'claude-opus-4-7', 'claude-opus-4-7')).toBe(200_000)
  })

  it('returns null when no reported window shares the base id', () => {
    expect(resolveClaudeContextWindow({ 'claude-haiku-4-5': 200_000 }, 'claude-opus-4-7', null)).toBeNull()
  })
})
