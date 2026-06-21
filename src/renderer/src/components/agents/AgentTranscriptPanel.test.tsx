import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentTranscriptPanel } from './AgentTranscriptPanel'
import { SessionStatus } from '@/stores/agent-store'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 120,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      key: index,
      start: index * 120,
      size: 120
    })),
    scrollToIndex: vi.fn(),
    measureElement: vi.fn()
  })
}))

describe('AgentTranscriptPanel drag and drop attachments', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('adds dropped files as pending attachments and sends them with the message', async () => {
    const onSend = vi.fn()
    const onAddAttachmentPaths = vi.fn().mockResolvedValue([
      {
        id: 'att-1',
        filename: 'spec.md',
        size: 512,
        mime_type: 'text/markdown'
      }
    ])

    Object.assign(window, {
      electronAPI: {
        ...window.electronAPI,
        webUtils: {
          ...window.electronAPI?.webUtils,
          getPathForFile: vi.fn(() => '/tmp/spec.md')
        }
      }
    })

    render(
      <AgentTranscriptPanel
        messages={[]}
        status={SessionStatus.IDLE}
        onStop={() => undefined}
        onSend={onSend}
        onAddAttachmentPaths={onAddAttachmentPaths}
      />
    )

    const composer = screen.getByTestId('transcript-composer')
    const file = new File(['spec'], 'spec.md', { type: 'text/markdown' })

    fireEvent.drop(composer, {
      dataTransfer: {
        files: [file],
        types: ['Files']
      }
    })

    await waitFor(() => {
      expect(onAddAttachmentPaths).toHaveBeenCalledWith(['/tmp/spec.md'])
    })
    expect(await screen.findByText('spec.md')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Send a message... (Shift+Enter for new line)'), {
      target: { value: 'Please use this file' }
    })
    fireEvent.click(screen.getByLabelText('Send message'))

    expect(onSend).toHaveBeenCalledWith('Please use this file', {
      attachments: [
        {
          id: 'att-1',
          filename: 'spec.md',
          size: 512,
          mime_type: 'text/markdown'
        }
      ]
    })
  })
})

describe('AgentTranscriptPanel error display', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('does not render a separate banner for an error already shown as the final message', () => {
    render(
      <AgentTranscriptPanel
        messages={[
          {
            id: 'error-1',
            role: 'system',
            content: 'API Error: Server is temporarily limiting requests',
            timestamp: new Date(),
            partType: 'error'
          }
        ]}
        status={SessionStatus.IDLE}
        onStop={() => undefined}
      />
    )

    expect(screen.getAllByText('API Error: Server is temporarily limiting requests')).toHaveLength(1)
  })
})
