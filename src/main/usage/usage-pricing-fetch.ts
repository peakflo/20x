/**
 * Network fetch of the public rate table. Kept separate from
 * `usage-pricing.ts` (pure parsing) and `usage-pricing-service.ts` (caching /
 * TTL) so the parsing and caching logic can be unit tested without a real
 * network call.
 */

export const RATE_TABLE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
export const RATE_TABLE_FETCH_TIMEOUT_MS = 10_000
/** A few MB — the real file is a few MB of JSON; this guards against a redirected/corrupt response growing without bound. */
export const RATE_TABLE_MAX_BYTES = 8 * 1024 * 1024

/** Fetches and JSON-parses `url`, aborting after `timeoutMs` or once the body exceeds `maxBytes`. */
export async function fetchRateTableJson(
  url: string = RATE_TABLE_URL,
  options: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? RATE_TABLE_FETCH_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? RATE_TABLE_MAX_BYTES
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`Rate table fetch failed: HTTP ${response.status}`)

    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`Rate table response too large (${declaredLength} bytes)`)
    }

    const text = await readBodyCapped(response, maxBytes)
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return await response.text()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) throw new Error(`Rate table response exceeded ${maxBytes} bytes`)
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}
