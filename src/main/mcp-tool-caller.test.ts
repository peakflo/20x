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
    oauth_metadata: {},
    source: 'user',
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

  describe('task-management tools in process', () => {
    it('answers from the injected invoker and spawns nothing', async () => {
      const invoke = vi.fn(async () => ([{ id: 'task-1', title: 'Real task' }]))
      caller.setTaskManagementInvoker(invoke)

      const result = await caller.callTool(
        makeServer({ name: 'task-management', command: '/should/not/run' }),
        'list_tasks',
        { status: 'not_started' }
      )

      expect(result.success).toBe(true)
      expect(result.result).toEqual([{ id: 'task-1', title: 'Real task' }])
      expect(invoke).toHaveBeenCalledWith('/list_tasks', { status: 'not_started' })
    })

    it('reports a tool that does not exist as a failure', async () => {
      caller.setTaskManagementInvoker(async () => ({ ok: true }))

      const result = await caller.callTool(
        makeServer({ name: 'task-management' }),
        'no_such_tool',
        {}
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('no_such_tool')
    })

    it('falls back to the stdio path when no invoker is set', async () => {
      // Guards the ordering in callTool: without an invoker it must not swallow
      // the call, or a server configured before wiring would answer nothing.
      const server = makeServer({ name: 'task-management', type: 'remote', url: '' })
      const result = await caller.callTool(server, 'list_tasks', {})
      expect(result.success).toBe(false)
    })
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
