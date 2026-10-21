import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PASTED_ATTACHMENT_BYTES,
  formatPasteTimestamp,
  materializeClipboardAttachments,
  planClipboardAttachments
} from './clipboard-attachments'

const NOW = new Date(2026, 9, 21, 9, 15, 30)

function clipboard({ files = [], items, text = '', html = '' }: { files?: File[]; items?: File[]; text?: string; html?: string }): DataTransfer {
  const data: Record<string, string> = { 'text/plain': text, 'text/html': html }
  return {
    files,
    items: (items ?? []).map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    getData: (type: string) => data[type] ?? ''
  } as unknown as DataTransfer
}

const noPath = () => ''

describe('planClipboardAttachments', () => {
  it('ignores text-only pastes so the default (multi-line) text paste runs', () => {
    expect(planClipboardAttachments(clipboard({ text: 'line 1\nline 2' }), noPath, NOW)).toBeNull()
    expect(planClipboardAttachments(null, noPath, NOW)).toBeNull()
  })

  it('names a screenshot (path-less PNG) pasted-image-<timestamp>.png', () => {
    const shot = new File(['png'], 'image.png', { type: 'image/png' })
    const plan = planClipboardAttachments(clipboard({ files: [shot] }), noPath, NOW)
    expect(plan).toEqual({ paths: [], blobs: [{ file: shot, filename: 'pasted-image-20261021-091530.png' }] })
  })

  it('uses the jpg extension for JPEG data and reads items when files is empty', () => {
    const jpeg = new File(['jpg'], '', { type: 'image/jpeg' })
    const plan = planClipboardAttachments(clipboard({ items: [jpeg] }), noPath, NOW)
    expect(plan?.blobs[0].filename).toBe('pasted-image-20261021-091530.jpg')
  })

  it('makes names unique when several images are pasted at once', () => {
    const a = new File(['a'], 'image.png', { type: 'image/png' })
    const b = new File(['b'], 'image.png', { type: 'image/png' })
    const plan = planClipboardAttachments(clipboard({ files: [a, b] }), noPath, NOW)
    expect(plan?.blobs.map((blob) => blob.filename)).toEqual([
      'pasted-image-20261021-091530.png',
      'pasted-image-20261021-091530-2.png'
    ])
  })

  it('attaches files copied from the file manager by their real paths', () => {
    const doc = new File(['x'], 'spec.pdf', { type: 'application/pdf' })
    const pic = new File(['y'], 'photo.jpg', { type: 'image/jpeg' })
    const paths: Record<string, string> = { 'spec.pdf': '/Users/me/spec.pdf', 'photo.jpg': 'C:\\Users\\me\\photo.jpg' }
    const plan = planClipboardAttachments(clipboard({ files: [doc, pic], text: 'spec.pdf photo.jpg' }), (f) => paths[f.name], NOW)
    expect(plan).toEqual({ paths: ['/Users/me/spec.pdf', 'C:\\Users\\me\\photo.jpg'], blobs: [] })
  })

  it('drops path-less icon previews that accompany real files', () => {
    const doc = new File(['x'], 'spec.pdf', { type: 'application/pdf' })
    const icon = new File(['i'], 'image.png', { type: 'image/png' })
    const plan = planClipboardAttachments(clipboard({ files: [doc, icon] }), (f) => (f === doc ? '/tmp/spec.pdf' : ''), NOW)
    expect(plan).toEqual({ paths: ['/tmp/spec.pdf'], blobs: [] })
  })

  it('prefers the text paste when rich content carries plain text plus a rendered image', () => {
    const render = new File(['png'], 'image.png', { type: 'image/png' })
    expect(planClipboardAttachments(clipboard({ files: [render], text: 'A1\tB1', html: '<table>' }), noPath, NOW)).toBeNull()
  })

  it('attaches a browser "Copy image" (image + html, no plain text)', () => {
    const img = new File(['png'], 'image.png', { type: 'image/png' })
    const plan = planClipboardAttachments(clipboard({ files: [img], html: '<img src="x">' }), noPath, NOW)
    expect(plan?.blobs).toHaveLength(1)
  })

  it('keeps the name of path-less non-image files', () => {
    const notes = new File(['n'], 'notes.txt', { type: 'text/plain' })
    const plan = planClipboardAttachments(clipboard({ files: [notes], text: 'n' }), noPath, NOW)
    expect(plan?.blobs[0].filename).toBe('notes.txt')
  })

  it('treats a throwing path resolver as "no path"', () => {
    const shot = new File(['png'], 'image.png', { type: 'image/png' })
    const plan = planClipboardAttachments(clipboard({ files: [shot] }), () => { throw new Error('nope') }, NOW)
    expect(plan?.blobs).toHaveLength(1)
  })
})

describe('materializeClipboardAttachments', () => {
  it('stages in-memory files and returns them after the real paths', async () => {
    const shot = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
    const stage = vi.fn(async (filename: string, _data: Uint8Array) => `/tmp/staged/${filename}`)
    const paths = await materializeClipboardAttachments({ paths: ['/a.txt'], blobs: [{ file: shot, filename: 'shot.png' }] }, stage)
    expect(paths).toEqual(['/a.txt', '/tmp/staged/shot.png'])
    expect(stage).toHaveBeenCalledWith('shot.png', expect.any(Uint8Array))
    expect(Array.from(stage.mock.calls[0][1])).toEqual([1, 2, 3])
  })

  it('rejects in-memory files above the size limit without staging anything', async () => {
    const big = { size: MAX_PASTED_ATTACHMENT_BYTES + 1 } as File
    const stage = vi.fn()
    await expect(materializeClipboardAttachments({ paths: [], blobs: [{ file: big, filename: 'big.png' }] }, stage)).rejects.toThrow(/too large/)
    expect(stage).not.toHaveBeenCalled()
  })
})

describe('formatPasteTimestamp', () => {
  it('formats a local, file-name safe timestamp', () => {
    expect(formatPasteTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405')
  })
})
