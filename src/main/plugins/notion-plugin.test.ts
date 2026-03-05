import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, existsSync } from 'fs'
import { NotionPlugin } from './notion-plugin'
import { TaskStatus } from '../../shared/constants'
import type { PluginContext } from './types'
import type { DatabaseManager, TaskRecord } from '../database'

// ── Shared mock instance (reset per test) ────────────────────

const mockClientInstance = {
  getDatabase: vi.fn(),
  queryAllPages: vi.fn(),
  getPageBlocks: vi.fn(),
  blocksToMarkdown: vi.fn(),
  extractFilesFromBlocks: vi.fn(),
  extractFilesFromProperty: vi.fn(),
  downloadFile: vi.fn(),
  updatePage: vi.fn(),
  getUsers: vi.fn(),
  searchDatabases: vi.fn()
}

vi.mock('./notion-client', () => ({
  NotionClient: function NotionClient() {
    return mockClientInstance
  }
}))

// ── Helpers ──────────────────────────────────────────────────

const DB_SCHEMA = {
  id: 'db-1',
  title: [{ plain_text: 'Tasks DB' }],
  properties: {
    Name: { id: 'title', name: 'Name', type: 'title' },
    Status: {
      id: 'status', name: 'Status', type: 'status',
      status: { options: [{ id: 's1', name: 'Not started', color: 'default' }], groups: [] }
    }
  }
}

function makeContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    db: {
      getTaskSource: vi.fn().mockReturnValue({ name: 'Notion', last_synced_at: null }),
      getTaskByExternalId: vi.fn().mockReturnValue(undefined),
      getTask: vi.fn().mockReturnValue({ id: 'task-1', attachments: [] }),
      createTask: vi.fn().mockReturnValue({ id: 'task-new' }),
      updateTask: vi.fn(),
      updateTaskSourceLastSynced: vi.fn(),
      getAttachmentsDir: vi.fn().mockReturnValue(TEST_ATTACHMENTS_DIR)
    } as unknown as DatabaseManager,
    toolCaller: {} as PluginContext['toolCaller'],
    ...overrides
  }
}

function makePage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'page-1',
    archived: false,
    url: 'https://notion.so/page-1',
    last_edited_time: '2025-01-01T00:00:00.000Z',
    created_time: '2025-01-01T00:00:00.000Z',
    properties: {
      Name: { id: 'title', type: 'title', title: [{ plain_text: 'Test Task' }] },
      Status: { id: 'status', type: 'status', status: { id: 's1', name: 'Not started' } }
    },
    ...overrides
  }
}

const TEST_ATTACHMENTS_DIR = '/tmp/test-notion-attachments'
const defaultConfig = { api_token: 'ntn_test', database_id: 'db-1' }

// ── Tests ────────────────────────────────────────────────────

describe('NotionPlugin', () => {
  let plugin: NotionPlugin

  beforeEach(() => {
    vi.clearAllMocks()
    plugin = new NotionPlugin()

    // Ensure test attachments dir exists
    if (!existsSync(TEST_ATTACHMENTS_DIR)) mkdirSync(TEST_ATTACHMENTS_DIR, { recursive: true })

    // Default mock returns
    mockClientInstance.getDatabase.mockResolvedValue(DB_SCHEMA)
    mockClientInstance.queryAllPages.mockResolvedValue([])
    mockClientInstance.getPageBlocks.mockResolvedValue([])
    mockClientInstance.blocksToMarkdown.mockReturnValue('')
    mockClientInstance.extractFilesFromBlocks.mockReturnValue([])
    mockClientInstance.extractFilesFromProperty.mockReturnValue([])
    mockClientInstance.downloadFile.mockResolvedValue({
      buffer: Buffer.from('file-data'),
      filename: 'downloaded.png',
      contentType: 'image/png'
    })
    mockClientInstance.updatePage.mockResolvedValue({})
    mockClientInstance.getUsers.mockResolvedValue([])
  })

  // ── Metadata ────────────────────────────────────────────

  it('has correct metadata', () => {
    expect(plugin.id).toBe('notion')
    expect(plugin.displayName).toBe('Notion')
    expect(plugin.requiresMcpServer).toBe(false)
  })

  it('returns config schema with api_token, database_id, and filters', () => {
    const schema = plugin.getConfigSchema()
    expect(schema).toHaveLength(3)
    expect(schema[0].key).toBe('api_token')
    expect(schema[1].key).toBe('database_id')
    expect(schema[2].key).toBe('filters')
  })

  it('returns field mapping', () => {
    const mapping = plugin.getFieldMapping({})
    expect(mapping.external_id).toBe('id')
    expect(mapping.title).toBe('title')
    expect(mapping.status).toBe('status')
  })

  it('returns change_status and update_priority actions', () => {
    const actions = plugin.getActions({})
    expect(actions).toHaveLength(2)
    expect(actions[0].id).toBe('change_status')
    expect(actions[1].id).toBe('update_priority')
  })

  // ── validateConfig ──────────────────────────────────────

  describe('validateConfig', () => {
    it('returns null for valid config', () => {
      expect(plugin.validateConfig({ api_token: 'ntn_123', database_id: 'db-1' })).toBeNull()
    })

    it('rejects missing api_token', () => {
      expect(plugin.validateConfig({ database_id: 'db-1' })).toBe('Integration token is required')
    })

    it('rejects missing database_id', () => {
      expect(plugin.validateConfig({ api_token: 'ntn_123' })).toBe('Database is required')
    })
  })

  // ── importTasks ─────────────────────────────────────────

  describe('importTasks', () => {
    it('imports new tasks from pages', async () => {
      mockClientInstance.queryAllPages.mockResolvedValue([makePage()])
      mockClientInstance.blocksToMarkdown.mockReturnValue('Page content')

      const ctx = makeContext()
      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(1)
      expect(result.errors).toHaveLength(0)
      expect(ctx.db.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Task',
          external_id: 'page-1',
          source: 'Notion',
          status: TaskStatus.NotStarted
        })
      )
    })

    it('updates existing tasks', async () => {
      mockClientInstance.queryAllPages.mockResolvedValue([makePage()])

      const ctx = makeContext()
      ;(ctx.db.getTaskByExternalId as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'existing-1' })

      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(0)
      expect(result.updated).toBe(1)
      expect(ctx.db.updateTask).toHaveBeenCalledWith(
        'existing-1',
        expect.objectContaining({ title: 'Test Task' })
      )
    })

    it('skips archived pages', async () => {
      mockClientInstance.queryAllPages.mockResolvedValue([makePage({ archived: true })])

      const ctx = makeContext()
      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(0)
      expect(result.updated).toBe(0)
    })

    it('skips pages with empty titles', async () => {
      mockClientInstance.queryAllPages.mockResolvedValue([
        makePage({
          properties: {
            Name: { id: 'title', type: 'title', title: [] },
            Status: { id: 'status', type: 'status', status: { id: 's1', name: 'Not started' } }
          }
        })
      ])

      const ctx = makeContext()
      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(0)
    })

    it('downloads files from Files-type properties', async () => {
      const pageWithFiles = makePage({
        properties: {
          Name: { id: 'title', type: 'title', title: [{ plain_text: 'Task with files' }] },
          Status: { id: 'status', type: 'status', status: { id: 's1', name: 'Not started' } },
          Attachments: {
            id: 'files-1', type: 'files',
            files: [{ name: 'doc.pdf', type: 'file', file: { url: 'https://s3.example.com/doc.pdf' } }]
          }
        }
      })

      mockClientInstance.queryAllPages.mockResolvedValue([pageWithFiles])
      mockClientInstance.extractFilesFromProperty.mockReturnValue([
        { url: 'https://s3.example.com/doc.pdf', filename: 'doc.pdf' }
      ])

      const ctx = makeContext()
      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(1)
      expect(mockClientInstance.extractFilesFromProperty).toHaveBeenCalled()
      expect(mockClientInstance.downloadFile).toHaveBeenCalledWith('https://s3.example.com/doc.pdf')
    })

    it('downloads files from content blocks', async () => {
      mockClientInstance.queryAllPages.mockResolvedValue([makePage()])
      mockClientInstance.getPageBlocks.mockResolvedValue([
        { id: 'img-1', type: 'image', has_children: false, image: { type: 'file', file: { url: 'https://s3.example.com/img.png' } } }
      ])
      mockClientInstance.extractFilesFromBlocks.mockReturnValue([
        { url: 'https://s3.example.com/img.png', filename: 'img.png' }
      ])

      const ctx = makeContext()
      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(1)
      expect(mockClientInstance.extractFilesFromBlocks).toHaveBeenCalled()
      expect(mockClientInstance.downloadFile).toHaveBeenCalledWith('https://s3.example.com/img.png')
    })

    it('saves downloaded files as task attachments', async () => {
      mockClientInstance.queryAllPages.mockResolvedValue([makePage()])
      // Need non-empty blocks so extractFilesFromBlocks is called
      mockClientInstance.getPageBlocks.mockResolvedValue([{ id: 'b1', type: 'image', has_children: false }])
      mockClientInstance.extractFilesFromBlocks.mockReturnValue([
        { url: 'https://s3.example.com/photo.png', filename: 'photo.png' }
      ])
      mockClientInstance.downloadFile.mockResolvedValue({
        buffer: Buffer.from('png-data'),
        filename: 'photo.png',
        contentType: 'image/png'
      })

      const ctx = makeContext()
      await plugin.importTasks('src-1', defaultConfig, ctx)

      // updateTask should be called with attachments including the new one
      // The first updateTask call is from importTasks creating the task description,
      // but since we create (not update), the attachment updateTask is a separate call
      const updateCalls = (ctx.db.updateTask as ReturnType<typeof vi.fn>).mock.calls
      const attachmentCall = updateCalls.find(
        (call: unknown[]) => call[0] === 'task-new' &&
        (call[1] as Record<string, unknown>).attachments !== undefined
      )
      expect(attachmentCall).toBeDefined()
      const attachments = (attachmentCall![1] as Record<string, unknown>).attachments as Array<Record<string, unknown>>
      expect(attachments).toHaveLength(1)
      expect(attachments[0]).toEqual(expect.objectContaining({
        filename: 'photo.png',
        size: 8,
        mime_type: 'image/png',
        notion_url: 'https://s3.example.com/photo.png'
      }))
    })

    it('skips already downloaded files (by notion_url)', async () => {
      mockClientInstance.queryAllPages.mockResolvedValue([makePage()])
      mockClientInstance.extractFilesFromBlocks.mockReturnValue([
        { url: 'https://s3.example.com/already-downloaded.png', filename: 'old.png' }
      ])

      const ctx = makeContext()
      ;(ctx.db.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'task-1',
        attachments: [
          { id: 'att-1', filename: 'old.png', size: 100, mime_type: 'image/png', added_at: '', notion_url: 'https://s3.example.com/already-downloaded.png' }
        ]
      })

      await plugin.importTasks('src-1', defaultConfig, ctx)

      // downloadFile should NOT be called because the URL already exists
      expect(mockClientInstance.downloadFile).not.toHaveBeenCalled()
    })

    it('handles import errors gracefully', async () => {
      mockClientInstance.queryAllPages.mockRejectedValue(new Error('API down'))

      const ctx = makeContext()
      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.errors).toContain('Import failed: API down')
    })

    it('handles per-page errors without stopping import', async () => {
      const goodPage = makePage({ id: 'good' })
      const badPage = makePage({ id: 'bad' })

      mockClientInstance.queryAllPages.mockResolvedValue([goodPage, badPage])

      const ctx = makeContext()
      let callCount = 0
      ;(ctx.db.createTask as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++
        if (callCount === 2) throw new Error('DB error')
        return { id: `task-${callCount}` }
      })

      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('bad')
    })

    it('includes Notion page link in description', async () => {
      mockClientInstance.queryAllPages.mockResolvedValue([
        makePage({ url: 'https://notion.so/my-page' })
      ])

      const ctx = makeContext()
      await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(ctx.db.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining('[View in Notion](https://notion.so/my-page)')
        })
      )
    })

    it('updates last synced timestamp', async () => {
      const ctx = makeContext()
      await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(ctx.db.updateTaskSourceLastSynced).toHaveBeenCalledWith('src-1')
    })

    it('handles download errors without failing the import', async () => {
      mockClientInstance.queryAllPages.mockResolvedValue([makePage()])
      mockClientInstance.extractFilesFromBlocks.mockReturnValue([
        { url: 'https://s3.example.com/broken.png', filename: 'broken.png' }
      ])
      mockClientInstance.downloadFile.mockRejectedValue(new Error('Network error'))

      const ctx = makeContext()
      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      // Task should still be imported even though download failed
      expect(result.imported).toBe(1)
      expect(result.errors).toHaveLength(0)
    })

    it('downloads multiple files from both properties and blocks', async () => {
      const page = makePage({
        properties: {
          Name: { id: 'title', type: 'title', title: [{ plain_text: 'Multi-file task' }] },
          Status: { id: 'status', type: 'status', status: { id: 's1', name: 'Not started' } },
          Docs: {
            id: 'files-1', type: 'files',
            files: [{ name: 'spec.pdf', type: 'file', file: { url: 'https://s3.example.com/spec.pdf' } }]
          }
        }
      })

      mockClientInstance.queryAllPages.mockResolvedValue([page])
      // Need non-empty blocks array so extractFilesFromBlocks is invoked
      mockClientInstance.getPageBlocks.mockResolvedValue([{ id: 'b1', type: 'image', has_children: false }])
      mockClientInstance.extractFilesFromProperty.mockReturnValue([
        { url: 'https://s3.example.com/spec.pdf', filename: 'spec.pdf' }
      ])
      mockClientInstance.extractFilesFromBlocks.mockReturnValue([
        { url: 'https://s3.example.com/screenshot.png', filename: 'screenshot.png' }
      ])

      const ctx = makeContext()
      await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(mockClientInstance.downloadFile).toHaveBeenCalledTimes(2)
      expect(mockClientInstance.downloadFile).toHaveBeenCalledWith('https://s3.example.com/spec.pdf')
      expect(mockClientInstance.downloadFile).toHaveBeenCalledWith('https://s3.example.com/screenshot.png')
    })
  })

  // ── formatPropertyValue (files type) ────────────────────

  describe('formatPropertyValue (via formatProperties)', () => {
    it('formats files property as markdown links in description', async () => {
      const page = makePage({
        properties: {
          Name: { id: 'title', type: 'title', title: [{ plain_text: 'Task' }] },
          Docs: {
            id: 'files-1', type: 'files',
            files: [
              { name: 'report.pdf', type: 'file', file: { url: 'https://example.com/report.pdf' } },
              { name: 'logo.svg', type: 'external', external: { url: 'https://cdn.example.com/logo.svg' } }
            ]
          }
        }
      })

      mockClientInstance.queryAllPages.mockResolvedValue([page])

      const ctx = makeContext()
      await plugin.importTasks('src-1', defaultConfig, ctx)

      const createCall = (ctx.db.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(createCall.description).toContain('[report.pdf](https://example.com/report.pdf)')
      expect(createCall.description).toContain('[logo.svg](https://cdn.example.com/logo.svg)')
    })

    it('handles empty files property gracefully', async () => {
      const page = makePage({
        properties: {
          Name: { id: 'title', type: 'title', title: [{ plain_text: 'Task' }] },
          Docs: { id: 'files-1', type: 'files', files: [] }
        }
      })

      mockClientInstance.queryAllPages.mockResolvedValue([page])

      const ctx = makeContext()
      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(1)
      const createCall = (ctx.db.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(createCall.description).not.toContain('Docs')
    })
  })

  // ── executeAction ───────────────────────────────────────

  describe('executeAction', () => {
    it('returns error when no external_id', async () => {
      const ctx = makeContext()
      const task = { id: 'local-1', external_id: null } as TaskRecord
      const result = await plugin.executeAction('change_status', task, 'Done', defaultConfig, ctx)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Task has no external ID')
    })

    it('returns error when no input', async () => {
      const ctx = makeContext()
      const task = { id: 'local-1', external_id: 'ext-1' } as TaskRecord
      const result = await plugin.executeAction('change_status', task, undefined, defaultConfig, ctx)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Input value is required')
    })

    it('returns error for unknown action', async () => {
      const ctx = makeContext()
      const task = { id: 'local-1', external_id: 'ext-1' } as TaskRecord
      const result = await plugin.executeAction('unknown_action', task, 'value', defaultConfig, ctx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown action')
    })
  })
})
