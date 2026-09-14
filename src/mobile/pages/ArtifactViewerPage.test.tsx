import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ArtifactContentKind, ArtifactType } from '@shared/artifacts'
import { ArtifactViewerPage } from './ArtifactViewerPage'
import { api } from '../api/client'
import { useArtifactStore } from '../stores/artifact-store'

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="stable-diagram" />' }) } }))

const writeText = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  useArtifactStore.setState({ artifactsByTask: new Map(), loadingTaskIds: new Set() })
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true
  })
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ArtifactViewerPage', () => {
  it('keeps the diagram and scroll container through parent renders and refresh', async () => {
    let refresh!: () => void
    vi.spyOn(window, 'setInterval').mockImplementation((callback, timeout) => { if (timeout === 30_000) refresh = callback as () => void; return 1 as unknown as ReturnType<typeof window.setInterval> })
    vi.spyOn(window, 'clearInterval').mockImplementation(() => {})
    useArtifactStore.setState({ artifactsByTask: new Map([['task-1', [{ id: 'report', taskId: 'task-1', title: 'Report', type: ArtifactType.MARKDOWN, path: 'report.md', updatedAt: 1, reloadTrigger: 0 }]]]) })
    vi.mocked(api.artifacts.content).mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: '```mermaid\ngraph TD\nA --> B\n```\n\nEnd of report' })
    const view = render(<ArtifactViewerPage taskId="task-1" artifactId="report" onNavigate={vi.fn()} />)
    const diagram = await view.findByTestId('stable-diagram')
    const paragraph = view.getByText('End of report')
    const scroll = paragraph.closest('.overflow-auto')!
    scroll.scrollTop = 320
    view.rerender(<ArtifactViewerPage taskId="task-1" artifactId="report" onNavigate={vi.fn()} />)
    expect(view.getByTestId('stable-diagram')).toBe(diagram)
    const reads = vi.mocked(api.artifacts.content).mock.calls.length
    await act(async () => refresh())
    expect(api.artifacts.content).toHaveBeenCalledTimes(reads + 1)
    expect(view.getByTestId('stable-diagram')).toBe(diagram)
    expect(view.getByText('End of report')).toBe(paragraph)
    expect(scroll.scrollTop).toBe(320)
  })

  it('opens nested file links and copies the selected file content', async () => {
    const files = ['artifacts/demo/docs/start.md', 'artifacts/demo/data.csv', 'artifacts/demo/index.html']
    useArtifactStore.setState({ artifactsByTask: new Map([['task-1', [{ id: 'demo', taskId: 'task-1', title: 'Report', type: ArtifactType.MARKDOWN, path: files[0], files, updatedAt: 1, reloadTrigger: 0 }]]]) })
    vi.mocked(api.artifacts.content).mockImplementation(async (_task, path) => ({ kind: ArtifactContentKind.TEXT, content: path === files[0] ? '[Data](../data.csv)' : path === files[1] ? 'name,value' : '<a href="docs/start.md">Start</a>' }))
    const view = render(<ArtifactViewerPage taskId="task-1" artifactId="demo" onNavigate={vi.fn()} />)
    fireEvent.click(await view.findByRole('link', { name: 'Data' }))
    await view.findByText('name,value')
    expect((view.getByRole('combobox') as HTMLSelectElement).value).toBe(files[1])
    fireEvent.click(view.getByRole('button', { name: 'Copy content' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('name,value'))
    fireEvent.change(view.getByRole('combobox'), { target: { value: files[2] } })
    const frame = await view.findByTitle('Report') as HTMLIFrameElement
    act(() => window.dispatchEvent(new MessageEvent('message', { origin: 'null', source: frame.contentWindow, data: { type: 'artifact:open-file', href: 'docs/start.md' } })))
    await view.findByRole('link', { name: 'Data' })
    expect((view.getByRole('combobox') as HTMLSelectElement).value).toBe(files[0])
  })

  it('renders a URL-only image artifact without requesting workspace content', () => {
    useArtifactStore.setState({
      artifactsByTask: new Map([['task-1', [{
        id: 'task-1:image:screenshot',
        taskId: 'task-1',
        type: ArtifactType.IMAGE,
        title: 'Screenshot',
        url: 'https://example.com/screenshot.png',
        updatedAt: 1,
        reloadTrigger: 0
      }]]])
    })

    const { getByRole } = render(
      <ArtifactViewerPage
        taskId="task-1"
        artifactId="task-1:image:screenshot"
        onNavigate={vi.fn()}
      />
    )

    expect(getByRole('img', { name: 'Screenshot' }).getAttribute('src')).toBe(
      'https://example.com/screenshot.png'
    )
  })

  it('copies the content of the artifact on screen', async () => {
    useArtifactStore.setState({
      artifactsByTask: new Map([['task-1', [{
        id: 'task-1:markdown:review',
        taskId: 'task-1',
        type: ArtifactType.MARKDOWN,
        title: 'Review notes',
        path: 'reports/review.md',
        updatedAt: 1,
        reloadTrigger: 0
      }]]])
    })
    vi.mocked(api.artifacts.content).mockResolvedValue({
      kind: ArtifactContentKind.TEXT,
      content: '# Review notes'
    })

    const { getByRole } = render(
      <ArtifactViewerPage taskId="task-1" artifactId="task-1:markdown:review" onNavigate={vi.fn()} />
    )

    await waitFor(() => expect(api.artifacts.content).toHaveBeenCalledWith('task-1', 'reports/review.md'))
    fireEvent.click(getByRole('button', { name: 'Copy content' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Review notes'))
  })

  it('copies the pull request link when the artifact has no file', async () => {
    useArtifactStore.setState({
      artifactsByTask: new Map([['task-1', [{
        id: 'task-1:pr:1',
        taskId: 'task-1',
        type: ArtifactType.PR,
        title: 'Pull request',
        url: 'https://github.com/peakflo/20x/pull/1',
        updatedAt: 1,
        reloadTrigger: 0
      }]]])
    })

    const { getByRole, queryByRole } = render(
      <ArtifactViewerPage taskId="task-1" artifactId="task-1:pr:1" onNavigate={vi.fn()} />
    )

    expect(queryByRole('button', { name: 'Save file' })).toBeNull()
    fireEvent.click(getByRole('button', { name: 'Copy link' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://github.com/peakflo/20x/pull/1'))
  })
})
