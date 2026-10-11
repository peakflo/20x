import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ArtifactContentKind, ArtifactType, type Artifact, type ArtifactApi } from '@shared/artifacts'
import { HTML_RENDER_MIN_HEIGHT } from '@shared/html-render'
import { InlineHtmlRender } from './InlineHtmlRender'

afterEach(cleanup)

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    taskId: 'task-1',
    type: ArtifactType.HTML,
    title: 'Q3 revenue',
    path: 'index.html',
    inline: true,
    heightHint: 320,
    updatedAt: 1,
    reloadTrigger: 0,
    ...overrides
  }
}

function makeApi(content = '<p>chart</p>', overrides: Partial<ArtifactApi> = {}): ArtifactApi {
  return {
    scan: vi.fn(),
    read: vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content }),
    ...overrides
  }
}

describe('InlineHtmlRender', () => {
  it('renders the artifact inline with a toolbar title, no Save action on mobile (omitted), and reserves the hinted height', async () => {
    const artifact = makeArtifact()
    render(<InlineHtmlRender artifact={artifact} artifactApi={makeApi()} onExpand={vi.fn()} />)

    expect(screen.getByText('Q3 revenue')).toBeInTheDocument()
    expect(screen.queryByLabelText('Save as…')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTitle('Q3 revenue').getAttribute('srcdoc')).toContain('<p>chart</p>'))
  })

  it('reserves the box at the height hint before the frame reports its real content height', async () => {
    const artifact = makeArtifact({ id: 'artifact-reserve', heightHint: 555 })
    render(<InlineHtmlRender artifact={artifact} artifactApi={makeApi()} onExpand={vi.fn()} />)
    expect(document.querySelector('[style*="height: 555px"]')).not.toBeNull()
    await waitFor(() => expect(screen.getByTitle('Q3 revenue').getAttribute('srcdoc')).toContain('<p>chart</p>'))
  })

  it('falls back to the minimum height when there is no hint and nothing cached yet', async () => {
    const artifact = makeArtifact({ id: 'artifact-no-hint', heightHint: undefined })
    render(<InlineHtmlRender artifact={artifact} artifactApi={makeApi()} onExpand={vi.fn()} />)
    expect(document.querySelector(`[style*="height: ${HTML_RENDER_MIN_HEIGHT}px"]`)).not.toBeNull()
    await waitFor(() => expect(screen.getByTitle('Q3 revenue').getAttribute('srcdoc')).toContain('<p>chart</p>'))
  })

  it('calls onExpand when the expand button is clicked', async () => {
    const onExpand = vi.fn()
    render(<InlineHtmlRender artifact={makeArtifact()} artifactApi={makeApi()} onExpand={onExpand} />)
    fireEvent.click(screen.getByLabelText('Expand'))
    expect(onExpand).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTitle('Q3 revenue').getAttribute('srcdoc')).toContain('<p>chart</p>'))
  })

  it('toggles a view-source <pre> showing the raw HTML, in place of the frame', async () => {
    const artifact = makeArtifact()
    render(<InlineHtmlRender artifact={artifact} artifactApi={makeApi('<p>raw source</p>')} onExpand={vi.fn()} />)
    await waitFor(() => expect(screen.getByTitle('Q3 revenue').getAttribute('srcdoc')).toContain('<p>raw source</p>'))

    fireEvent.click(screen.getByLabelText('View source'))
    expect(screen.queryByTitle('Q3 revenue')).not.toBeInTheDocument()
    expect(screen.getByText('<p>raw source</p>')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('View source'))
    await waitFor(() => expect(screen.getByTitle('Q3 revenue')).toBeInTheDocument())
  })

  it('shows Save as… only when the caller (desktop) supplies it', async () => {
    const onSaveAs = vi.fn()
    render(<InlineHtmlRender artifact={makeArtifact()} artifactApi={makeApi()} onExpand={vi.fn()} onSaveAs={onSaveAs} />)
    fireEvent.click(screen.getByLabelText('Save as…'))
    expect(onSaveAs).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTitle('Q3 revenue').getAttribute('srcdoc')).toContain('<p>chart</p>'))
  })

  it('caches the measured content height per artifact id across a remount, so virtualization recycling does not jump', async () => {
    const artifact = makeArtifact({ id: 'artifact-cache-test', heightHint: 100 })
    const { unmount } = render(<InlineHtmlRender artifact={artifact} artifactApi={makeApi()} onExpand={vi.fn()} />)
    await waitFor(() => expect(screen.getByTitle('Q3 revenue').getAttribute('srcdoc')).toContain('<p>chart</p>'))

    const frame = screen.getByTitle('Q3 revenue') as HTMLIFrameElement
    const event = new Event('message')
    Object.defineProperty(event, 'origin', { value: 'null' })
    Object.defineProperty(event, 'source', { value: frame.contentWindow })
    Object.defineProperty(event, 'data', { value: { type: '20x-artifact-size', height: 777 } })
    window.dispatchEvent(event)
    await waitFor(() => expect(document.querySelector('[style*="height: 777px"]')).not.toBeNull())

    unmount()

    // Remount the *same* artifact id: should reserve at the cached height
    // (777), not fall back to the stale heightHint (100).
    render(<InlineHtmlRender artifact={artifact} artifactApi={makeApi()} onExpand={vi.fn()} />)
    expect(document.querySelector('[style*="height: 777px"]')).not.toBeNull()
    await waitFor(() => expect(screen.getByTitle('Q3 revenue').getAttribute('srcdoc')).toContain('<p>chart</p>'))
  })
})
