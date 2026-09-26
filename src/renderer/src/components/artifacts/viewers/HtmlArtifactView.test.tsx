import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ArtifactContentKind, ArtifactType, type Artifact, type ArtifactApi } from '@shared/artifacts'
import { ARTIFACT_BRIDGE_HANDSHAKE, ARTIFACT_MCP_SHIM } from '@shared/artifact-mcp'
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

    await screen.findByTitle('preview.html')
    // The frame element is replaced when the prepared document arrives.
    await waitFor(() => {
      const frame = screen.getByTitle('preview.html')
      expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
      expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'")
      expect(frame.getAttribute('srcdoc')).toContain("connect-src 'none'")
      expect(frame.getAttribute('srcdoc')).toContain('window.workflo={callTool:')
      expect(frame.getAttribute('srcdoc')).toContain('window.open=function(){return null}')
      expect(frame.getAttribute('srcdoc')).toContain('<h1>Preview</h1>')
    })
  })

  function fakePort(): { onmessage: ((event: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
    return { onmessage: null, postMessage: vi.fn(), close: vi.fn() }
  }

  function post(fields: { data: unknown; origin: string; source: unknown; ports?: unknown[] }): void {
    const event = new Event('message')
    for (const [key, value] of Object.entries({ ports: [], ...fields })) Object.defineProperty(event, key, { value })
    window.dispatchEvent(event)
  }

  const handshake = { type: ARTIFACT_BRIDGE_HANDSHAKE }

  async function renderBridged(onMessage: NonNullable<Parameters<typeof HtmlArtifactView>[0]['onMessage']>, content = '<p>Preview</p>', marker = content): Promise<HTMLIFrameElement> {
    const artifactApi: ArtifactApi = {
      scan: vi.fn(),
      read: vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content })
    }
    render(<HtmlArtifactView artifact={artifact} artifactApi={artifactApi} onMessage={onMessage} />)
    // Wait for the prepared document: the frame element is replaced when it arrives.
    await waitFor(() => expect(screen.getByTitle('preview.html').getAttribute('srcdoc')).toContain(marker))
    return screen.getByTitle('preview.html') as HTMLIFrameElement
  }

  it('accepts the tool handshake only from the sandboxed null origin and this frame', async () => {
    const onMessage = vi.fn()
    const frame = await renderBridged(onMessage)
    const wrongOrigin = fakePort()
    const otherFrame = fakePort()
    const real = fakePort()
    post({ data: handshake, origin: 'https://example.com', source: frame.contentWindow, ports: [wrongOrigin] })
    post({ data: handshake, origin: 'null', source: window, ports: [otherFrame] })
    post({ data: handshake, origin: 'null', source: frame.contentWindow, ports: [real] })
    expect(wrongOrigin.onmessage).toBeNull()
    expect(otherFrame.onmessage).toBeNull()
    real.onmessage?.({ data: 'accepted' } as MessageEvent)
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith('<p>Preview</p>', 'accepted', expect.any(Function))
  })

  it('ignores tool calls on the window and replies only on the port', async () => {
    const onMessage = vi.fn((_html: string, _data: unknown, reply: (message: Record<string, unknown>) => void) => reply({ ok: true }))
    const frame = await renderBridged(onMessage)
    const wildcard = vi.fn()
    Object.defineProperty(frame.contentWindow, 'postMessage', { configurable: true, value: wildcard })
    post({ data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }, origin: 'null', source: frame.contentWindow })
    expect(onMessage).not.toHaveBeenCalled()
    const port = fakePort()
    post({ data: handshake, origin: 'null', source: frame.contentWindow, ports: [port] })
    port.onmessage?.({ data: { id: 1 } } as MessageEvent)
    expect(port.postMessage).toHaveBeenCalledWith({ ok: true })
    expect(wildcard).not.toHaveBeenCalled()
  })

  it('a page the artifact navigates to cannot open a second channel', async () => {
    const frame = await renderBridged(vi.fn())
    const original = fakePort()
    const navigated = fakePort()
    post({ data: handshake, origin: 'null', source: frame.contentWindow, ports: [original] })
    post({ data: handshake, origin: 'null', source: frame.contentWindow, ports: [navigated] })
    expect(original.onmessage).toEqual(expect.any(Function))
    expect(navigated.onmessage).toBeNull()
  })

  it('the shim sends requests on its port and posts to the window only for the handshake', () => {
    expect(ARTIFACT_MCP_SHIM).toContain('new MessageChannel()')
    expect(ARTIFACT_MCP_SHIM.match(/parent\.postMessage/g)).toHaveLength(1)
    expect(ARTIFACT_MCP_SHIM).not.toContain("addEventListener('message'")
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
