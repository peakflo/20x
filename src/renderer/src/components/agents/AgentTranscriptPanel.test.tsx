import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentTranscriptPanel } from './AgentTranscriptPanel'
import { SessionStatus } from '@/stores/agent-store'
import { onShortcutFeedback } from '@/lib/keyboard-shortcuts'

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

    fireEvent.change(screen.getByPlaceholderText('Write a message...'), {
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


describe('Mastermind file references', () => {
  const api = {
    getPathForFile: vi.fn<(file: File) => string>(),
    readClipboardFilePaths: vi.fn<() => Promise<string[]>>(),
    saveImage: vi.fn<() => Promise<string>>()
  }
  const onSend = vi.fn()
  const props = { messages: [], status: SessionStatus.IDLE, onStop: vi.fn(), onSend, fileReferences: true }
  const paste = (files: File[] = [], text = '') => fireEvent.paste(screen.getByRole('textbox'), {
    clipboardData: { files, getData: () => text }
  })
  beforeEach(() => {
    vi.resetAllMocks()
    api.getPathForFile.mockReturnValue('')
    api.readClipboardFilePaths.mockResolvedValue([])
    api.saveImage.mockResolvedValue('/tmp/20x-clipboard-image.png')
    window.electronAPI.webUtils = api
  })
  afterEach(cleanup)

  it('inserts original paths at the cursor and sends only ordinary text', async () => {
    api.getPathForFile.mockImplementation(file => `/tmp/${file.name}`)
    render(<AgentTranscriptPanel {...props} />)
    const field = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'Read these please' } })
    field.setSelectionRange(10, 10)
    fireEvent.drop(screen.getByTestId('transcript-composer'), {
      dataTransfer: { files: [new File(['a'], 'product brief.pdf'), new File(['b'], '文.txt')], types: ['Files'] }
    })
    await waitFor(() => expect(field).toHaveValue('Read these\n/tmp/product brief.pdf\n/tmp/文.txt\n please'))
    expect(onSend).not.toHaveBeenCalled()
    expect(api.saveImage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Send message'))
    expect(onSend).toHaveBeenCalledWith('Read these\n/tmp/product brief.pdf\n/tmp/文.txt\n please', undefined)
  })

  it('prefers Finder paths over thumbnails and pasted filenames', async () => {
    api.readClipboardFilePaths.mockResolvedValue(['/tmp/original image.jpg', '/tmp/other.pdf'])
    render(<AgentTranscriptPanel {...props} />)
    paste([new File(['thumbnail'], 'image.png', { type: 'image/png' })], 'original image.jpg')
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('/tmp/original image.jpg\n/tmp/other.pdf'))
    expect(api.saveImage).not.toHaveBeenCalled()
  })

  it('saves a pathless image and blocks sends until its path is inserted', async () => {
    let finish!: (path: string) => void
    api.saveImage.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<AgentTranscriptPanel {...props} />)
    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: 'Review this' } })
    ;(field as HTMLTextAreaElement).setSelectionRange(11, 11)
    paste([new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })])
    await waitFor(() => expect(api.saveImage).toHaveBeenCalledWith(new Uint8Array([1, 2, 3])))
    expect(screen.getByLabelText('Send message')).toBeDisabled()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    await act(async () => finish('/tmp/screenshot.png'))
    expect(field).toHaveValue('Review this\n/tmp/screenshot.png')
    expect(screen.getByLabelText('Send message')).toBeEnabled()
  })

  it('keeps plain text exactly and does not intercept regular task pastes', async () => {
    const view = render(<AgentTranscriptPanel {...props} />)
    expect(fireEvent.drop(screen.getByTestId('transcript-composer'), {
      dataTransfer: { files: [], types: ['text/plain'] }
    })).toBe(true)
    paste([], 'hello\n  world')
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('hello\n  world'))
    expect(api.saveImage).not.toHaveBeenCalled()
    view.rerender(<AgentTranscriptPanel {...props} fileReferences={false} />)
    expect(paste([], 'normal paste')).toBe(true)
    expect(api.readClipboardFilePaths).toHaveBeenCalledTimes(1)
  })

  it('uses native insertion for a focused paste so Chromium retains Undo history', async () => {
    const insert = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: insert, configurable: true })
    try {
      render(<AgentTranscriptPanel {...props} />)
      screen.getByRole('textbox').focus()
      paste([], 'ordinary text')
      await waitFor(() => expect(insert).toHaveBeenCalledWith('insertText', false, 'ordinary text'))
      expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly')
    } finally { Reflect.deleteProperty(document, 'execCommand') }
  })

  it('preserves the draft and explains invalid files and failed conversion', async () => {
    const feedback = vi.fn()
    const unsubscribe = onShortcutFeedback(feedback)
    try {
      render(<AgentTranscriptPanel {...props} />)
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } })
      paste([new File(['data'], 'remote.pdf', { type: 'application/pdf' })])
      await waitFor(() => expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('no local path'), isError: true })))
      api.saveImage.mockRejectedValue(new Error('Disk full'))
      paste([new File(['data'], 'image.png', { type: 'image/png' })])
      await waitFor(() => expect(feedback).toHaveBeenCalledWith({ message: 'Could not add files — Disk full', isError: true }))
      expect(screen.getByRole('textbox')).toHaveValue('Keep this draft')
      expect(screen.getByLabelText('Send message')).toBeEnabled()
    } finally { unsubscribe() }
  })

  it('does not insert a pending image into a newly selected project', async () => {
    let finish!: (path: string) => void
    api.saveImage.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = render(<AgentTranscriptPanel key="first" {...props} />)
    paste([new File(['image'], 'image.png', { type: 'image/png' })])
    await waitFor(() => expect(api.saveImage).toHaveBeenCalled())
    view.rerender(<AgentTranscriptPanel key="second" {...props} />)
    await act(async () => finish('/tmp/old-project.png'))
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByLabelText('Send message')).toBeEnabled()
  })
})

describe('AgentTranscriptPanel error display', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('preserves a rejected reply and explains the actual failure without the IPC wrapper', async () => {
    const reason = 'Take over this responsibility before sending direct input to its worker.'
    const feedback = vi.fn()
    const unsubscribe = onShortcutFeedback(feedback)
    try {
      render(<AgentTranscriptPanel messages={[]} status={SessionStatus.IDLE} onStop={() => undefined}
        onSend={async () => { throw new Error(`Error invoking remote method 'agentSession:send': Error: ${reason}`) }} />)
      const composer = screen.getByPlaceholderText('Write a message...')
      fireEvent.change(composer, { target: { value: 'Continue with these findings' } })
      fireEvent.click(screen.getByLabelText('Send message'))
      await waitFor(() => expect(feedback).toHaveBeenCalledWith({ message: `Could not send the message — ${reason}`, isError: true }))
      expect(composer).toHaveValue('Continue with these findings')
    } finally { unsubscribe() }
  })

  it('preserves a failed synchronous send alongside a newer draft', async () => {
    render(<AgentTranscriptPanel messages={[]} status={SessionStatus.IDLE} onStop={() => undefined}
      onSend={() => { throw new Error('Could not start') }} />)
    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: '/tmp/spec.md' } })
    fireEvent.click(screen.getByLabelText('Send message'))
    fireEvent.change(field, { target: { value: 'another thought' } })
    await waitFor(() => expect(field).toHaveValue('/tmp/spec.md\n\nanother thought'))
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

  it('always renders transcript content as markdown without a raw content control', () => {
    render(
      <AgentTranscriptPanel
        messages={[
          {
            id: 'agent-markdown',
            role: 'assistant',
            content: '**Rendered markdown**',
            timestamp: new Date(),
            partType: 'text'
          }
        ]}
        status={SessionStatus.IDLE}
        onStop={() => undefined}
      />
    )

    expect(screen.getByText('Rendered markdown').tagName).toBe('STRONG')
    expect(screen.queryByTitle('Show raw content')).toBeNull()
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

  it('highlights the matched word instead of the whole message', () => {
    render(
      <AgentTranscriptPanel
        messages={[
          {
            id: 'agent-1',
            role: 'assistant',
            content: 'Search should highlight only this needle word',
            timestamp: new Date(),
            partType: 'text'
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

    const highlightedMatch = screen.getByText('needle')
    expect(highlightedMatch.tagName).toBe('MARK')
    expect(highlightedMatch.closest('.ring-1')).toBeNull()
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

it('prefills a Factory request without sending and preserves existing composer text', () => {
  cleanup()
  const onSend = vi.fn()
  const applied = vi.fn()
  const props = { messages: [], status: SessionStatus.IDLE, onStop: vi.fn(), onSend, onDraftApplied: applied }
  const view = render(<AgentTranscriptPanel {...props} />)
  const field = screen.getByPlaceholderText('Write a message...')
  fireEvent.change(field, { target: { value: 'My existing note' } })
  view.rerender(<AgentTranscriptPanel {...props} draft={{ id: 'draft', text: 'Use PR Review for these PRs' }} />)
  expect(field).toHaveValue('My existing note\n\nUse PR Review for these PRs')
  expect(applied).toHaveBeenCalledWith('draft')
  expect(onSend).not.toHaveBeenCalled()
  view.rerender(<AgentTranscriptPanel {...props} draft={{ id: 'draft', text: 'Use PR Review for these PRs' }} />)
  expect(field).toHaveValue('My existing note\n\nUse PR Review for these PRs')
  cleanup()
})
