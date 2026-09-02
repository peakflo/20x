import { ArtifactClipboardMode, ArtifactContentKind, type ArtifactContent } from '@shared/artifacts'

export enum ArtifactCopyOutcome {
  COPIED_CONTENT = 'copied_content',
  COPIED_FILE = 'copied_file',
  COPIED_IMAGE = 'copied_image',
  COPIED_PATH = 'copied_path',
  SAVED_FILE = 'saved_file',
  SHARED_FILE = 'shared_file',
  FAILED = 'failed'
}

export const ARTIFACT_COPY_LABELS: Record<ArtifactCopyOutcome, string> = {
  [ArtifactCopyOutcome.COPIED_CONTENT]: 'Copied',
  [ArtifactCopyOutcome.COPIED_FILE]: 'File copied',
  [ArtifactCopyOutcome.COPIED_IMAGE]: 'Image copied',
  [ArtifactCopyOutcome.COPIED_PATH]: 'Path copied',
  [ArtifactCopyOutcome.SAVED_FILE]: 'File saved',
  [ArtifactCopyOutcome.SHARED_FILE]: 'File shared',
  [ArtifactCopyOutcome.FAILED]: 'Copy failed'
}

const COPY_FILE_OUTCOMES: Record<ArtifactClipboardMode, ArtifactCopyOutcome> = {
  [ArtifactClipboardMode.FILE]: ArtifactCopyOutcome.COPIED_FILE,
  [ArtifactClipboardMode.IMAGE]: ArtifactCopyOutcome.COPIED_IMAGE,
  [ArtifactClipboardMode.PATH]: ArtifactCopyOutcome.COPIED_PATH,
  [ArtifactClipboardMode.UNAVAILABLE]: ArtifactCopyOutcome.FAILED
}

export function copyFileOutcomeFor(mode: ArtifactClipboardMode): ArtifactCopyOutcome {
  return COPY_FILE_OUTCOMES[mode] || ArtifactCopyOutcome.FAILED
}

/** Decode a `data:` URL into a Blob without a network request. */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/s)
  if (!match) return null
  const [, mimeType, base64Marker, payload] = match
  try {
    if (!base64Marker) return new Blob([decodeURIComponent(payload)], { type: mimeType })
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return new Blob([bytes], { type: mimeType })
  } catch {
    return null
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Copy the content the viewer shows: the text of a document, or the pixels of
 * an image. A browser that refuses the image type gets the data URL as text,
 * which is still usable.
 */
export async function copyArtifactContent(content: ArtifactContent | null): Promise<ArtifactCopyOutcome> {
  if (!content) return ArtifactCopyOutcome.FAILED
  if (content.kind === ArtifactContentKind.TEXT) {
    return (await copyText(content.content)) ? ArtifactCopyOutcome.COPIED_CONTENT : ArtifactCopyOutcome.FAILED
  }

  const blob = dataUrlToBlob(content.content)
  const ClipboardItemConstructor = typeof ClipboardItem === 'undefined' ? null : ClipboardItem
  if (blob && ClipboardItemConstructor && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItemConstructor({ [blob.type]: blob })])
      return ArtifactCopyOutcome.COPIED_IMAGE
    } catch {
      // Most browsers accept image/png only. Fall back to the text form.
    }
  }
  return (await copyText(content.content)) ? ArtifactCopyOutcome.COPIED_CONTENT : ArtifactCopyOutcome.FAILED
}

export function artifactFileName(path: string | undefined, title: string): string {
  const name = path?.split('/').pop()
  return name || title || 'artifact'
}

export function artifactContentToBlob(content: ArtifactContent): Blob | null {
  return content.kind === ArtifactContentKind.DATA_URL
    ? dataUrlToBlob(content.content)
    : new Blob([content.content], { type: content.mimeType || 'text/plain' })
}

/**
 * Hand the file to the platform on a device that has no OS clipboard for
 * files: share it if the browser can, otherwise download it.
 */
export async function shareOrDownloadArtifactFile(
  fileName: string,
  content: ArtifactContent | null
): Promise<ArtifactCopyOutcome> {
  if (!content) return ArtifactCopyOutcome.FAILED
  const blob = artifactContentToBlob(content)
  if (!blob) return ArtifactCopyOutcome.FAILED

  const file = new File([blob], fileName, { type: blob.type })
  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: fileName })
      return ArtifactCopyOutcome.SHARED_FILE
    } catch (reason) {
      // A user who dismisses the share sheet must not see an error.
      if (reason instanceof Error && reason.name === 'AbortError') return ArtifactCopyOutcome.SHARED_FILE
    }
  }

  try {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    return ArtifactCopyOutcome.SAVED_FILE
  } catch {
    return ArtifactCopyOutcome.FAILED
  }
}
