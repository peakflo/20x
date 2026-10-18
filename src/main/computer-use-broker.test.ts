import { beforeEach, describe, expect, it, vi } from 'vitest'

const driver = vi.hoisted(() => ({
  windows: [{ pid: 123, window_id: 7, app_name: 'Notes', title: 'Draft' }],
  calls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
  closed: 0
}))

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    async connect(): Promise<void> {}
    async close(): Promise<void> { driver.closed++ }
    async callTool(call: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
      driver.calls.push(call)
      if (call.name === 'list_windows') return { structuredContent: { windows: driver.windows } }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
  }
}))
vi.mock('@modelcontextprotocol/client/stdio', () => ({ StdioClientTransport: class {} }))

import { ComputerUseBroker } from './computer-use-broker'

describe('ComputerUseBroker', () => {
  beforeEach(() => { driver.calls.length = 0; driver.closed = 0; driver.windows = [{ pid: 123, window_id: 7, app_name: 'Notes', title: 'Draft' }] })

  it('allows only the selected task and fixes every action to its exact window', async () => {
    const broker = new ComputerUseBroker()
    await broker.grantWindow('task-a', 123, 7)
    await expect(broker.act('task-b', 'click', { x: 1, y: 2 })).rejects.toThrow('not enabled')
    await broker.act('task-a', 'click', { x: 10, y: 20, target: { kind: 'desktop', display_id: 'primary' }, pid: 999, scope: 'desktop', delivery_mode: 'foreground', session: 'other' })
    expect(driver.calls.at(-1)).toEqual({
      name: 'click',
      arguments: { x: 10, y: 20, target: { kind: 'window', pid: 123, window_id: 7 }, delivery_mode: 'background' }
    })
    await broker.stop('task-a')
    await expect(broker.act('task-a', 'click', { x: 1, y: 2 })).rejects.toThrow('not enabled')
    expect(driver.closed).toBe(1)
  })

  it('revokes when the granted window disappears', async () => {
    const broker = new ComputerUseBroker()
    await broker.grantWindow('task-a', 123, 7)
    driver.windows = []
    await expect(broker.act('task-a', 'get_window_state', {})).rejects.toThrow('closed or changed owner')
    expect(broker.status().grant).toBeNull()
  })
})
