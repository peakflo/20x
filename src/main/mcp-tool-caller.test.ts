import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpToolCaller } from './mcp-tool-caller'
import type { McpServerRecord } from './database'

function makeServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: 'srv-1',
    name: 'Test',
    type: 'local',
    command: 'echo',
    args: [],
    url: '',
    headers: {},
    environment: {},
    tools: [],
    created_at: '',
    updated_at: '',
    ...overrides
  }
}

describe('McpToolCaller', () => {
  let caller: McpToolCaller

  beforeEach(() => {
    caller = new McpToolCaller()
  })

  describe('callRemoteTool', () => {
    it('returns error when no URL', async () => {
      const server = makeServer({ type: 'remote', url: '' })
      const result = await caller.callTool(server, 'test_tool', {})
      expect(result.success).toBe(false)
      expect(result.error).toBe('No URL specified')
    })

    it('returns error on HTTP failure', async () => {
      const server = makeServer({ type: 'remote', url: 'https://api.test.com' })
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await caller.callTool(server, 'test_tool', {})
      expect(result.success).toBe(false)
      expect(result.error).toContain('500')

      vi.unstubAllGlobals()
    })

    it('returns result on success', async () => {
      const server = makeServer({ type: 'remote', url: 'https://api.test.com' })

      const jsonHeaders = { get: () => 'application/json' }
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          // Initialize response
          return { ok: true, headers: jsonHeaders, json: async () => ({ id: 1, result: { capabilities: {} } }) }
        }
        if (callCount === 2) {
          // Notification (fire-and-forget)
          return { ok: true }
        }
        // Tool call response
        return { ok: true, headers: jsonHeaders, json: async () => ({ id: 2, result: { content: [{ type: 'text', text: 'hello' }] } }) }
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await caller.callTool(server, 'test_tool', { arg: 'val' })
      expect(result.success).toBe(true)
      expect(result.result).toBeDefined()

      vi.unstubAllGlobals()
    })
  })

  describe('callLocalTool', () => {
    it('returns error when no command', async () => {
      const server = makeServer({ type: 'local', command: '' })
      const result = await caller.callTool(server, 'test_tool', {})
      expect(result.success).toBe(false)
      expect(result.error).toBe('No command specified')
    })
  })
})
