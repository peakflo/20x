import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { ResponsibilityManager } from './responsibility-manager'
import { startMastermindMcpServer, stopMastermindMcpServer } from './mastermind-mcp-server'

const reply = {
  request_id: 'request-1', workspace: { id: 'project-1', name: 'Example', root: '/tmp/example' },
  status: 'processing' as const, skill_version: '1'
}

afterEach(() => stopMastermindMcpServer())

describe('Mastermind MCP server', () => {
  it('advertises only the durable Mastermind communication tool', async () => {
    const manager = {
      communicateWithMastermind: vi.fn(() => reply),
      mastermindMcpRequest: vi.fn(() => reply)
    } as unknown as ResponsibilityManager
    const port = await startMastermindMcpServer(manager, 0, 0)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))

    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['communicate_with_mastermind'])
    const result = await client.callTool({ name: 'communicate_with_mastermind', arguments: { workspace_path: '/tmp/example', message: 'Help', request_id: 'request-1' } })
    expect(manager.communicateWithMastermind).toHaveBeenCalledWith('/tmp/example', 'Help', 'request-1')
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ status: 'processing' })
    await client.close()
  })
})
