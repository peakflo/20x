/**
 * Server-side half of inline HTML renders: inlining local images by absolute
 * path as `data:` URIs (for `html_render`), and capturing a themed, sandboxed
 * screenshot in an offscreen window (for `html_preview`).
 *
 * Both are deliberately separate from `artifacts.ts`, which only knows about
 * artifact storage — this module is the HTML-authoring-specific business
 * logic layered on top of it.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import {
  HTML_PREVIEW_MAX_CAPTURE_HEIGHT,
  HTML_PREVIEW_MAX_CONCURRENT,
  HTML_PREVIEW_MAX_CONSOLE_MESSAGES,
  HTML_PREVIEW_MAX_CONSOLE_TEXT_LENGTH,
  HTML_PREVIEW_TIMEOUT_MS,
  HTML_PREVIEW_VIEWPORT_HEIGHT,
  HTML_RENDER_MAX_IMAGE_BYTES,
  HTML_RENDER_MAX_PAGE_BYTES,
  type HtmlRenderAppearance
} from '../shared/html-render'

// ── Local image inlining ─────────────────────────────────────────────────

/** Absolute POSIX or Windows path ending in a known image extension, either
 * quoted (src="...", url('...')) or inside an unquoted CSS url(...). */
const LOCAL_IMAGE_PATTERN = /(["'(])((?:\/|[A-Za-z]:[\\/])[^"')<>\s]+\.(?:png|jpe?g|gif|webp|bmp|ico|svg))(["')])/gi

interface ImageSignature { mimeType: string }

/** Identify a real image file by its bytes, never by the extension a symlink
 * or a renamed file can claim. A path whose content does not match any known
 * signature is rejected outright — this is what stops a symlink from
 * smuggling an arbitrary file out as an "image". */
export function sniffImageBytes(bytes: Buffer): ImageSignature | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg' }
  }
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF' && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { mimeType: 'image/gif' }
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp' }
  }
  if (bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'BM') {
    return { mimeType: 'image/bmp' }
  }
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return { mimeType: 'image/x-icon' }
  }
  // SVG is text, not a fixed magic number: accept only a document that
  // actually opens with an XML prolog or an <svg> root within the first KB,
  // so a renamed non-SVG text file (e.g. a `.env` copied to `secret.svg`) is
  // still rejected.
  const head = bytes.subarray(0, 1024).toString('utf8')
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) {
    return { mimeType: 'image/svg+xml' }
  }
  return null
}

export class HtmlRenderImageError extends Error {
  constructor(public readonly path: string, message: string) {
    super(message)
    this.name = 'HtmlRenderImageError'
  }
}

export class HtmlRenderPageTooLargeError extends Error {
  constructor() {
    super(`Page exceeds the ${HTML_RENDER_MAX_PAGE_BYTES}-byte limit once local images are inlined`)
    this.name = 'HtmlRenderPageTooLargeError'
  }
}

export interface InlineImagesResult {
  html: string
  /** Local paths that could not be inlined (missing, too large, or not a
   * real image). Non-empty only in lenient mode — strict mode throws. */
  missingImages: string[]
}

/** Inline every local absolute-path image reference in `html` as a `data:`
 * URI, enforcing the 25 MiB whole-page budget as it goes (inflated base64
 * size). In strict mode (`html_render`), the first missing path, oversized
 * image, or file whose bytes do not sniff as a real image throws — a
 * published page must not silently ship a broken image. In lenient mode
 * (`html_preview`, a self-check before publishing), the same problems are
 * left as the original reference and reported back in `missingImages`
 * instead, so the agent can see and fix them before the strict publish. */
export async function inlineLocalImages(html: string, options: { strict: boolean }): Promise<InlineImagesResult> {
  const matches = [...html.matchAll(LOCAL_IMAGE_PATTERN)]
  const uniquePaths = [...new Set(matches.map((match) => match[2]))]
  if (uniquePaths.length === 0) return { html, missingImages: [] }

  const dataUris = new Map<string, string>()
  const missingImages: string[] = []
  let totalInlinedBytes = 0
  for (const path of uniquePaths) {
    const fail = (message: string): void => {
      if (options.strict) throw new HtmlRenderImageError(path, message)
      missingImages.push(path)
    }
    let fileStat
    try {
      fileStat = await stat(path)
    } catch {
      fail(`Local image not found: ${path}`)
      continue
    }
    if (!fileStat.isFile()) { fail(`Local image not found: ${path}`); continue }
    if (fileStat.size > HTML_RENDER_MAX_IMAGE_BYTES) {
      fail(`Local image exceeds the ${HTML_RENDER_MAX_IMAGE_BYTES}-byte limit: ${path}`)
      continue
    }
    const bytes = await readFile(path)
    const signature = sniffImageBytes(bytes)
    if (!signature) { fail(`Not a real image file: ${path}`); continue }
    const base64 = bytes.toString('base64')
    totalInlinedBytes += base64.length
    if (totalInlinedBytes > HTML_RENDER_MAX_PAGE_BYTES) throw new HtmlRenderPageTooLargeError()
    dataUris.set(path, `data:${signature.mimeType};base64,${base64}`)
  }

  const inlined = html.replace(LOCAL_IMAGE_PATTERN, (full, open: string, path: string, close: string) => {
    const dataUri = dataUris.get(path)
    if (!dataUri) return full
    // Keep the matched delimiters as-is: `url(/abs/bg.png)` stays
    // `url(data:...)`, `src="/abs/x.png"` stays `src="data:..."`.
    return `${open}${dataUri}${close}`
  })
  return { html: inlined, missingImages }
}

// ── Offscreen preview capture ────────────────────────────────────────────

export interface HtmlPreviewResult {
  png: Buffer
  contentHeight: number
  consoleErrors: string[]
}

/** Only the slice of the Electron API this module touches. Kept as a small
 * local interface — rather than `typeof import('electron')` — so a test can
 * pass a plain fake object with no real `electron` package involved at all. */
export interface HtmlPreviewImage { toPNG: () => Buffer }

export interface HtmlPreviewWindow {
  webContents: {
    on(event: 'console-message', listener: (event: unknown, level: number, message: string) => void): void
    on(event: 'will-navigate', listener: (event: { preventDefault: () => void }) => void): void
    // Offscreen rendering delivers frames through 'paint', not capturePage()
    // — see the comment on captureWithWindow for why capturePage() is not
    // used here.
    on(event: 'paint', listener: (event: unknown, dirty: unknown, image: HtmlPreviewImage) => void): void
    setWindowOpenHandler: (handler: () => { action: 'deny' | 'allow' }) => void
    loadFile: (path: string) => Promise<void>
    executeJavaScript: (script: string) => Promise<unknown>
  }
  setContentSize: (width: number, height: number) => void
  destroy: () => void
}

export interface HtmlPreviewElectron {
  BrowserWindow: new (options: Record<string, unknown>) => HtmlPreviewWindow
}

type ElectronModule = HtmlPreviewElectron

let activePreviews = 0
const previewQueue: Array<() => void> = []

async function acquirePreviewSlot(): Promise<() => void> {
  if (activePreviews < HTML_PREVIEW_MAX_CONCURRENT) {
    activePreviews++
    return () => releasePreviewSlot()
  }
  await new Promise<void>((resolve) => previewQueue.push(resolve))
  activePreviews++
  return () => releasePreviewSlot()
}

function releasePreviewSlot(): void {
  activePreviews--
  const next = previewQueue.shift()
  if (next) next()
}

const WAIT_FOR_PAINT_SCRIPT = `document.fonts && document.fonts.ready
  ? document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))
  : new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`

const MEASURE_HEIGHT_SCRIPT = `(() => {
  const root = document.documentElement
  return root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height
})()`

/**
 * Render `html` (already hardened/themed by the caller) in an offscreen,
 * sandboxed `BrowserWindow` — no preload, no node integration, navigation and
 * popups blocked — and capture a PNG. At most `HTML_PREVIEW_MAX_CONCURRENT`
 * windows run at once; the rest queue. Times out after `HTML_PREVIEW_TIMEOUT_MS`.
 */
export async function captureHtmlPreview(
  electron: ElectronModule,
  html: string,
  width: number
): Promise<HtmlPreviewResult> {
  const release = await acquirePreviewSlot()
  const tempDir = await mkdtemp(join(tmpdir(), '20x-html-preview-'))
  const win: HtmlPreviewWindow = new electron.BrowserWindow({
    width,
    height: HTML_PREVIEW_VIEWPORT_HEIGHT,
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      javascript: true,
      nodeIntegration: false
    }
  })

  try {
    return await withTimeout(HTML_PREVIEW_TIMEOUT_MS, () => captureWithWindow(win, html, width, tempDir))
  } finally {
    win.destroy()
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    release()
  }
}

/**
 * capturePage() targets a window's normal compositor presentation, which an
 * `offscreen: true` BrowserWindow does not have — observed empirically as
 * either a blank capture (plain CSS/text can still look right by accident,
 * but a <canvas> — e.g. a chart library — never appears) or a hard
 * `UnknownVizError` (a Chromium GPU/Viz-process error) once anything
 * GPU-composited is on the page. Offscreen windows instead deliver frames
 * through the `'paint'` event; that is the only reliable way to capture one.
 */
export function waitForFreshPaint(
  getLatest: () => { image: HtmlPreviewImage | null; paintedAt: number },
  readyAt: number,
  timeoutMs: number
): Promise<HtmlPreviewImage> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = (): void => {
      const { image, paintedAt } = getLatest()
      if (image && paintedAt >= readyAt) { resolve(image); return }
      if (Date.now() >= deadline) {
        // No frame newer than our resize/settle point arrived in time —
        // still better to return a slightly stale frame than to fail the
        // whole preview outright, as long as at least one frame exists.
        if (image) { resolve(image); return }
        reject(new Error('The offscreen window did not produce a frame to capture'))
        return
      }
      setTimeout(poll, 30)
    }
    poll()
  })
}

async function captureWithWindow(win: HtmlPreviewWindow, html: string, width: number, tempDir: string): Promise<HtmlPreviewResult> {
  const tempFile = join(tempDir, `${randomUUID()}.html`)
  await writeFile(tempFile, html, 'utf8')

  const consoleErrors: string[] = []
  let truncatedConsole = false
  const wc = win.webContents

  let latestImage: HtmlPreviewImage | null = null
  let latestPaintedAt = 0
  wc.on('paint', (_event, _dirty, image) => {
    latestImage = image
    latestPaintedAt = Date.now()
  })

  wc.on('console-message', (_event, level, message) => {
    if (level < 2) return // only warnings (2) and errors (3)
    if (consoleErrors.length >= HTML_PREVIEW_MAX_CONSOLE_MESSAGES) { truncatedConsole = true; return }
    consoleErrors.push(message.slice(0, HTML_PREVIEW_MAX_CONSOLE_TEXT_LENGTH))
  })
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (event) => event.preventDefault())

  await wc.loadFile(tempFile)
  await wc.executeJavaScript(WAIT_FOR_PAINT_SCRIPT)
  const measuredHeight = Math.min(
    HTML_PREVIEW_MAX_CAPTURE_HEIGHT,
    Math.max(1, Math.round(await wc.executeJavaScript(MEASURE_HEIGHT_SCRIPT) as number))
  )
  win.setContentSize(width, measuredHeight)
  await wc.executeJavaScript(WAIT_FOR_PAINT_SCRIPT)

  const readyAt = Date.now()
  const image = await waitForFreshPaint(() => ({ image: latestImage, paintedAt: latestPaintedAt }), readyAt, 4000)

  if (truncatedConsole) consoleErrors.push('… more console messages were omitted')
  return { png: image.toPNG(), contentHeight: measuredHeight, consoleErrors }
}

export async function withTimeout<T>(ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`html_preview timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([run(), timeout])
  } finally {
    clearTimeout(timer!)
  }
}

export function appearanceFromInput(value: unknown): HtmlRenderAppearance {
  return value === 'light' ? 'light' : 'dark'
}
