import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ArtifactClipboardMode, ArtifactContentKind, ArtifactType, type Artifact, type ArtifactApi, type ArtifactUIState } from '@shared/artifacts'
import { PinnedArtifactTabId } from '@/stores/artifact-store'
import { ACTIVE_ARTIFACT_REFRESH_INTERVAL_MS, ArtifactsPanel } from './ArtifactsPanel'

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="stable-diagram" />' }) } }))

const artifactApi: ArtifactApi = {
  scan: vi.fn().mockResolvedValue([]),
  read: vi.fn().mockResolvedValue(null),
  copyFile: vi.fn().mockResolvedValue({ mode: ArtifactClipboardMode.FILE })
}

const baseUi: ArtifactUIState = {
  open: true,
  activeTabId: PinnedArtifactTabId.DETAILS,
  railExpanded: false
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ArtifactsPanel', () => {
  it('keeps the document and diagram mounted through resize and background refresh', async () => {
    let refresh!: () => void
    vi.spyOn(window, 'setInterval').mockImplementation((callback, timeout) => { if (timeout === 30_000) refresh = callback as () => void; return 1 as unknown as ReturnType<typeof window.setInterval> })
    vi.spyOn(window, 'clearInterval').mockImplementation(() => {})
    const read = vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: '```mermaid\ngraph TD\nA --> B\n```\n\nEnd of report' })
    const artifact: Artifact = { id: 'report', taskId: 'task-1', title: 'Report', type: ArtifactType.MARKDOWN, path: 'report.md', updatedAt: 1, reloadTrigger: 0 }
    const props = { taskId: 'task-1', artifacts: [artifact], ui: { ...baseUi, activeTabId: 'report' }, artifactApi: { scan: vi.fn(), read }, hasChanges: false, hasOutput: false, onSelectTab: vi.fn(), onCloseTab: vi.fn(), onToggleOpen: vi.fn(), onToggleRail: vi.fn(), details: null, changes: null, output: null }
    const view = render(<ArtifactsPanel {...props} className="w-96" />)
    const diagram = await view.findByTestId('stable-diagram')
    const paragraph = view.getByText('End of report')
    const scroll = paragraph.closest('.overflow-y-auto')!
    scroll.scrollTop = 320
    view.rerender(<ArtifactsPanel {...props} className="w-80" />)
    expect(view.getByTestId('stable-diagram')).toBe(diagram)
    await act(async () => refresh())
    expect(read).toHaveBeenCalledTimes(2)
    expect(view.getByText('End of report')).toBe(paragraph)
    expect(view.getByTestId('stable-diagram')).toBe(diagram)
    expect(scroll.scrollTop).toBe(320)
  })

  it('opens supporting file links, selects files, and copies the selected file', async () => {
    const files = ['artifacts/demo/docs/start.md', 'artifacts/demo/data.csv', 'artifacts/demo/index.html']
    const artifact: Artifact = { id: 'demo', taskId: 'task-1', title: 'Report', type: ArtifactType.MARKDOWN, path: files[0], files, updatedAt: 1, reloadTrigger: 0 }
    const read = vi.fn().mockImplementation(async (_task, path) => ({ kind: ArtifactContentKind.TEXT, content: path === files[0] ? '[Data](../data.csv) [Missing](missing.md) [Web](https://example.com)' : path === files[1] ? 'name,value\nA,10' : '<a href="docs/start.md">Start</a>' }))
    const copyFile = vi.fn().mockResolvedValue({ mode: ArtifactClipboardMode.FILE })
    render(<ArtifactsPanel taskId="task-1" artifacts={[artifact]} ui={{ ...baseUi, activeTabId: 'demo' }} artifactApi={{ scan: vi.fn(), read, copyFile }} hasChanges={false} hasOutput={false} onSelectTab={vi.fn()} onCloseTab={vi.fn()} onToggleOpen={vi.fn()} onToggleRail={vi.fn()} details={null} changes={null} output={null} />)
    fireEvent.click(await screen.findByRole('link', { name: 'Missing' }))
    expect(screen.getByRole('alert')).toHaveTextContent('This file is not available')
    expect(read).not.toHaveBeenCalledWith('task-1', expect.stringContaining('missing.md'))
    expect(screen.getByRole('link', { name: 'Web' })).toHaveAttribute('href', 'https://example.com')
    fireEvent.click(screen.getByRole('link', { name: 'Data' }))
    await screen.findByText(/name,value/)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Artifact file' })).toHaveValue(files[1])
    fireEvent.click(screen.getByRole('button', { name: 'Copy file' }))
    await waitFor(() => expect(copyFile).toHaveBeenCalledWith('task-1', files[1]))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: files[2] } })
    const frame = await screen.findByTitle('Report') as HTMLIFrameElement
    act(() => window.dispatchEvent(new MessageEvent('message', { origin: 'null', source: frame.contentWindow, data: { type: 'artifact:open-file', href: 'docs/start.md' } })))
    await screen.findByRole('link', { name: 'Data' })
    expect(screen.getByRole('combobox')).toHaveValue(files[0])
  })

  it('mounts Changes only while the Changes tab is selected', () => {
    const props = {
      taskId: 'task-1',
      artifacts: [],
      artifactApi,
      hasChanges: true,
      hasOutput: false,
      onSelectTab: vi.fn(),
      onCloseTab: vi.fn(),
      onToggleOpen: vi.fn(),
      onToggleRail: vi.fn(),
      details: <div>Task details</div>,
      changes: <div>Loaded changes</div>,
      output: null
    }
    const { rerender } = render(<ArtifactsPanel {...props} ui={baseUi} />)

    expect(screen.getByText('Task details')).toBeInTheDocument()
    expect(screen.queryByText('Loaded changes')).not.toBeInTheDocument()

    rerender(<ArtifactsPanel {...props} ui={{ ...baseUi, activeTabId: PinnedArtifactTabId.CHANGES }} />)
    expect(screen.getByText('Loaded changes')).toBeInTheDocument()

    rerender(<ArtifactsPanel {...props} ui={baseUi} />)
    expect(screen.queryByText('Loaded changes')).not.toBeInTheDocument()
  })

  it('refreshes on open and periodically only while the artifact is selected', async () => {
    const dynamicArtifactApi: ArtifactApi = {
      scan: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: '# Current content' })
    }
    const artifact: Artifact = {
      id: 'artifact-1',
      taskId: 'task-1',
      type: ArtifactType.MARKDOWN,
      title: 'Review notes',
      path: 'review.md',
      updatedAt: 1,
      reloadTrigger: 0
    }
    let intervalCallback: (() => void) | undefined
    const intervalSpy = vi.spyOn(window, 'setInterval').mockImplementation((callback, timeout) => {
      if (timeout === ACTIVE_ARTIFACT_REFRESH_INTERVAL_MS) intervalCallback = callback as () => void
      return 1 as unknown as ReturnType<typeof window.setInterval>
    })
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined)
    const props = {
      taskId: 'task-1',
      artifacts: [artifact],
      artifactApi: dynamicArtifactApi,
      hasChanges: true,
      hasOutput: false,
      onSelectTab: vi.fn(),
      onCloseTab: vi.fn(),
      onToggleOpen: vi.fn(),
      onToggleRail: vi.fn(),
      details: <div>Task details</div>,
      changes: <div>Loaded changes</div>,
      output: null
    }
    const { rerender } = render(<ArtifactsPanel {...props} ui={{ ...baseUi, activeTabId: artifact.id }} />)

    await waitFor(() => expect(dynamicArtifactApi.read).toHaveBeenCalledTimes(1))
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), ACTIVE_ARTIFACT_REFRESH_INTERVAL_MS)

    act(() => intervalCallback?.())
    await waitFor(() => expect(dynamicArtifactApi.read).toHaveBeenCalledTimes(2))

    rerender(<ArtifactsPanel {...props} ui={baseUi} />)
    expect(clearIntervalSpy).toHaveBeenCalledWith(1)

    rerender(<ArtifactsPanel {...props} ui={{ ...baseUi, activeTabId: artifact.id }} />)
    await waitFor(() => expect(dynamicArtifactApi.read).toHaveBeenCalledTimes(3))

    rerender(<ArtifactsPanel {...props} artifacts={[{ ...artifact, reloadTrigger: 1 }]} ui={{ ...baseUi, activeTabId: artifact.id }} />)
    await waitFor(() => expect(dynamicArtifactApi.read).toHaveBeenCalledTimes(4))
  })

  it('offers the copy options only while an artifact tab is selected', () => {
    const artifact: Artifact = {
      id: 'artifact-1',
      taskId: 'task-1',
      type: ArtifactType.MARKDOWN,
      title: 'Review notes',
      path: 'review.md',
      updatedAt: 1,
      reloadTrigger: 0
    }
    const props = {
      taskId: 'task-1',
      artifacts: [artifact],
      artifactApi,
      hasChanges: false,
      hasOutput: false,
      onSelectTab: vi.fn(),
      onCloseTab: vi.fn(),
      onToggleOpen: vi.fn(),
      onToggleRail: vi.fn(),
      details: <div>Task details</div>,
      changes: null,
      output: null
    }
    const { rerender } = render(<ArtifactsPanel {...props} ui={baseUi} />)

    expect(screen.queryByRole('button', { name: 'Copy content' })).not.toBeInTheDocument()

    rerender(<ArtifactsPanel {...props} ui={{ ...baseUi, activeTabId: artifact.id }} />)
    expect(screen.getByRole('button', { name: 'Copy content' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy file' })).toBeInTheDocument()
  })
})
