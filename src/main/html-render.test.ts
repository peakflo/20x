import { mkdtemp, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appearanceFromInput,
  captureHtmlPreview,
  HtmlRenderImageError,
  HtmlRenderPageTooLargeError,
  inlineLocalImages,
  sniffImageBytes,
  waitForFreshPaint,
  withTimeout,
  type HtmlPreviewElectron,
  type HtmlPreviewWindow
} from './html-render'
import { HTML_PREVIEW_MAX_CONCURRENT } from '../shared/html-render'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), '20x-html-render-test-'))
}

describe('sniffImageBytes', () => {
  it('recognizes a real PNG by its magic bytes', () => {
    expect(sniffImageBytes(PNG_BYTES)?.mimeType).toBe('image/png')
  })
  it('recognizes a real JPEG by its magic bytes', () => {
    expect(sniffImageBytes(JPEG_BYTES)?.mimeType).toBe('image/jpeg')
  })
  it('recognizes an SVG document by its root element', () => {
    expect(sniffImageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))?.mimeType).toBe('image/svg+xml')
  })
  it('recognizes an SVG with a leading XML prolog', () => {
    expect(sniffImageBytes(Buffer.from('<?xml version="1.0"?><svg></svg>'))?.mimeType).toBe('image/svg+xml')
  })
  it('rejects plain text pretending to be an image', () => {
    expect(sniffImageBytes(Buffer.from('SECRET_API_KEY=abc123\nOTHER=1\n'))).toBeNull()
  })
  it('rejects an empty file', () => {
    expect(sniffImageBytes(Buffer.alloc(0))).toBeNull()
  })
})

describe('inlineLocalImages', () => {
  it('leaves html with no local image references untouched', async () => {
    const result = await inlineLocalImages('<p>no images</p>', { strict: true })
    expect(result).toEqual({ html: '<p>no images</p>', missingImages: [] })
  })

  it('inlines a real local image as a data: URI', async () => {
    const dir = await tempDir()
    const imagePath = join(dir, 'chart.png')
    await writeFile(imagePath, PNG_BYTES)
    const html = `<img src="${imagePath}">`
    const result = await inlineLocalImages(html, { strict: true })
    expect(result.html).toBe(`<img src="data:image/png;base64,${PNG_BYTES.toString('base64')}">`)
    expect(result.missingImages).toEqual([])
  })

  it('inlines a CSS url(...) reference without quotes', async () => {
    const dir = await tempDir()
    const imagePath = join(dir, 'bg.png')
    await writeFile(imagePath, PNG_BYTES)
    const html = `<style>.hero{background:url(${imagePath})}</style>`
    const result = await inlineLocalImages(html, { strict: true })
    expect(result.html).toBe(`<style>.hero{background:url(data:image/png;base64,${PNG_BYTES.toString('base64')})}</style>`)
  })

  it('strict mode throws on a missing local image', async () => {
    await expect(inlineLocalImages('<img src="/no/such/image.png">', { strict: true }))
      .rejects.toBeInstanceOf(HtmlRenderImageError)
  })

  it('lenient mode reports a missing image instead of throwing', async () => {
    const result = await inlineLocalImages('<img src="/no/such/image.png">', { strict: false })
    expect(result.html).toBe('<img src="/no/such/image.png">')
    expect(result.missingImages).toEqual(['/no/such/image.png'])
  })

  it('rejects a file whose bytes are not a real image, even via a symlink with an image extension', async () => {
    const dir = await tempDir()
    const secretPath = join(dir, 'secret.env')
    await writeFile(secretPath, 'API_KEY=super-secret\n')
    const linkPath = join(dir, 'innocent.png')
    await symlink(secretPath, linkPath)

    await expect(inlineLocalImages(`<img src="${linkPath}">`, { strict: true }))
      .rejects.toBeInstanceOf(HtmlRenderImageError)

    const lenient = await inlineLocalImages(`<img src="${linkPath}">`, { strict: false })
    expect(lenient.missingImages).toEqual([linkPath])
    expect(lenient.html).not.toContain('base64')
    expect(lenient.html).not.toContain('super-secret')
  })

  it('rejects an image over the per-image byte limit', async () => {
    const dir = await tempDir()
    const imagePath = join(dir, 'huge.png')
    // Not actually 10MB+ of valid PNG — the size check runs (and rejects)
    // before any byte-sniffing, using a stubbed limit-sized file is enough.
    await writeFile(imagePath, Buffer.concat([PNG_BYTES, Buffer.alloc(11 * 1024 * 1024)]))
    await expect(inlineLocalImages(`<img src="${imagePath}">`, { strict: true }))
      .rejects.toBeInstanceOf(HtmlRenderImageError)
  })

  it('throws HtmlRenderPageTooLargeError once inlined images exceed the whole-page budget', async () => {
    const dir = await tempDir()
    // Three ~9MB images comfortably clear the per-image limit individually
    // but blow the 25MB whole-page budget once base64-inflated and summed.
    const bigImage = Buffer.concat([PNG_BYTES, Buffer.alloc(9 * 1024 * 1024)])
    const paths: string[] = []
    for (let i = 0; i < 3; i++) {
      const imagePath = join(dir, `big-${i}.png`)
      await writeFile(imagePath, bigImage)
      paths.push(imagePath)
    }
    const html = paths.map((p) => `<img src="${p}">`).join('')
    await expect(inlineLocalImages(html, { strict: true })).rejects.toBeInstanceOf(HtmlRenderPageTooLargeError)
  })
})

describe('appearanceFromInput', () => {
  it('defaults to dark', () => {
    expect(appearanceFromInput(undefined)).toBe('dark')
    expect(appearanceFromInput('something-else')).toBe('dark')
  })
  it('accepts light explicitly', () => {
    expect(appearanceFromInput('light')).toBe('light')
  })
})

/**
 * Offscreen windows deliver frames through the `'paint'` event, not
 * `capturePage()` (see the comment on `captureWithWindow`). The fake's `on`
 * auto-fires a fresh 'paint' every 5ms once captureWithWindow registers a
 * listener for it, like a real offscreen window repainting continuously —
 * `destroy()` stops it so no interval outlives its test.
 */
function fakeElectron(options: {
  webContentsOverrides?: Partial<HtmlPreviewWindow['webContents']>
  consoleMessage?: [level: number, message: string]
} = {}): { electron: HtmlPreviewElectron; window: HtmlPreviewWindow } {
  let paintInterval: ReturnType<typeof setInterval> | null = null
  const webContents: HtmlPreviewWindow['webContents'] = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'paint') {
        paintInterval = setInterval(() => listener(null, null, { toPNG: () => Buffer.from('fake-png') }), 5)
      }
      if (event === 'console-message' && options.consoleMessage) {
        const [level, message] = options.consoleMessage
        queueMicrotask(() => listener(null, level, message))
      }
    }) as HtmlPreviewWindow['webContents']['on'],
    setWindowOpenHandler: vi.fn(),
    loadFile: vi.fn(async () => undefined),
    executeJavaScript: vi.fn(async (script: string) => (script.includes('scrollHeight') ? 480 : true)),
    ...options.webContentsOverrides
  }
  const window: HtmlPreviewWindow = {
    webContents,
    setContentSize: vi.fn(),
    destroy: vi.fn(() => { if (paintInterval) clearInterval(paintInterval) })
  }
  const electron: HtmlPreviewElectron = {
    BrowserWindow: vi.fn(function BrowserWindow() { return window }) as unknown as HtmlPreviewElectron['BrowserWindow']
  }
  return { electron, window }
}

describe('captureHtmlPreview', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns a PNG, the measured content height, and captured console errors', async () => {
    const { electron, window } = fakeElectron({ consoleMessage: [3, 'boom'] })
    const result = await captureHtmlPreview(electron, '<p>hi</p>', 728)
    expect(result.png.toString()).toBe('fake-png')
    expect(result.contentHeight).toBe(480)
    expect(result.consoleErrors).toEqual(['boom'])
    expect(window.destroy).toHaveBeenCalled()
  })

  it('captures canvas/GPU-composited content via paint, not capturePage (which is unreliable for offscreen windows)', async () => {
    // A window whose webContents has no capturePage at all — if the
    // implementation ever called it again, this would throw immediately.
    const { electron } = fakeElectron({ webContentsOverrides: { loadFile: vi.fn(async () => undefined) } })
    const result = await captureHtmlPreview(electron, '<canvas></canvas>', 728)
    expect(result.png.toString()).toBe('fake-png')
  })

  it('blocks navigation and popups', async () => {
    const { electron, window } = fakeElectron()
    await captureHtmlPreview(electron, '<p>hi</p>', 728)
    expect(window.webContents.setWindowOpenHandler).toHaveBeenCalled()
    const openHandler = (window.webContents.setWindowOpenHandler as ReturnType<typeof vi.fn>).mock.calls[0][0] as () => { action: string }
    expect(openHandler()).toEqual({ action: 'deny' })
    expect(window.webContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function))
  })

  it('destroys the window even when capture throws', async () => {
    const { electron, window } = fakeElectron({
      webContentsOverrides: {
        loadFile: vi.fn(async () => { throw new Error('load failed') })
      }
    })
    await expect(captureHtmlPreview(electron, '<p>hi</p>', 728)).rejects.toThrow('load failed')
    expect(window.destroy).toHaveBeenCalled()
  })


  it('times out slow pages instead of hanging (exercising captureHtmlPreview\'s real 20s budget would be impractical in a unit test, so this covers the shared withTimeout it is built on)', async () => {
    await expect(withTimeout(20, () => new Promise(() => { /* never resolves */ }))).rejects.toThrow(/timed out/)
  })

  it('allows at most HTML_PREVIEW_MAX_CONCURRENT previews at once', async () => {
    let active = 0
    let maxActive = 0
    const windows: HtmlPreviewWindow[] = []
    const electron: HtmlPreviewElectron = {
      BrowserWindow: vi.fn(function BrowserWindow() {
        let paintInterval: ReturnType<typeof setInterval> | null = null
        const win: HtmlPreviewWindow = {
          webContents: {
            on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
              if (event === 'paint') {
                paintInterval = setInterval(() => listener(null, null, { toPNG: () => Buffer.from('p') }), 5)
              }
            }) as HtmlPreviewWindow['webContents']['on'],
            setWindowOpenHandler: vi.fn(),
            loadFile: vi.fn(async () => {
              active++
              maxActive = Math.max(maxActive, active)
              await new Promise((resolve) => setTimeout(resolve, 20))
              active--
            }),
            executeJavaScript: vi.fn(async () => 100)
          },
          setContentSize: vi.fn(),
          destroy: vi.fn(() => { if (paintInterval) clearInterval(paintInterval) })
        }
        windows.push(win)
        return win
      }) as unknown as HtmlPreviewElectron['BrowserWindow']
    }

    await Promise.all(Array.from({ length: HTML_PREVIEW_MAX_CONCURRENT + 2 }, () => captureHtmlPreview(electron, '<p>x</p>', 728)))
    expect(maxActive).toBeLessThanOrEqual(HTML_PREVIEW_MAX_CONCURRENT)
    expect(windows.every((w) => (w.destroy as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true)
  })
})

describe('waitForFreshPaint', () => {
  it('resolves as soon as a frame painted at/after readyAt is available', async () => {
    const image = { toPNG: () => Buffer.from('fresh') }
    const readyAt = Date.now()
    const result = await waitForFreshPaint(() => ({ image, paintedAt: readyAt + 1 }), readyAt, 200)
    expect(result).toBe(image)
  })

  it('falls back to a stale frame rather than failing the whole preview, once at least one frame exists', async () => {
    const stale = { toPNG: () => Buffer.from('stale') }
    // paintedAt is always before readyAt, so this never counts as "fresh" —
    // the timeout should still resolve with it instead of rejecting.
    const result = await waitForFreshPaint(() => ({ image: stale, paintedAt: 0 }), Date.now() + 10_000, 40)
    expect(result).toBe(stale)
  })

  it('rejects clearly when the window never produces a single frame', async () => {
    await expect(waitForFreshPaint(() => ({ image: null, paintedAt: 0 }), Date.now(), 40))
      .rejects.toThrow(/did not produce a frame/)
  })
})
