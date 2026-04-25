#!/usr/bin/env node
/**
 * Test script that simulates what the claude binary does:
 * connects to a local MCP proxy URL and sends JSON-RPC requests.
 *
 * Usage:
 *   node scripts/test-mcp-proxy-client.mjs <proxy-url>
 *
 * Example:
 *   node scripts/test-mcp-proxy-client.mjs http://127.0.0.1:50066/1
 *
 * This sends MCP Streamable HTTP requests (JSON-RPC over POST)
 * exactly like the claude binary would.
 */

const proxyUrl = process.argv[2]

if (!proxyUrl) {
  console.error('Usage: node scripts/test-mcp-proxy-client.mjs <proxy-url>')
  console.error('Example: node scripts/test-mcp-proxy-client.mjs http://127.0.0.1:50066/1')
  process.exit(1)
}

async function sendJsonRpc(url, method, params = {}, id = 1) {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params, id })
  console.log(`\n→ POST ${url}`)
  console.log(`  Body: ${body}`)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    console.log(`← Status: ${res.status} ${res.statusText}`)
    console.log(`  Headers:`, Object.fromEntries(res.headers.entries()))
    const text = await res.text()
    console.log(`  Body: ${text.substring(0, 500)}`)
    return { status: res.status, text }
  } catch (err) {
    console.error(`✗ Error: ${err.message}`)
    return { status: 0, error: err.message }
  }
}

async function testSSE(url) {
  const sseUrl = url.replace(/\/$/, '') + '/sse'
  console.log(`\n→ GET ${sseUrl} (SSE)`)

  try {
    const res = await fetch(sseUrl, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    })
    console.log(`← Status: ${res.status} ${res.statusText}`)
    console.log(`  Content-Type: ${res.headers.get('content-type')}`)

    if (res.status === 200) {
      // Read first few events
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let chunks = ''
      const timeout = setTimeout(() => {
        reader.cancel()
      }, 3000)

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks += decoder.decode(value, { stream: true })
          console.log(`  SSE chunk: ${decoder.decode(value).substring(0, 200)}`)
        }
      } catch {
        // reader cancelled by timeout
      }
      clearTimeout(timeout)
    } else {
      const text = await res.text()
      console.log(`  Body: ${text}`)
    }
  } catch (err) {
    console.error(`✗ SSE Error: ${err.message}`)
  }
}

console.log('=== MCP Proxy Client Test ===')
console.log(`Target: ${proxyUrl}`)
console.log('')

// Test 1: MCP initialize
console.log('--- Test 1: initialize ---')
await sendJsonRpc(proxyUrl, 'initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '1.0' },
})

// Test 2: tools/list
console.log('\n--- Test 2: tools/list ---')
await sendJsonRpc(proxyUrl, 'tools/list', {}, 2)

// Test 3: SSE endpoint
console.log('\n--- Test 3: SSE endpoint ---')
await testSSE(proxyUrl)

console.log('\n=== Done ===')
