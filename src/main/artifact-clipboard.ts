import { ClipboardItem, clipboard as electronClipboard, nativeImage } from 'electron'
import { pathToFileURL } from 'url'
import { ArtifactClipboardMode, type ArtifactCopyFileResult } from '../shared/artifacts'

/** The DOM `Clipboard` interface shadows Electron's in the main-process type
 * graph, so the module export is narrowed back to the Electron one. */
const clipboard = electronClipboard as unknown as Electron.Clipboard

/** Raw pasteboard type Finder reads when one file is copied. Electron exposes
 * a native clipboard format through this custom MIME wrapper. */
const MACOS_FILE_URL_FORMAT = 'electron application/osclipboard;format="public.file-url"'
/** Standard clipboard type a Linux file manager reads for copied files. */
const URI_LIST_FORMAT = 'text/uri-list'
const PNG_FORMAT = 'image/png'

/**
 * Put an artifact file on the OS clipboard so the user can paste the file
 * itself into a file manager, a chat window, or an email.
 *
 * Windows has no supported Electron API for the CF_HDROP file list, so an
 * image file is copied as an image and every other file falls back to its
 * path as text. The caller tells the user which of these happened.
 */
export async function writeArtifactFileToClipboard(filePath: string): Promise<ArtifactCopyFileResult> {
  const fileUrl = pathToFileURL(filePath).toString()

  if (process.platform === 'darwin') {
    await clipboard.write([new ClipboardItem({ [MACOS_FILE_URL_FORMAT]: fileUrl })])
    return { mode: ArtifactClipboardMode.FILE }
  }

  if (process.platform === 'linux') {
    await clipboard.write([new ClipboardItem({ [URI_LIST_FORMAT]: `${fileUrl}\r\n` })])
    return { mode: ArtifactClipboardMode.FILE }
  }

  const image = nativeImage.createFromPath(filePath)
  if (!image.isEmpty()) {
    const png = new Uint8Array(image.toPNG())
    await clipboard.write([new ClipboardItem({ [PNG_FORMAT]: new Blob([png], { type: PNG_FORMAT }) })])
    return { mode: ArtifactClipboardMode.IMAGE }
  }

  await clipboard.writeText(filePath)
  return { mode: ArtifactClipboardMode.PATH }
}
