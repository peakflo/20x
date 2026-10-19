import { describe, it, expect } from 'vitest'
import { TaskStatus } from '../../shared/constants'
import { classifyIdleEnd, statusForEndReason, isNeedsAttentionReason, describeEndReason, lastMeaningfulPart } from './run-finalization'

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

  it('is completed when the turn ends on a question — that is waiting for input, not cut short', () => {
    expect(classifyIdleEnd({ lastPartRole: 'assistant', lastPartType: 'question' })).toBe('completed')
  })
})

describe('lastMeaningfulPart', () => {
  it('skips a trailing OpenCode step-finish marker and finds the real final text underneath', () => {
    // Every OpenCode assistant turn ends with a step-finish part after the
    // real answer — naively taking "the last part in the batch" would
    // misclassify every OpenCode completion as stopped_early.
    const batch = [
      { role: 'assistant', partType: 'step-start' },
      { role: 'assistant', partType: 'text', content: 'Done — pushed the fix.' },
      { role: 'assistant', partType: 'step-finish' }
    ]
    expect(lastMeaningfulPart(batch)).toEqual({ role: 'assistant', partType: 'text', content: 'Done — pushed the fix.' })
  })

  it('skips several trailing ephemeral part types at once (patch, snapshot, task_progress)', () => {
    const batch = [
      { role: 'assistant', partType: 'text', content: 'All set.' },
      { role: 'assistant', partType: 'patch' },
      { role: 'assistant', partType: 'snapshot' },
      { role: undefined, partType: 'task_progress' }
    ]
    expect(lastMeaningfulPart(batch)?.partType).toBe('text')
  })

  it('returns undefined when every part in the batch is ephemeral — callers must not overwrite prior tracking with this', () => {
    const batch = [
      { role: 'assistant', partType: 'step-start' },
      { role: 'assistant', partType: 'step-finish' }
    ]
    expect(lastMeaningfulPart(batch)).toBeUndefined()
  })

  it('returns undefined for an empty batch', () => {
    expect(lastMeaningfulPart([])).toBeUndefined()
  })

  it('treats a tool call as meaningful (not ephemeral) — a turn that ends there is genuinely stopped_early', () => {
    const batch = [
      { role: 'assistant', partType: 'text', content: "Let's stage and commit." },
      { role: 'assistant', partType: 'tool_call' }
    ]
    const found = lastMeaningfulPart(batch)
    expect(found?.partType).toBe('tool_call')
    expect(classifyIdleEnd({ lastPartRole: found?.role, lastPartType: found?.partType })).toBe('stopped_early')
  })

  it('a real-shaped OpenCode batch ending in step-finish classifies as completed, not stopped_early', () => {
    // Shape mirrors what opencode-adapter.ts actually pushes into
    // batchMessages: step-start, the final text part, then step-finish.
    const openCodeBatch = [
      { id: 'p1', role: 'assistant', content: '', partType: 'step-start' },
      { id: 'p2', role: 'assistant', content: 'I fixed the flaky test and pushed the commit.', partType: 'text' },
      { id: 'p3', role: 'assistant', content: '', partType: 'step-finish' }
    ]
    const found = lastMeaningfulPart(openCodeBatch)
    expect(classifyIdleEnd({ lastPartRole: found?.role, lastPartType: found?.partType })).toBe('completed')
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
