import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatInput } from './ChatInput'
import { api } from '../api/client'

describe('ChatInput attachments', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('sends selected attachments with the message', () => {
    const onSend = vi.fn()
    const attachments = [{ id: 'att-1', filename: 'spec.md', size: 512, mime_type: 'text/markdown' }]

    render(<ChatInput onSend={onSend} attachments={attachments} />)

    fireEvent.change(screen.getByPlaceholderText('Write a message...'), { target: { value: 'Please review' } })
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

  it('shows the unavailable voice explanation only when requested', async () => {
    vi.spyOn(api.capabilities, 'get').mockResolvedValue({ voice: { available: false, reason: 'Voice capture is available on desktop.' } } as Awaited<ReturnType<typeof api.capabilities.get>>)
    render(<ChatInput onSend={vi.fn()} />)

    const explanation = 'Voice capture is available on desktop.'
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Why voice input is unavailable' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(explanation))
  })
})
