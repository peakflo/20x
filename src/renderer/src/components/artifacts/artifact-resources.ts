import { ArtifactContentKind, type ArtifactContent } from '@shared/artifacts'
import { resolveArtifactLink } from '@shared/artifact-navigation'

type ReadFile = (path: string) => Promise<ArtifactContent | null>

function asDataUrl(content: ArtifactContent): string {
  if (content.kind === ArtifactContentKind.DATA_URL) return content.content
  return `data:${content.mimeType || 'text/plain'};charset=utf-8,${encodeURIComponent(content.content)}`
}

export async function readArtifactResource(
  currentPath: string,
  href: string,
  files: string[],
  read: ReadFile
): Promise<string | null> {
  const path = resolveArtifactLink(currentPath, href, files)
  if (!path) return null
  const content = await read(path).catch(() => null)
  return content ? asDataUrl(content) : null
}

async function replaceCssUrls(css: string, currentPath: string, files: string[], read: ReadFile): Promise<string> {
  const matches = [...css.matchAll(/url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi)]
  const replacements = await Promise.all(matches.map(async (match) => {
    const url = await readArtifactResource(currentPath, match[2].trim(), files, read)
    return url ? `url("${url}")` : match[0]
  }))
  let result = css
  for (let index = matches.length - 1; index >= 0; index--) {
    const offset = matches[index].index!
    result = result.slice(0, offset) + replacements[index] + result.slice(offset + matches[index][0].length)
  }
  return result
}

/** Put only files from this artifact into a sandboxed HTML preview. A srcdoc
 * frame has no file base URL, so relative resource paths must be resolved by
 * the host before the browser loads the frame. */
export async function prepareArtifactHtml(html: string, currentPath: string, files: string[], readFile: ReadFile): Promise<string> {
  // A template keeps resource elements inert while their local paths are
  // replaced. A detached document can still start image or stylesheet loads.
  const template = document.createElement('template')
  template.innerHTML = html
  const fragment = template.content
  const readCache = new Map<string, Promise<ArtifactContent | null>>()
  const read: ReadFile = (path) => {
    if (!readCache.has(path)) readCache.set(path, readFile(path).catch(() => null))
    return readCache.get(path)!
  }
  const elements = [...fragment.querySelectorAll('img[src], video[src], audio[src], source[src], script[src], video[poster], link[href]')]
  await Promise.all(elements.map(async (element) => {
    const attribute = element.tagName === 'LINK' ? 'href' : element.hasAttribute('src') ? 'src' : 'poster'
    if (element.tagName === 'LINK' && element.getAttribute('rel')?.toLowerCase() !== 'stylesheet') return
    const href = element.getAttribute(attribute)
    if (!href) return
    const path = resolveArtifactLink(currentPath, href, files)
    if (!path) return
    const content = await read(path)
    if (!content) return
    if (element.tagName === 'LINK' && content.kind === ArtifactContentKind.TEXT) {
      element.setAttribute(attribute, `data:text/css;charset=utf-8,${encodeURIComponent(await replaceCssUrls(content.content, path, files, read))}`)
    } else {
      element.setAttribute(attribute, asDataUrl(content))
    }
  }))
  await Promise.all([...fragment.querySelectorAll('style')].map(async (element) => {
    element.textContent = await replaceCssUrls(element.textContent || '', currentPath, files, read)
  }))
  await Promise.all([...fragment.querySelectorAll<HTMLElement>('[style]')].map(async (element) => {
    element.setAttribute('style', await replaceCssUrls(element.getAttribute('style') || '', currentPath, files, read))
  }))
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] || '<html>'
  const bodyTag = html.match(/<body\b[^>]*>/i)?.[0] || '<body>'
  return `<!doctype html>${htmlTag}<head></head>${bodyTag}${template.innerHTML}</body></html>`
}
