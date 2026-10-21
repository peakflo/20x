/**
 * Paste-to-attach: turn a clipboard paste into attachment file paths.
 *
 * Decision rules (see `planClipboardAttachments`):
 * - Files copied in Finder/Explorer/Files arrive as File objects with a real
 *   on-disk path → always attached (text paste is suppressed, the clipboard
 *   text would only be the file name).
 * - Path-less images (screenshots, "Copy image" in a browser) → attached and
 *   named `pasted-image-<timestamp>.<ext>`, unless the clipboard also carries
 *   non-empty plain text. Rich copies from web pages / Office put a rendered
 *   image next to the text; the user almost certainly meant the text, so the
 *   default text paste wins there.
 * - Path-less non-image files are attached (keeping their name when present).
 * - Text only → not handled; the default paste runs (multi-line text intact).
 */
import { MAX_PASTED_ATTACHMENT_BYTES } from '@shared/clipboard-attachments'

export { MAX_PASTED_ATTACHMENT_BYTES }

export interface StagedClipboardFile {
  file: File
  filename: string
}

export interface ClipboardAttachmentPlan {
  /** Files that already exist on disk (copied from the OS file manager). */
  paths: string[]
  /** In-memory files that must be written to disk before attaching. */
  blobs: StagedClipboardFile[]
}

export type FilePathResolver = (file: File) => string | undefined | null

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/avif': 'avif'
}

/** Chromium names raw clipboard bitmaps generically ("image.png"). */
const GENERIC_IMAGE_NAME = /^image\.[a-z0-9]+$/i

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local timestamp safe for file names on every OS: `20261021-091530`. */
export function formatPasteTimestamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function isImageFile(file: File): boolean {
  return typeof file.type === 'string' && file.type.startsWith('image/')
}

function imageExtension(file: File): string {
  const fromType = IMAGE_EXTENSIONS[file.type.toLowerCase()]
  if (fromType) return fromType
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name || '')?.[1]
  return fromName ? fromName.toLowerCase() : 'png'
}

function collectFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files ?? [])
  if (files.length > 0) return files
  const fromItems: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) fromItems.push(file)
  }
  return fromItems
}

function safePath(resolve: FilePathResolver, file: File): string {
  try {
    return resolve(file) || ''
  } catch {
    return ''
  }
}

function hasPlainText(data: DataTransfer): boolean {
  try {
    return (data.getData('text/plain') || '').trim().length > 0
  } catch {
    return false
  }
}

/**
 * Decide whether a paste should become attachments. Returns null when the
 * default paste should run (text only, or rich text with a rendered image).
 */
export function planClipboardAttachments(
  data: DataTransfer | null | undefined,
  resolvePath: FilePathResolver,
  now: Date = new Date()
): ClipboardAttachmentPlan | null {
  if (!data) return null
  const files = collectFiles(data)
  if (files.length === 0) return null

  const paths: string[] = []
  const pathless: File[] = []
  for (const file of files) {
    const path = safePath(resolvePath, file)
    if (path) {
      if (!paths.includes(path)) paths.push(path)
    } else {
      pathless.push(file)
    }
  }

  // Real files win; path-less images next to them are file-icon previews.
  const candidates = paths.length > 0 ? pathless.filter((f) => !isImageFile(f)) : pathless
  if (paths.length === 0 && candidates.every(isImageFile) && hasPlainText(data)) return null

  const stamp = formatPasteTimestamp(now)
  const used = new Set<string>()
  const blobs: StagedClipboardFile[] = candidates.map((file, index) => {
    let filename: string
    if (isImageFile(file) && (!file.name || GENERIC_IMAGE_NAME.test(file.name))) {
      filename = `pasted-image-${stamp}.${imageExtension(file)}`
    } else {
      filename = file.name || `pasted-file-${stamp}`
    }
    if (used.has(filename)) {
      const dot = filename.lastIndexOf('.')
      filename = dot > 0
        ? `${filename.slice(0, dot)}-${index + 1}${filename.slice(dot)}`
        : `${filename}-${index + 1}`
    }
    used.add(filename)
    return { file, filename }
  })

  if (paths.length === 0 && blobs.length === 0) return null
  return { paths, blobs }
}

export type StageClipboardFile = (filename: string, data: Uint8Array) => Promise<string>

/** Write in-memory clipboard files to disk and return every attachable path. */
export async function materializeClipboardAttachments(
  plan: ClipboardAttachmentPlan,
  stage: StageClipboardFile
): Promise<string[]> {
  const tooLarge = plan.blobs.find((b) => b.file.size > MAX_PASTED_ATTACHMENT_BYTES)
  if (tooLarge) {
    throw new Error(`${tooLarge.filename} is too large to paste (max ${Math.round(MAX_PASTED_ATTACHMENT_BYTES / (1024 * 1024))} MB)`)
  }
  const staged: string[] = []
  for (const blob of plan.blobs) {
    const bytes = new Uint8Array(await blob.file.arrayBuffer())
    staged.push(await stage(blob.filename, bytes))
  }
  return [...plan.paths, ...staged]
}
