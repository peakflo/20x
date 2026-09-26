import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ArtifactContentKind, ArtifactType, type Artifact, type ArtifactApi } from '@shared/artifacts'
import { HtmlArtifactView } from './HtmlArtifactView'

const artifact: Artifact = {
  id: 'artifact-1',
  taskId: 'task-1',
  type: ArtifactType.HTML,
  title: 'preview.html',
  path: 'preview.html',
  updatedAt: 1,
  reloadTrigger: 0
}

afterEach(cleanup)

describe('HtmlArtifactView', () => {
  it('renders HTML in a sandbox with a restrictive CSP and blocked window.open', async () => {
    const artifactApi: ArtifactApi = {
      scan: vi.fn(),
      read: vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: '<h1>Preview</h1>' })
    }
    render(<HtmlArtifactView artifact={artifact} artifactApi={artifactApi} />)

    const frame = await screen.findByTitle('preview.html')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    await waitFor(() => {
      expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'")
      expect(frame.getAttribute('srcdoc')).toContain('window.open=function(){return null}')
      expect(frame.getAttribute('srcdoc')).toContain('<h1>Preview</h1>')
    })
  })

  it('accepts messages only from the sandboxed null origin', async () => {
    const onMessage = vi.fn()
    const artifactApi: ArtifactApi = {
      scan: vi.fn(),
      read: vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: '<p>Preview</p>' })
    }
    render(<HtmlArtifactView artifact={artifact} artifactApi={artifactApi} onMessage={onMessage} />)
    const frame = await screen.findByTitle('preview.html') as HTMLIFrameElement

    window.dispatchEvent(new MessageEvent('message', { data: 'blocked', origin: 'https://example.com' }))
    window.dispatchEvent(new MessageEvent('message', { data: 'accepted', origin: 'null', source: frame.contentWindow }))
    window.dispatchEvent(new MessageEvent('message', { data: 'other frame', origin: 'null' }))
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith('accepted')
  })

  it('puts the CSP before any artifact text, so a decoy <head> in an attribute cannot move it', async () => {
    const artifactApi: ArtifactApi = {
      scan: vi.fn(),
      read: vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: '<html data-x="<head>"><body><p>decoy</p></body></html>' })
    }
    render(<HtmlArtifactView artifact={artifact} artifactApi={artifactApi} />)
    await waitFor(() => expect(screen.getByTitle('preview.html').getAttribute('srcdoc')).toContain('<p>decoy</p>'))
    const srcDoc = screen.getByTitle('preview.html').getAttribute('srcdoc') || ''
    expect(srcDoc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(srcDoc.indexOf('data-x=')).toBeGreaterThan(srcDoc.indexOf('Content-Security-Policy'))
  })
})
