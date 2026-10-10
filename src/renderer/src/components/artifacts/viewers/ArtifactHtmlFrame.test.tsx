import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { HTML_RENDER_ALLOWED_CDNS, HTML_RENDER_DEFAULT_THEME, HTML_RENDER_SIZE_MESSAGE_TYPE, HTML_RENDER_THEME_MESSAGE_TYPE } from '@shared/html-render'
import { ArtifactHtmlFrame, hardenArtifactHtml } from './ArtifactHtmlFrame'

afterEach(cleanup)

async function readFile(): Promise<null> {
  return null
}

describe('hardenArtifactHtml CSP', () => {
  it('allows scripts/styles only from the CDN allowlist and keeps connect-src blocked', () => {
    const srcDoc = hardenArtifactHtml('<p>hi</p>')
    for (const cdn of HTML_RENDER_ALLOWED_CDNS) {
      expect(srcDoc).toContain(cdn)
    }
    expect(srcDoc).toContain("connect-src 'none'")
    expect(srcDoc).toContain("frame-src 'none'")
    expect(srcDoc).toContain("form-action 'none'")
    expect(srcDoc).toContain('img-src data: blob:')
  })

  it('stays neutral (prefers-color-scheme) when no theme is given', () => {
    const srcDoc = hardenArtifactHtml('<p>hi</p>')
    expect(srcDoc).toContain(':root{color-scheme:light dark;}')
  })

  it('bakes in the given theme as the initial #20x-theme style', () => {
    const srcDoc = hardenArtifactHtml('<p>hi</p>', HTML_RENDER_DEFAULT_THEME.dark)
    expect(srcDoc).toContain(`--background:${HTML_RENDER_DEFAULT_THEME.dark.background}`)
    expect(srcDoc).toContain('color-scheme:dark;')
  })

  it('still puts the CSP before any artifact text', () => {
    const srcDoc = hardenArtifactHtml('<html data-x="<head>"><body><p>decoy</p></body></html>')
    expect(srcDoc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(srcDoc.indexOf('data-x=')).toBeGreaterThan(srcDoc.indexOf('Content-Security-Policy'))
  })

  it('includes a resize bootstrap and a theme-update listener', () => {
    const srcDoc = hardenArtifactHtml('<p>hi</p>')
    expect(srcDoc).toContain('ResizeObserver')
    expect(srcDoc).toContain(HTML_RENDER_SIZE_MESSAGE_TYPE)
    expect(srcDoc).toContain(HTML_RENDER_THEME_MESSAGE_TYPE)
  })
})

describe('ArtifactHtmlFrame auto-height (fill=false)', () => {
  it('sizes the iframe from the height prop and has no hard-coded white background', async () => {
    render(
      <ArtifactHtmlFrame
        html="<p>chart</p>"
        title="Chart"
        taskId="task-1"
        path="index.html"
        files={[]}
        readFile={readFile}
        fill={false}
        height={240}
      />
    )
    await waitFor(() => expect(screen.getByTitle('Chart').getAttribute('srcdoc')).toContain('<p>chart</p>'))
    const frame = screen.getByTitle('Chart') as HTMLIFrameElement
    expect(frame.className).not.toContain('bg-white')
    expect(frame.className).not.toContain('h-full')
    expect(frame.style.height).toBe('240px')
  })

  it('reports a clamped content height from the frame size message', async () => {
    const onContentHeight = vi.fn()
    render(
      <ArtifactHtmlFrame
        html="<p>chart</p>"
        title="Chart"
        taskId="task-1"
        path="index.html"
        files={[]}
        readFile={readFile}
        fill={false}
        height={240}
        onContentHeight={onContentHeight}
      />
    )
    // Query fresh after waiting: `srcDoc` becoming available replaces the
    // iframe element (it is keyed by `srcDoc`), so a reference captured
    // before that swap would point at the stale, now-detached node.
    await waitFor(() => expect(screen.getByTitle('Chart').getAttribute('srcdoc')).toContain('<p>chart</p>'))
    const frame = screen.getByTitle('Chart') as HTMLIFrameElement

    act(() => {
      const event = new Event('message')
      Object.defineProperty(event, 'origin', { value: 'null' })
      Object.defineProperty(event, 'source', { value: frame.contentWindow })
      Object.defineProperty(event, 'data', { value: { type: HTML_RENDER_SIZE_MESSAGE_TYPE, height: 5000 } })
      window.dispatchEvent(event)
    })

    expect(onContentHeight).toHaveBeenCalledWith(2000) // clamped to HTML_RENDER_MAX_HEIGHT
  })

  it('fills its container when fill defaults to true', async () => {
    render(<ArtifactHtmlFrame html="<p>x</p>" title="Full" taskId="task-1" path="index.html" files={[]} readFile={readFile} />)
    await waitFor(() => expect(screen.getByTitle('Full').getAttribute('srcdoc')).toContain('<p>x</p>'))
    const frame = screen.getByTitle('Full') as HTMLIFrameElement
    expect(frame.className).toContain('h-full')
    expect(frame.className).toContain('bg-white')
  })
})
