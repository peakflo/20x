/**
 * Utility functions for URL normalization in plugin attachment handling.
 *
 * Remote file URLs from sources like Linear and Notion include signed query
 * parameters (tokens, expiry timestamps) that change on every API call.
 * Stripping these parameters gives a stable base URL that uniquely identifies
 * the file, enabling reliable duplicate detection across resyncs.
 */

/**
 * Strip query parameters from a URL to get its stable base path.
 * Returns the original string if it's not a valid URL.
 */
export function normalizeUrlForComparison(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}

/**
 * Build a Set of normalized (query-param-stripped) URLs from existing attachment records.
 * @param attachments - array of attachment objects from the task
 * @param urlKey - the key that stores the source URL (e.g. 'linear_url', 'notion_url')
 */
export function buildNormalizedUrlSet(
  attachments: Array<Record<string, unknown>>,
  urlKey: string
): Set<string> {
  const set = new Set<string>()
  for (const att of attachments) {
    const url = att[urlKey]
    if (typeof url === 'string' && url) {
      set.add(normalizeUrlForComparison(url))
    }
  }
  return set
}
