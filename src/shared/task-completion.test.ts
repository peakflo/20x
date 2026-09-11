import { describe, expect, it } from 'vitest'
import { getSourceCompletionDescription, getTaskCompletionAction } from './task-completion'

const task = { source_id: 'feedback', source: 'Session Feedback', output_fields: [] }

describe('source completion description', () => {
  it('uses the loaded source name before the task label', () => {
    expect(getSourceCompletionDescription(task, 'Feedback Inbox')).toContain('Action at Feedback Inbox: complete.')
  })
  it('falls back to the task source label', () => {
    expect(getSourceCompletionDescription(task)).toContain('Action at Session Feedback: complete.')
  })
  it('uses a readable fallback for an empty source label', () => {
    expect(getSourceCompletionDescription({ ...task, source: '' })).toContain('Action at the task source: complete.')
  })
  it('does not describe a source write for a local task', () => {
    expect(getSourceCompletionDescription({ ...task, source_id: null })).toBeUndefined()
  })
  it('selects the action output and defaults empty actions to complete', () => {
    expect(getTaskCompletionAction([{ id: 'other', value: 'reject' }, { id: 'action', value: 'approve' }])).toBe('approve')
    expect(getTaskCompletionAction([{ id: 'action', value: '' }])).toBe('complete')
  })
})
