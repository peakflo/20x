import { describe, expect, it, vi } from 'vitest'
import { ArtifactContentKind, type ArtifactContent } from '@shared/artifacts'
import { prepareArtifactHtml, readArtifactResource } from './artifact-resources'

const files = ['artifacts/demo/index.html', 'artifacts/demo/media/clip.mp4', 'artifacts/demo/media/cover.png', 'artifacts/demo/styles/site.css']
const contents: Record<string, ArtifactContent> = {
  [files[1]]: { kind: ArtifactContentKind.DATA_URL, content: 'data:video/mp4;base64,AAAA', mimeType: 'video/mp4' },
  [files[2]]: { kind: ArtifactContentKind.DATA_URL, content: 'data:image/png;base64,AQID', mimeType: 'image/png' },
  [files[3]]: { kind: ArtifactContentKind.TEXT, content: 'video { background: url(../media/cover.png) }', mimeType: 'text/css' }
}

describe('artifact resources', () => {
  it('loads relative HTML media and CSS only from files in the artifact', async () => {
    const read = vi.fn(async (path: string) => contents[path] || null)
    const html = await prepareArtifactHtml('<link rel="stylesheet" href="styles/site.css"><video controls poster="media/cover.png"><source src="media/clip.mp4"></video><img src="../private.png"><a href="media/clip.mp4">Open</a>', files[0], files, read)
    const template = document.createElement('template')
    template.innerHTML = html
    expect(template.content.querySelector('source')?.getAttribute('src')).toBe('data:video/mp4;base64,AAAA')
    expect(template.content.querySelector('video')?.getAttribute('poster')).toBe('data:image/png;base64,AQID')
    expect(decodeURIComponent(template.content.querySelector('link')!.getAttribute('href')!)).toContain('data:image/png;base64,AQID')
    expect(template.content.querySelector('img')?.getAttribute('src')).toBe('../private.png')
    expect(template.content.querySelector('a')?.getAttribute('href')).toBe('media/clip.mp4')
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('blocks file reads outside the artifact inventory', async () => {
    const read = vi.fn(async (path: string) => contents[path] || null)
    expect(await readArtifactResource(files[0], '../private.png', files, read)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps document and body attributes in an HTML preview', async () => {
    const html = await prepareArtifactHtml('<!doctype html><html lang="en"><head><title>Demo</title></head><body class="report"><main>Ready</main></body></html>', files[0], files, async () => null)
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<body class="report">')
    expect(html).toContain('<main>Ready</main>')
  })
})
