import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
  it('renders without a header, border, or painted frame background', async () => {
    const artifact = makeArtifact()
    render(<InlineHtmlRender artifact={artifact} artifactApi={makeApi()} />)

    const host = screen.getByTestId('inline-html-render')
    expect(host.className).not.toMatch(/\bborder\b|\bbg-/)
    expect(host).not.toHaveTextContent('Q3 revenue')
    expect(host.querySelector('button')).toBeNull()
    const frame = await screen.findByTitle('Q3 revenue')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame).toHaveClass('border-0', 'bg-transparent')
    await waitFor(() => expect(screen.getByTitle('Q3 revenue').getAttribute('srcdoc')).toContain('<p>chart</p>'))
  })

  it('reserves the box at the height hint before the frame reports its real content height', async () => {
    const artifact = makeArtifact({ id: 'artifact-reserve', heightHint: 555 })
    render(<InlineHtmlRender artifact={artifact} artifactApi={makeApi()} />)
    expect(document.querySelector('[style*="height: 555px"]')).not.toBeNull()
    await waitFor(() => expect(screen.getByTitle('Q3 revenue').getAttribute('srcdoc')).toContain('<p>chart</p>'))
  })

  it('falls back to the minimum height when there is no hint and nothing cached yet', async () => {
    const artifact = makeArtifact({ id: 'artifact-no-hint', heightHint: undefined })
    render(<InlineHtmlRender artifact={artifact} artifactApi={makeApi()} />)
    expect(document.querySelector(`[style*="height: ${HTML_RENDER_MIN_HEIGHT}px"]`)).not.toBeNull()
    await waitFor(() => expect(screen.getByTitle('Q3 revenue').getAttribute('srcdoc')).toContain('<p>chart</p>'))
  })

  it('caches the measured content height per artifact id across a remount, so virtualization recycling does not jump', async () => {
    const artifact = makeArtifact({ id: 'artifact-cache-test', heightHint: 100 })
    const { unmount } = render(<InlineHtmlRender artifact={artifact} artifactApi={makeApi()} />)
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
    render(<InlineHtmlRender artifact={artifact} artifactApi={makeApi()} />)
    expect(document.querySelector('[style*="height: 777px"]')).not.toBeNull()
    await waitFor(() => expect(screen.getByTitle('Q3 revenue').getAttribute('srcdoc')).toContain('<p>chart</p>'))
  })
})
