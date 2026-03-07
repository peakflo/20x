/**
 * Utility to replace remote image URLs in task markdown with local attachment URLs.
 *
 * Remote image links from sources like Linear, Notion, and HubSpot expire over time.
 * After downloading attachments locally, we replace those URLs in the markdown so
 * images are always rendered from local files via the app-attachment:// protocol.
 */

import type { PluginContext } from './types'

/** Keys that plugins use to store the original remote URL on attachment records */
const SOURCE_URL_KEYS = ['linear_url', 'notion_url', 'hubspot_url'] as const

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
  attachments: Array<Record<string, unknown>>
): string {
  if (!markdown || !attachments || attachments.length === 0) return markdown

  // Build map from remote URL -> local app-attachment:// URL
  const urlMap = new Map<string, string>()

  for (const att of attachments) {
    const attId = att.id
    if (typeof attId !== 'string') continue

    for (const key of SOURCE_URL_KEYS) {
      const remoteUrl = att[key]
      if (typeof remoteUrl === 'string' && remoteUrl) {
        urlMap.set(remoteUrl, `app-attachment://${taskId}/${attId}`)
      }
    }
  }

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

/**
 * Re-read a task's description from the DB and replace any remote image URLs
 * with local attachment:// URLs. Writes back only if something changed.
 *
 * Call this once after all attachment downloads are complete for a task.
 */
export function replaceRemoteImageUrlsInTask(
  taskId: string,
  ctx: PluginContext,
  logPrefix: string
): void {
  const task = ctx.db.getTask(taskId)
  if (!task?.description || !task.attachments?.length) return

  const newDescription = replaceRemoteImageUrls(
    task.description,
    taskId,
    task.attachments as unknown as Array<Record<string, unknown>>
  )

  if (newDescription !== task.description) {
    ctx.db.updateTask(taskId, { description: newDescription })
    console.log(`${logPrefix} Replaced remote image URLs with local paths in task ${taskId}`)
  }
}
