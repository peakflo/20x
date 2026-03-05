import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotionClient, type NotionBlock, type NotionFileObject } from './notion-client'

// ── Helpers ──────────────────────────────────────────────────

function makeBlock(overrides: Partial<NotionBlock> & { type: string }): NotionBlock {
  return {
    id: 'block-1',
    has_children: false,
    ...overrides
  }
}

function makeImageBlock(
  url: string,
  opts: { hosted?: boolean; caption?: string } = {}
): NotionBlock {
  const type = opts.hosted !== false ? 'file' : 'external'
  return makeBlock({
    type: 'image',
    image: {
      type,
      ...(type === 'file' ? { file: { url } } : { external: { url } }),
      caption: opts.caption ? [{ plain_text: opts.caption }] : []
    }
  })
}

function makeFileBlock(
  blockType: 'file' | 'pdf' | 'video' | 'audio',
  url: string,
  opts: { hosted?: boolean; caption?: string; name?: string } = {}
): NotionBlock {
  const type = opts.hosted !== false ? 'file' : 'external'
  return makeBlock({
    type: blockType,
    [blockType]: {
      type,
      ...(type === 'file' ? { file: { url } } : { external: { url } }),
      caption: opts.caption ? [{ plain_text: opts.caption }] : [],
      ...(opts.name ? { name: opts.name } : {})
    }
  })
}

// ── Tests ────────────────────────────────────────────────────

describe('NotionClient', () => {
  let client: NotionClient

  beforeEach(() => {
    client = new NotionClient('test-token')
  })

  // ── blocksToMarkdown ────────────────────────────────────

  describe('blocksToMarkdown', () => {
    it('renders paragraph blocks', () => {
      const blocks = [makeBlock({
        type: 'paragraph',
        paragraph: { rich_text: [{ plain_text: 'Hello world' }] }
      })]
      expect(client.blocksToMarkdown(blocks)).toBe('Hello world')
    })

    it('renders heading blocks', () => {
      const blocks = [
        makeBlock({ type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'H1' }] } }),
        makeBlock({ type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'H2' }] } }),
        makeBlock({ type: 'heading_3', heading_3: { rich_text: [{ plain_text: 'H3' }] } })
      ]
      const md = client.blocksToMarkdown(blocks)
      expect(md).toContain('# H1')
      expect(md).toContain('## H2')
      expect(md).toContain('### H3')
    })

    it('renders list items', () => {
      const blocks = [
        makeBlock({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'bullet' }] } }),
        makeBlock({ type: 'numbered_list_item', numbered_list_item: { rich_text: [{ plain_text: 'number' }] } })
      ]
      const md = client.blocksToMarkdown(blocks)
      expect(md).toContain('- bullet')
      expect(md).toContain('1. number')
    })

    it('renders to_do blocks with checked state', () => {
      const blocks = [
        makeBlock({ type: 'to_do', to_do: { rich_text: [{ plain_text: 'done' }], checked: true } }),
        makeBlock({ type: 'to_do', to_do: { rich_text: [{ plain_text: 'pending' }], checked: false } })
      ]
      const md = client.blocksToMarkdown(blocks)
      expect(md).toContain('- [x] done')
      expect(md).toContain('- [ ] pending')
    })

    it('renders code blocks with language', () => {
      const blocks = [makeBlock({
        type: 'code',
        code: { rich_text: [{ plain_text: 'const x = 1' }], language: 'typescript' }
      })]
      const md = client.blocksToMarkdown(blocks)
      expect(md).toContain('```typescript')
      expect(md).toContain('const x = 1')
      expect(md).toContain('```')
    })

    it('renders quote and callout blocks', () => {
      const blocks = [
        makeBlock({ type: 'quote', quote: { rich_text: [{ plain_text: 'quoted' }] } }),
        makeBlock({ type: 'callout', callout: { rich_text: [{ plain_text: 'callout text' }] } })
      ]
      const md = client.blocksToMarkdown(blocks)
      expect(md).toContain('> quoted')
      expect(md).toContain('> callout text')
    })

    it('renders divider blocks', () => {
      const blocks = [makeBlock({ type: 'divider' })]
      expect(client.blocksToMarkdown(blocks)).toBe('---')
    })

    it('renders toggle blocks as bold text', () => {
      const blocks = [makeBlock({
        type: 'toggle',
        toggle: { rich_text: [{ plain_text: 'Toggle heading' }] }
      })]
      expect(client.blocksToMarkdown(blocks)).toBe('**Toggle heading**')
    })

    it('renders image blocks as markdown images', () => {
      const blocks = [makeImageBlock('https://example.com/img.png', { caption: 'Screenshot' })]
      const md = client.blocksToMarkdown(blocks)
      expect(md).toBe('![Screenshot](https://example.com/img.png)')
    })

    it('renders image blocks with default alt text when no caption', () => {
      const blocks = [makeImageBlock('https://example.com/img.png')]
      const md = client.blocksToMarkdown(blocks)
      expect(md).toBe('![image](https://example.com/img.png)')
    })

    it('renders external image blocks', () => {
      const blocks = [makeImageBlock('https://cdn.example.com/photo.jpg', { hosted: false })]
      const md = client.blocksToMarkdown(blocks)
      expect(md).toContain('![image](https://cdn.example.com/photo.jpg)')
    })

    it('renders file blocks with paperclip emoji', () => {
      const blocks = [makeFileBlock('file', 'https://example.com/doc.pdf', { caption: 'My Doc' })]
      const md = client.blocksToMarkdown(blocks)
      expect(md).toContain('[My Doc](https://example.com/doc.pdf)')
    })

    it('renders pdf blocks', () => {
      const blocks = [makeFileBlock('pdf', 'https://example.com/report.pdf', { name: 'report.pdf' })]
      const md = client.blocksToMarkdown(blocks)
      expect(md).toContain('[report.pdf](https://example.com/report.pdf)')
    })

    it('renders video blocks', () => {
      const blocks = [makeFileBlock('video', 'https://example.com/video.mp4', { caption: 'Demo' })]
      const md = client.blocksToMarkdown(blocks)
      expect(md).toContain('[Demo](https://example.com/video.mp4)')
    })

    it('renders audio blocks', () => {
      const blocks = [makeFileBlock('audio', 'https://example.com/audio.mp3')]
      const md = client.blocksToMarkdown(blocks)
      expect(md).toContain('(https://example.com/audio.mp3)')
    })

    it('renders children content for container blocks', () => {
      const parent = makeBlock({
        type: 'toggle',
        toggle: { rich_text: [{ plain_text: 'Parent' }] },
        _children: [
          makeBlock({ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Child text' }] } })
        ]
      })
      const md = client.blocksToMarkdown([parent])
      expect(md).toContain('**Parent**')
      expect(md).toContain('Child text')
    })
  })

  // ── extractFilesFromBlocks ──────────────────────────────

  describe('extractFilesFromBlocks', () => {
    it('extracts hosted image files', () => {
      const blocks = [makeImageBlock('https://s3.us-west-2.amazonaws.com/img.png', { caption: 'screenshot.png' })]
      const files = client.extractFilesFromBlocks(blocks)
      expect(files).toHaveLength(1)
      expect(files[0]).toEqual({
        url: 'https://s3.us-west-2.amazonaws.com/img.png',
        filename: 'screenshot.png'
      })
    })

    it('extracts external image files', () => {
      const blocks = [makeImageBlock('https://cdn.example.com/photo.jpg', { hosted: false })]
      const files = client.extractFilesFromBlocks(blocks)
      expect(files).toHaveLength(1)
      expect(files[0].url).toBe('https://cdn.example.com/photo.jpg')
    })

    it('extracts file blocks', () => {
      const blocks = [makeFileBlock('file', 'https://example.com/doc.docx', { name: 'report.docx' })]
      const files = client.extractFilesFromBlocks(blocks)
      expect(files).toHaveLength(1)
      expect(files[0]).toEqual({ url: 'https://example.com/doc.docx', filename: 'report.docx' })
    })

    it('extracts pdf blocks', () => {
      const blocks = [makeFileBlock('pdf', 'https://example.com/report.pdf', { caption: 'Q4 Report' })]
      const files = client.extractFilesFromBlocks(blocks)
      expect(files).toHaveLength(1)
      expect(files[0]).toEqual({ url: 'https://example.com/report.pdf', filename: 'Q4 Report' })
    })

    it('extracts video and audio blocks', () => {
      const blocks = [
        makeFileBlock('video', 'https://example.com/demo.mp4', { caption: 'Demo video' }),
        makeFileBlock('audio', 'https://example.com/podcast.mp3', { caption: 'Podcast ep1' })
      ]
      const files = client.extractFilesFromBlocks(blocks)
      expect(files).toHaveLength(2)
      expect(files[0].filename).toBe('Demo video')
      expect(files[1].filename).toBe('Podcast ep1')
    })

    it('derives filename from URL when no caption or name', () => {
      const blocks = [makeImageBlock('https://example.com/uploads/photo.png')]
      const files = client.extractFilesFromBlocks(blocks)
      expect(files).toHaveLength(1)
      expect(files[0].filename).toBe('photo.png')
    })

    it('generates fallback filename when URL has no extension', () => {
      const blocks = [makeBlock({
        id: 'abcdef12-3456',
        type: 'image',
        has_children: false,
        image: {
          type: 'file',
          file: { url: 'https://example.com/blob/abc123' },
          caption: []
        }
      })]
      const files = client.extractFilesFromBlocks(blocks)
      expect(files).toHaveLength(1)
      expect(files[0].filename).toMatch(/^notion-image-/)
    })

    it('deduplicates by URL', () => {
      const url = 'https://example.com/same.png'
      const blocks = [
        makeImageBlock(url, { caption: 'First' }),
        makeImageBlock(url, { caption: 'Duplicate' })
      ]
      const files = client.extractFilesFromBlocks(blocks)
      expect(files).toHaveLength(1)
      expect(files[0].filename).toBe('First')
    })

    it('skips non-file blocks', () => {
      const blocks = [
        makeBlock({ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'text' }] } }),
        makeBlock({ type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'heading' }] } }),
        makeBlock({ type: 'divider' })
      ]
      const files = client.extractFilesFromBlocks(blocks)
      expect(files).toHaveLength(0)
    })

    it('extracts files from nested children', () => {
      const parent = makeBlock({
        type: 'toggle',
        toggle: { rich_text: [{ plain_text: 'Toggle' }] },
        has_children: true,
        _children: [
          makeImageBlock('https://example.com/nested.png', { caption: 'nested-image.png' })
        ]
      })
      const files = client.extractFilesFromBlocks([parent])
      expect(files).toHaveLength(1)
      expect(files[0].filename).toBe('nested-image.png')
    })

    it('returns empty array for empty blocks', () => {
      expect(client.extractFilesFromBlocks([])).toEqual([])
    })

    it('handles blocks with missing data gracefully', () => {
      const blocks = [makeBlock({ type: 'image', image: undefined })]
      const files = client.extractFilesFromBlocks(blocks)
      expect(files).toHaveLength(0)
    })

    it('handles blocks with missing URL gracefully', () => {
      const blocks = [makeBlock({
        type: 'image',
        image: { type: 'file', file: undefined, caption: [] }
      })]
      const files = client.extractFilesFromBlocks(blocks)
      expect(files).toHaveLength(0)
    })
  })

  // ── extractFilesFromProperty ────────────────────────────

  describe('extractFilesFromProperty', () => {
    it('extracts hosted files', () => {
      const files: NotionFileObject[] = [
        { name: 'photo.jpg', type: 'file', file: { url: 'https://s3.amazonaws.com/photo.jpg' } }
      ]
      const result = client.extractFilesFromProperty(files)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        url: 'https://s3.amazonaws.com/photo.jpg',
        filename: 'photo.jpg'
      })
    })

    it('extracts external files', () => {
      const files: NotionFileObject[] = [
        { name: 'logo.svg', type: 'external', external: { url: 'https://cdn.example.com/logo.svg' } }
      ]
      const result = client.extractFilesFromProperty(files)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        url: 'https://cdn.example.com/logo.svg',
        filename: 'logo.svg'
      })
    })

    it('handles multiple files', () => {
      const files: NotionFileObject[] = [
        { name: 'a.png', type: 'file', file: { url: 'https://example.com/a.png' } },
        { name: 'b.pdf', type: 'external', external: { url: 'https://example.com/b.pdf' } },
        { name: 'c.doc', type: 'file', file: { url: 'https://example.com/c.doc' } }
      ]
      const result = client.extractFilesFromProperty(files)
      expect(result).toHaveLength(3)
    })

    it('skips files with missing URLs', () => {
      const files: NotionFileObject[] = [
        { name: 'broken.png', type: 'file' },  // no file.url
        { name: 'ok.png', type: 'file', file: { url: 'https://example.com/ok.png' } }
      ]
      const result = client.extractFilesFromProperty(files)
      expect(result).toHaveLength(1)
      expect(result[0].filename).toBe('ok.png')
    })

    it('returns empty array for empty input', () => {
      expect(client.extractFilesFromProperty([])).toEqual([])
    })

    it('uses fallback filename when name is empty', () => {
      const files: NotionFileObject[] = [
        { name: '', type: 'file', file: { url: 'https://example.com/x.png' } }
      ]
      const result = client.extractFilesFromProperty(files)
      expect(result).toHaveLength(1)
      expect(result[0].filename).toMatch(/^notion-file-/)
    })
  })

  // ── downloadFile ────────────────────────────────────────

  describe('downloadFile', () => {
    it('downloads file and extracts metadata', async () => {
      const mockBuffer = Buffer.from('fake-file-content')
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({
          'content-type': 'image/png',
          'content-disposition': 'attachment; filename="photo.png"'
        }),
        arrayBuffer: () => Promise.resolve(mockBuffer.buffer)
      }))

      const result = await client.downloadFile('https://example.com/uploads/photo.png')
      expect(result.contentType).toBe('image/png')
      expect(result.filename).toBe('photo.png')
      expect(result.buffer).toBeInstanceOf(Buffer)

      vi.unstubAllGlobals()
    })

    it('extracts filename from URL path when no Content-Disposition', async () => {
      const mockBuffer = Buffer.from('data')
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        arrayBuffer: () => Promise.resolve(mockBuffer.buffer)
      }))

      const result = await client.downloadFile('https://example.com/uploads/report.pdf')
      expect(result.filename).toBe('report.pdf')

      vi.unstubAllGlobals()
    })

    it('generates fallback filename when URL has no extension', async () => {
      const mockBuffer = Buffer.from('data')
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        arrayBuffer: () => Promise.resolve(mockBuffer.buffer)
      }))

      const result = await client.downloadFile('https://example.com/blob/abc123')
      expect(result.filename).toMatch(/^notion-file-/)

      vi.unstubAllGlobals()
    })

    it('throws on HTTP error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers()
      }))

      await expect(client.downloadFile('https://example.com/missing.png'))
        .rejects.toThrow('Failed to download file: 404')

      vi.unstubAllGlobals()
    })
  })
})
