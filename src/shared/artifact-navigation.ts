import { ArtifactType } from './artifacts'

export function artifactFileType(path: string): ArtifactType {
  const extension = path.split('.').pop()?.toLowerCase()
  if (extension === 'md' || extension === 'mdx') return ArtifactType.MARKDOWN
  if (extension === 'html' || extension === 'htm') return ArtifactType.HTML
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension || '')) return ArtifactType.IMAGE
  return ArtifactType.FILE
}

export function isLocalArtifactLink(href: string): boolean {
  return !!href && !href.startsWith('#') && !href.startsWith('//') && !/^[a-z][a-z\d+.-]*:/i.test(href)
}

/** Resolve only files in the workpiece inventory. Never turn a link into an
 * unrestricted workspace read, even when it contains parent segments. */
export function resolveArtifactLink(currentPath: string, href: string, files: string[]): string | null {
  if (!isLocalArtifactLink(href)) return null
  let path: string
  try { path = decodeURIComponent(href.split(/[?#]/)[0]) } catch { return null }
  if (!path || path.includes('\\') || path.includes('\0')) return null
  const normalize = (value: string): string | null => {
    const parts: string[] = []
    for (const part of value.split('/')) {
      if (part === '..') { if (!parts.length) return null; parts.pop() }
      else if (part && part !== '.') parts.push(part)
    }
    return parts.join('/')
  }
  const relative = normalize(`${currentPath.slice(0, currentPath.lastIndexOf('/') + 1)}${path}`)
  const workspace = normalize(path)
  return [relative, workspace].find((candidate) => candidate !== null && files.includes(candidate)) || null
}
