import { describe, expect, it } from 'vitest'
import { getSourceCompletionDescription, getTaskCompletionAction } from './task-completion'

const task = { source_id: 'feedback', source: 'Session Feedback', output_fields: [] }

describe('source completion description', () => {
  it('uses the source system instead of the connection name', () => {
    expect(getSourceCompletionDescription({...task, source: 'Notion'}, 'dmitry ai tasks')).toContain('Action at Notion: complete.')
  })
  it('uses the task source label without a loaded connection', () => {
    expect(getSourceCompletionDescription(task)).toContain('Action at Session Feedback: complete.')
  })
  it('uses the connection name when the source label is missing', () => {
    expect(getSourceCompletionDescription({...task, source: ' '}, 'Feedback Inbox')).toContain('Action at Feedback Inbox: complete.')
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
