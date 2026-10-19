import { describe, it, expect } from 'vitest'
import { TaskStatus } from '../../shared/constants'
import { classifyIdleEnd, statusForEndReason, isNeedsAttentionReason, describeEndReason } from './run-finalization'

describe('classifyIdleEnd', () => {
  it('is completed when the last part is a final assistant text message', () => {
    expect(classifyIdleEnd({ lastPartRole: 'assistant', lastPartType: 'text' })).toBe('completed')
  })

  it('is stopped_early when the last part is a tool call', () => {
    expect(classifyIdleEnd({ lastPartRole: 'assistant', lastPartType: 'tool_call' })).toBe('stopped_early')
  })

  it('is stopped_early when nothing arrived this turn (no final assistant message at all)', () => {
    expect(classifyIdleEnd({})).toBe('stopped_early')
    expect(classifyIdleEnd({ lastPartRole: null, lastPartType: null })).toBe('stopped_early')
  })

  it('is stopped_early when the last part is from the user, not the assistant', () => {
    expect(classifyIdleEnd({ lastPartRole: 'user', lastPartType: 'text' })).toBe('stopped_early')
  })
})

describe('statusForEndReason', () => {
  it('reaches ready_for_review only on a genuine completion', () => {
    expect(statusForEndReason('completed')).toBe(TaskStatus.ReadyForReview)
  })

  it.each(['stopped_early', 'error', 'interrupted', 'limit', 'user_stop'] as const)(
    'maps %s to the needs-attention (model_error) status',
    (reason) => {
      expect(statusForEndReason(reason)).toBe(TaskStatus.ModelError)
    }
  )
})

describe('isNeedsAttentionReason', () => {
  it('is false only for completed', () => {
    expect(isNeedsAttentionReason('completed')).toBe(false)
  })

  it.each(['stopped_early', 'error', 'interrupted', 'limit', 'user_stop'] as const)(
    'is true for %s',
    (reason) => {
      expect(isNeedsAttentionReason(reason)).toBe(true)
    }
  )
})

describe('describeEndReason', () => {
  it('returns a distinct, non-empty label for every reason', () => {
    const reasons = ['completed', 'stopped_early', 'error', 'interrupted', 'limit', 'user_stop'] as const
    const labels = reasons.map(describeEndReason)
    expect(new Set(labels).size).toBe(reasons.length)
    for (const label of labels) expect(label.length).toBeGreaterThan(0)
  })
})
