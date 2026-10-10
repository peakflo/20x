import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchRateTableJson } from './usage-pricing-fetch'

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  const text = JSON.stringify(body)
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json', ...headers } })
}

describe('fetchRateTableJson', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.useRealTimers()
  })

  it('fetches and JSON-parses the body', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ 'gpt-5': { input_cost_per_token: 1e-6 } })) as unknown as typeof fetch
    const result = await fetchRateTableJson('https://example.test/rates.json')
    expect(result).toEqual({ 'gpt-5': { input_cost_per_token: 1e-6 } })
  })

  it('throws on a non-OK response', async () => {
    global.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(fetchRateTableJson('https://example.test/rates.json')).rejects.toThrow(/500/)
  })

  it('rejects when the declared content-length exceeds the byte cap', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ a: 1 }, { 'content-length': String(10 * 1024 * 1024) })) as unknown as typeof fetch
    await expect(
      fetchRateTableJson('https://example.test/rates.json', { maxBytes: 1024 })
    ).rejects.toThrow(/too large/)
  })

  it('rejects a streamed body that exceeds the byte cap even without a content-length header', async () => {
    const big = 'x'.repeat(2048)
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ a: big }), { status: 200 })) as unknown as typeof fetch
    await expect(
      fetchRateTableJson('https://example.test/rates.json', { maxBytes: 100 })
    ).rejects.toThrow(/exceeded/)
  })

  it('aborts after the timeout', async () => {
    global.fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }) as unknown as typeof fetch

    await expect(fetchRateTableJson('https://example.test/rates.json', { timeoutMs: 5 })).rejects.toThrow()
  })
})
