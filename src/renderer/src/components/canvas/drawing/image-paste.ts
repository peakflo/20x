/**
 * Clipboard image helpers for the drawing layer.
 *
 * Pasted images are downscaled to at most 1024 px on the long edge before
 * being persisted as data URLs — the figures live in the small SQLite
 * settings blob, so keeping each image under a few hundred KB matters
 * (see docs/drawing.md §10).
 */

/** Longest edge (px) a pasted image is allowed to have. */
export const MAX_IMAGE_EDGE = 1024

/** Below this size the original file is kept as-is (no canvas round-trip). */
const SMALL_FILE_BYTES = 300_000

export interface PastedImage {
  /** data URL of the (possibly downscaled) image. */
  src: string
  /** Rendered width in canvas px. */
  width: number
  /** Rendered height in canvas px. */
  height: number
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = src
  })
}

/**
 * Decode an image file and downscale it to a data URL (long edge ≤
 * MAX_IMAGE_EDGE). Returns null when the file cannot be decoded.
 */
export async function downscaleImageToDataUrl(file: File): Promise<PastedImage | null> {
  try {
    const url = URL.createObjectURL(file)
    try {
      const img = await loadImage(url)
      const naturalWidth = img.naturalWidth || img.width
      const naturalHeight = img.naturalHeight || img.height
      if (!naturalWidth || !naturalHeight) return null

      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(naturalWidth, naturalHeight))
      const width = Math.max(1, Math.round(naturalWidth * scale))
      const height = Math.max(1, Math.round(naturalHeight * scale))

      // Small images don't need a canvas round-trip — keep the original bytes.
      if (scale === 1 && file.size < SMALL_FILE_BYTES) {
        return { src: await fileToDataUrl(file), width: naturalWidth, height: naturalHeight }
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        return { src: await fileToDataUrl(file), width: naturalWidth, height: naturalHeight }
      }
      ctx.drawImage(img, 0, 0, width, height)
      return { src: canvas.toDataURL('image/png'), width, height }
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch {
    return null
  }
}

/**
 * Read the first image from the system clipboard. Returns null when the
 * clipboard is unavailable (permissions, non-secure context) or holds no
 * image.
 */
export async function readClipboardImage(): Promise<File | null> {
  const clipboard = navigator.clipboard
  if (!clipboard || typeof clipboard.read !== 'function') return null
  try {
    const items = await clipboard.read()
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (!type) continue
      const blob = await item.getType(type)
      return new File([blob], `pasted-${Date.now()}.png`, { type })
    }
  } catch {
    // Clipboard permission denied or read failed — treat as "no image".
  }
  return null
}
