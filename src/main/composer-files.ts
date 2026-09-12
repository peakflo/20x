import { clipboard as electronClipboard, nativeImage } from 'electron'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const clipboard = electronClipboard as unknown as Electron.Clipboard
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

/** Finder can supply file URLs alongside a thumbnail or just a display name. */
export async function readClipboardFilePaths(): Promise<string[]> {
  const paths = new Set<string>()
  for (const item of await clipboard.read()) {
    for (const type of ['electron application/osclipboard;format="public.file-url"', 'text/uri-list']) {
      if (!item.types.includes(type)) continue
      const value = await item.getType(type)
      if (!(value instanceof Blob)) continue
      for (const line of (await value.text()).split(/\r?\n/)) {
        if (!line.trim().startsWith('file:')) continue
        const url = new URL(line.trim())
        if (url.hostname && url.hostname !== 'localhost') throw new Error('Please copy a local file.')
        const path = fileURLToPath(url)
        if (path.includes('\0')) throw new Error('The copied file path is invalid.')
        paths.add(path)
      }
    }
  }
  return [...paths]
}

/** Only image bytes cross IPC; the renderer cannot choose a write destination. */
export async function saveComposerImage(data: unknown): Promise<string> {
  if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('Clipboard images must be between 1 byte and 50 MB.')
  }
  const image = nativeImage.createFromBuffer(Buffer.from(data))
  if (image.isEmpty()) throw new Error('This image could not be read. Save it as a file and drop it here.')
  const png = image.toPNG()
  if (!png.length || png.length > MAX_IMAGE_BYTES) throw new Error('Clipboard images must be at most 50 MB.')
  const path = join(tmpdir(), `20x-clipboard-${randomUUID()}.png`)
  try {
    await writeFile(path, png, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    // Never remove another file if exclusive creation failed.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await unlink(path).catch(() => undefined)
    throw error
  }
  return path
}
