import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'

vi.mock('./task-api-server', () => ({ startTaskApiServer: vi.fn(async () => 1234) }))

afterEach(() => vi.restoreAllMocks())

describe('task-management runtime', () => {
  it('replaces an existing Electron stdio command on macOS', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { db, rawDb } = createTestDb()
    try {
      const existing = db.createMcpServer({
        name: 'task-management',
        command: '/Applications/20x.app/Contents/MacOS/20x',
        environment: { ELECTRON_RUN_AS_NODE: '1' },
      })!
      const manager = db as unknown as { initializeTaskManagementMcpServer(): void }
      manager.initializeTaskManagementMcpServer()
      const updated = db.getMcpServer(existing.id)!
      expect(updated.command).toBe('node')
      expect(updated.environment).toEqual({})
      expect(updated.args[0]).toContain('task-management-mcp.js')
    } finally {
      rawDb.close()
    }
  })
})
