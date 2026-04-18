import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatInput } from './ChatInput'

describe('ChatInput attachments', () => {
  afterEach(() => {
    cleanup()
  })

  it('sends selected attachments with the message', () => {
    const onSend = vi.fn()
    const attachments = [{ id: 'att-1', filename: 'spec.md', size: 512, mime_type: 'text/markdown' }]

    render(<ChatInput onSend={onSend} attachments={attachments} />)

    fireEvent.change(screen.getByPlaceholderText('Send a message...'), { target: { value: 'Please review' } })
    fireEvent.click(screen.getByLabelText('Send message'))

    expect(onSend).toHaveBeenCalledWith('Please review', { attachments })
  })

  it('removes attachment chip when remove is tapped', () => {
    const onRemoveAttachment = vi.fn()
    const attachments = [{ id: 'att-1', filename: 'spec.md', size: 512, mime_type: 'text/markdown' }]

    render(
      <ChatInput
        onSend={vi.fn()}
        attachments={attachments}
        onRemoveAttachment={onRemoveAttachment}
      />
    )

    fireEvent.click(screen.getByLabelText('Remove spec.md'))

    expect(onRemoveAttachment).toHaveBeenCalledWith('att-1')
  })
})
