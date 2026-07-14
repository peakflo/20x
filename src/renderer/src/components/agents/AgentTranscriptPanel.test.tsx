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

describe('AgentTranscriptPanel message layout', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders agent text full width without card bubble chrome while keeping user bubbles', () => {
    render(
      <AgentTranscriptPanel
        messages={[
          {
            id: 'agent-1',
            role: 'assistant',
            content: 'Here is the result',
            timestamp: new Date(),
            partType: 'text'
          },
          {
            id: 'user-1',
            role: 'user',
            content: 'Thanks',
            timestamp: new Date(),
            partType: 'text'
          }
        ]}
        status={SessionStatus.IDLE}
        onStop={() => undefined}
      />
    )

    const agentMessage = screen.getByText('Here is the result').closest('.overflow-hidden')
    const userMessage = screen.getByText('Thanks').closest('.overflow-hidden')

    expect(agentMessage).toHaveClass('w-full')
    expect(agentMessage).not.toHaveClass('bg-card')
    expect(agentMessage).not.toHaveClass('rounded-md')
    expect(userMessage).toHaveClass('rounded-md')
    expect(userMessage).toHaveClass('bg-secondary')
  })

  it('renders tool calls as compact expandable rows without a card bubble', () => {
    render(
      <AgentTranscriptPanel
        messages={[
          {
            id: 'tool-1',
            role: 'assistant',
            content: 'Bash',
            timestamp: new Date(),
            partType: 'tool',
            tool: {
              name: 'Bash',
              status: 'success',
              title: 'pnpm test',
              input: 'pnpm test',
              output: 'pass'
            }
          }
        ]}
        status={SessionStatus.IDLE}
        onStop={() => undefined}
      />
    )

    const toolButton = screen.getByRole('button', { name: /Bash pnpm test/i })
    const toolContainer = toolButton.parentElement

    expect(toolContainer).toHaveClass('w-full')
    expect(toolContainer).not.toHaveClass('bg-card')
    expect(toolContainer).not.toHaveClass('rounded-md')
    expect(screen.queryByText('Output:')).toBeNull()

    fireEvent.click(toolButton)

    expect(screen.getByText('Output:')).toBeInTheDocument()
    expect(screen.getByText('pass')).toBeInTheDocument()
  })

  it('searches collapsed tool details without filtering transcript context', () => {
    render(
      <AgentTranscriptPanel
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Visible context',
            timestamp: new Date(),
            partType: 'text'
          },
          {
            id: 'tool-1',
            role: 'assistant',
            content: 'Bash',
            timestamp: new Date(),
            partType: 'tool',
            tool: {
              name: 'Bash',
              status: 'success',
              title: 'pnpm test',
              input: 'pnpm test',
              output: 'hidden needle output'
            }
          }
        ]}
        status={SessionStatus.IDLE}
        onStop={() => undefined}
      />
    )

    fireEvent.click(screen.getByTitle('Search transcript'))
    fireEvent.change(screen.getByPlaceholderText('Search transcript...'), {
      target: { value: 'needle' }
    })

    expect(screen.getByText('1/1')).toBeInTheDocument()
    expect(screen.getByText('Visible context')).toBeInTheDocument()
    expect(screen.queryByText('hidden needle output')).toBeNull()
  })

  it('shows tool descriptions in compact rows and exact commands in expanded details', () => {
    const command = `cd "/Users/dmitryvedenyapin/Library/Application Support/20x/workspaces/vebrwpyobv88637krcachtxa/workflow-builder" && git add packages/ui/app/business-context/graph/page.tsx && git commit -q -F - <<'MSG'
fix(ui): move custom-property editor from Overview into the Properties tab

The "add custom property" controls were on the Overview (main) tab, so users
who went to Properties to add a field saw only the read-only cube params.
MSG
git push 2>&1 | tail -2`

    render(
      <AgentTranscriptPanel
        messages={[
          {
            id: 'tool-description',
            role: 'assistant',
            content: 'Bash',
            timestamp: new Date(),
            partType: 'tool',
            tool: {
              name: 'Bash',
              status: 'success',
              input: JSON.stringify({
                command,
                description: 'Commit and push placement fix'
              }, null, 2),
              output: 'pass'
            }
          }
        ]}
        status={SessionStatus.IDLE}
        onStop={() => undefined}
      />
    )

    const toolButton = screen.getByRole('button', { name: /Bash Commit and push placement fix/i })
    expect(screen.queryByRole('button', { name: /workflow-builder/i })).toBeNull()
    expect(screen.queryByText('Command:')).toBeNull()

    fireEvent.click(toolButton)

    expect(screen.getByText('Command:')).toBeInTheDocument()
    expect(screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === command)).toBeInTheDocument()
  })

  it('shows only filenames for file editing tool subtitles', () => {
    const filePath = '/Users/dmitryvedenyapin/Library/Application Support/20x/workspaces/vebrwpyobv88637krcachtxa/workflow-builder/packages/ui/app/business-context/graph/page.tsx'

    render(
      <AgentTranscriptPanel
        messages={[
          {
            id: 'tool-edit',
            role: 'assistant',
            content: 'Edit',
            timestamp: new Date(),
            partType: 'tool',
            tool: {
              name: 'Edit',
              status: 'success',
              input: JSON.stringify({
                replace_all: false,
                file_path: filePath,
                old_string: '              {/* Properties Tab */}',
                new_string: '              {/* Properties Tab */}'
              }, null, 2),
              output: 'updated'
            }
          }
        ]}
        status={SessionStatus.IDLE}
        onStop={() => undefined}
      />
    )

    expect(screen.getByRole('button', { name: /Edit page\.tsx/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /workflow-builder/i })).toBeNull()
  })

  it('shows only filenames for read tool subtitles', () => {
    const filePath = '/Users/dmitryvedenyapin/Library/Application Support/20x/workspaces/vebrwpyobv88637krcachtxa/workflow-builder/packages/cubejs/lib/custom-dimensions.js'

    render(
      <AgentTranscriptPanel
        messages={[
          {
            id: 'tool-read',
            role: 'assistant',
            content: 'Read',
            timestamp: new Date(),
            partType: 'tool',
            tool: {
              name: 'Read',
              status: 'success',
              input: JSON.stringify({ file_path: filePath }, null, 2),
              output: 'const customDimensions = []'
            }
          }
        ]}
        status={SessionStatus.IDLE}
        onStop={() => undefined}
      />
    )

    expect(screen.getByRole('button', { name: /Read custom-dimensions\.js/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /workflow-builder/i })).toBeNull()
  })
})
