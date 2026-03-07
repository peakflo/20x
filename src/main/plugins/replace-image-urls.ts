/**
 * Utility to replace remote image URLs in task markdown with local attachment URLs.
 *
 * Remote image links from sources like Linear, Notion, and HubSpot expire over time.
 * After downloading attachments locally, we replace those URLs in the markdown so
 * images are always rendered from local files via the app-attachment:// protocol.
 */

interface AttachmentWithSourceUrl {
  id: string
  filename: string
  mime_type?: string
  /** Original remote URL — plugin-specific key (linear_url, notion_url, hubspot_url) */
  [key: string]: unknown
}

/**
 * Build a map from remote URL -> local app-attachment:// URL
 * by checking plugin-specific URL fields on each attachment.
 */
function buildUrlMap(
  taskId: string,
  attachments: AttachmentWithSourceUrl[]
): Map<string, string> {
  const urlMap = new Map<string, string>()
  const sourceUrlKeys = ['linear_url', 'notion_url', 'hubspot_url']

  for (const att of attachments) {
    for (const key of sourceUrlKeys) {
      const remoteUrl = att[key]
      if (typeof remoteUrl === 'string' && remoteUrl) {
        urlMap.set(remoteUrl, `app-attachment://${taskId}/${att.id}`)
      }
    }
  }

  return urlMap
}

/**
 * Replace remote image/file URLs in markdown with local app-attachment:// URLs.
 *
 * Handles:
 * - Markdown images: ![alt](https://remote-url)
 * - Markdown links: [text](https://remote-url)
 * - Plain URLs that appear as standalone text
 *
 * Returns the updated markdown, or the original if no replacements were made.
 */
export function replaceRemoteImageUrls(
  markdown: string,
  taskId: string,
  attachments: AttachmentWithSourceUrl[]
): string {
  if (!markdown || !attachments || attachments.length === 0) return markdown

  const urlMap = buildUrlMap(taskId, attachments)
  if (urlMap.size === 0) return markdown

  let result = markdown

  // Replace URLs in the markdown. We iterate from longest URL to shortest
  // to avoid partial replacements when one URL is a prefix of another.
  const sortedEntries = [...urlMap.entries()].sort(
    (a, b) => b[0].length - a[0].length
  )

  for (const [remoteUrl, localUrl] of sortedEntries) {
    // Escape special regex characters in URL
    const escaped = remoteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Replace all occurrences of this URL
    result = result.replace(new RegExp(escaped, 'g'), localUrl)
  }

  return result
}
