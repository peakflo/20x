import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageQueueList } from './MessageQueueList'
import type { MessageQueueSnapshot } from '@shared/message-queue'

describe('MessageQueueList', () => {
  it('edits and reorders saved messages', async () => {
    const snapshot: MessageQueueSnapshot = { paused: false, messages: [
      { id: 'one', task_id: 'task', text: 'First', attachments: [], position: 0, created_at: '' },
      { id: 'two', task_id: 'task', text: 'Second', attachments: [], position: 1, created_at: '' }
    ] }
    const update = vi.fn().mockResolvedValue(snapshot)
    const reorder = vi.fn().mockResolvedValue(snapshot)
    const actions = { update, reorder, delete: vi.fn(), promote: vi.fn(), resume: vi.fn() }
    render(<MessageQueueList taskId="task" snapshot={snapshot} actions={actions} canSteer onChange={vi.fn()} />)
    fireEvent.click(screen.getAllByText('Edit')[0])
    fireEvent.change(screen.getByDisplayValue('First'), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByText('Save'))
    expect(update).toHaveBeenCalledWith('task', 'one', 'Changed', [])
    fireEvent.click(screen.getAllByLabelText('Move down')[0])
    expect(reorder).toHaveBeenCalledWith('task', ['two', 'one'])
  })
})
