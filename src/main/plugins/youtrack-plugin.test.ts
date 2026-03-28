import { describe, it, expect, vi, beforeEach } from 'vitest'
import { YouTrackPlugin } from './youtrack-plugin'
import { TaskStatus } from '../../shared/constants'
import type { PluginContext } from './types'
import type { DatabaseManager, TaskRecord } from '../database'

// ── Shared mock instance (reset per test) ────────────────────

const mockClientInstance = {
  testConnection: vi.fn(),
  getIssues: vi.fn(),
  getAllIssues: vi.fn(),
  getIssue: vi.fn(),
  updateIssue: vi.fn(),
  addComment: vi.fn(),
  getProjects: vi.fn(),
  getUsers: vi.fn(),
  getProjectCustomFields: vi.fn(),
  downloadAttachment: vi.fn(),
  getBaseUrl: vi.fn().mockReturnValue('https://youtrack.example.com')
}

vi.mock('./youtrack-client', () => ({
  YouTrackClient: function YouTrackClient() {
    return mockClientInstance
  }
}))

// ── Helpers ──────────────────────────────────────────────────

const TEST_ATTACHMENTS_DIR = '/tmp/test-youtrack-attachments'

function makeContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    db: {
      getTaskSource: vi.fn().mockReturnValue({ name: 'YouTrack', last_synced_at: null }),
      getTasks: vi.fn().mockReturnValue([]),
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

function makeIssue(overrides: Partial<{
  id: string
  idReadable: string
  summary: string
  description: string | null
  customFields: Array<{ name: string; value: unknown; projectCustomField?: unknown }>
  tags: Array<{ id: string; name: string }>
  attachments: Array<{ id: string; name: string; url: string; size: number; mimeType: string }>
  project: { id: string; name: string; shortName: string }
  created: number
  updated: number
  resolved: number | null
}> = {}) {
  return {
    id: 'issue-abc',
    idReadable: 'TST-1',
    summary: 'Test Issue',
    description: 'Issue description body',
    created: Date.now(),
    updated: Date.now(),
    resolved: null,
    project: { id: 'proj-1', name: 'Test Project', shortName: 'TST' },
    reporter: { login: 'admin', fullName: 'Admin User' },
    customFields: [
      { name: 'State', value: { name: 'Open' }, projectCustomField: { field: { name: 'State', fieldType: { id: 'state[1]' } } } },
      { name: 'Priority', value: { name: 'Normal' }, projectCustomField: { field: { name: 'Priority', fieldType: { id: 'ownedField[1]' } } } },
      { name: 'Assignee', value: { login: 'john', fullName: 'John Doe' }, projectCustomField: { field: { name: 'Assignee', fieldType: { id: 'user[1]' } } } },
      { name: 'Type', value: { name: 'Bug' }, projectCustomField: { field: { name: 'Type', fieldType: { id: 'enum[1]' } } } }
    ],
    tags: [{ id: 'tag-1', name: 'important' }],
    attachments: [],
    links: [],
    ...overrides
  }
}

const defaultConfig = {
  server_url: 'https://youtrack.example.com',
  api_token: 'perm:test-token',
  project: 'TST'
}

// ── Tests ────────────────────────────────────────────────────

describe('YouTrackPlugin', () => {
  let plugin: YouTrackPlugin

  beforeEach(() => {
    vi.clearAllMocks()
    plugin = new YouTrackPlugin()
  })

  describe('metadata', () => {
    it('has correct plugin id and display name', () => {
      expect(plugin.id).toBe('youtrack')
      expect(plugin.displayName).toBe('YouTrack')
      expect(plugin.requiresMcpServer).toBe(false)
    })
  })

  describe('getConfigSchema', () => {
    it('returns required fields: server_url, api_token, project', () => {
      const schema = plugin.getConfigSchema()
      const keys = schema.map((f) => f.key)
      expect(keys).toContain('server_url')
      expect(keys).toContain('api_token')
      expect(keys).toContain('project')

      const serverUrl = schema.find((f) => f.key === 'server_url')
      expect(serverUrl?.required).toBe(true)
      expect(serverUrl?.type).toBe('text')

      const apiToken = schema.find((f) => f.key === 'api_token')
      expect(apiToken?.required).toBe(true)
      expect(apiToken?.type).toBe('password')

      const project = schema.find((f) => f.key === 'project')
      expect(project?.required).toBe(true)
      expect(project?.type).toBe('dynamic-select')
    })

    it('includes optional filter fields', () => {
      const schema = plugin.getConfigSchema()
      const keys = schema.map((f) => f.key)
      expect(keys).toContain('assignee')
      expect(keys).toContain('state')
      expect(keys).toContain('priority')
      expect(keys).toContain('issue_type')
      expect(keys).toContain('custom_query')
    })

    it('has proper dependsOn chains', () => {
      const schema = plugin.getConfigSchema()
      const project = schema.find((f) => f.key === 'project')
      expect(project?.dependsOn).toEqual({ field: 'api_token', value: '__any__' })

      const state = schema.find((f) => f.key === 'state')
      expect(state?.dependsOn).toEqual({ field: 'project', value: '__any__' })
    })
  })

  describe('validateConfig', () => {
    it('returns null for valid config', () => {
      expect(plugin.validateConfig(defaultConfig)).toBeNull()
    })

    it('returns error for missing server_url', () => {
      expect(plugin.validateConfig({ api_token: 'tok', project: 'P' }))
        .toBe('Server URL is required')
    })

    it('returns error for missing api_token', () => {
      expect(plugin.validateConfig({ server_url: 'http://x', project: 'P' }))
        .toBe('Permanent token is required')
    })

    it('returns error for missing project', () => {
      expect(plugin.validateConfig({ server_url: 'http://x', api_token: 'tok' }))
        .toBe('Project is required')
    })
  })

  describe('getFieldMapping', () => {
    it('returns correct field mapping', () => {
      const mapping = plugin.getFieldMapping(defaultConfig)
      expect(mapping.external_id).toBe('id')
      expect(mapping.title).toBe('summary')
      expect(mapping.description).toBe('description')
      expect(mapping.status).toBe('State')
      expect(mapping.priority).toBe('Priority')
      expect(mapping.assignee).toBe('Assignee')
      expect(mapping.labels).toBe('tags')
    })
  })

  describe('getActions', () => {
    it('returns expected actions', () => {
      const actions = plugin.getActions(defaultConfig)
      const ids = actions.map((a) => a.id)
      expect(ids).toContain('open_in_youtrack')
      expect(ids).toContain('add_comment')
      expect(ids).toContain('change_state')
    })
  })

  describe('resolveOptions', () => {
    it('resolves projects from YouTrack API', async () => {
      mockClientInstance.getProjects.mockResolvedValue([
        { id: '1', name: 'Alpha', shortName: 'ALP' },
        { id: '2', name: 'Beta', shortName: 'BET' }
      ])

      const ctx = makeContext()
      const options = await plugin.resolveOptions('projects', defaultConfig, ctx)

      expect(options).toHaveLength(2)
      expect(options[0]).toEqual({ value: 'ALP', label: 'Alpha (ALP)' })
      expect(options[1]).toEqual({ value: 'BET', label: 'Beta (BET)' })
    })

    it('resolves users from YouTrack API', async () => {
      mockClientInstance.getUsers.mockResolvedValue([
        { id: '1', login: 'john', fullName: 'John Doe' }
      ])

      const ctx = makeContext()
      const options = await plugin.resolveOptions('users', defaultConfig, ctx)

      expect(options).toHaveLength(1)
      expect(options[0]).toEqual({ value: 'john', label: 'John Doe' })
    })

    it('resolves states from project custom fields', async () => {
      mockClientInstance.getProjects.mockResolvedValue([
        { id: 'proj-1', name: 'Test', shortName: 'TST' }
      ])
      mockClientInstance.getProjectCustomFields.mockResolvedValue([
        {
          id: 'cf-1',
          field: { name: 'State', fieldType: { id: 'state[1]' } },
          bundle: { values: [{ name: 'Open' }, { name: 'In Progress' }, { name: 'Fixed' }] }
        }
      ])

      const ctx = makeContext()
      const options = await plugin.resolveOptions('states', defaultConfig, ctx)

      expect(options).toHaveLength(3)
      expect(options[0]).toEqual({ value: 'Open', label: 'Open' })
      expect(options[1]).toEqual({ value: 'In Progress', label: 'In Progress' })
    })

    it('resolves priorities from project custom fields', async () => {
      mockClientInstance.getProjects.mockResolvedValue([
        { id: 'proj-1', name: 'Test', shortName: 'TST' }
      ])
      mockClientInstance.getProjectCustomFields.mockResolvedValue([
        {
          id: 'cf-2',
          field: { name: 'Priority', fieldType: { id: 'ownedField[1]' } },
          bundle: { values: [{ name: 'Critical' }, { name: 'Normal' }, { name: 'Minor' }] }
        }
      ])

      const ctx = makeContext()
      const options = await plugin.resolveOptions('priorities', defaultConfig, ctx)

      expect(options).toHaveLength(3)
      expect(options[0]).toEqual({ value: 'Critical', label: 'Critical' })
    })

    it('returns empty array when server_url is missing', async () => {
      const ctx = makeContext()
      const options = await plugin.resolveOptions('projects', { api_token: 'tok' }, ctx)
      expect(options).toEqual([])
    })

    it('returns empty array for unknown resolver key', async () => {
      const ctx = makeContext()
      const options = await plugin.resolveOptions('unknown', defaultConfig, ctx)
      expect(options).toEqual([])
    })
  })

  describe('importTasks', () => {
    it('imports new issues as tasks', async () => {
      const issue = makeIssue()
      mockClientInstance.getAllIssues.mockResolvedValue([issue])

      const ctx = makeContext()
      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(1)
      expect(result.updated).toBe(0)
      expect(result.errors).toHaveLength(0)

      const mockDb = ctx.db as unknown as {
        createTask: ReturnType<typeof vi.fn>
        updateTaskSourceLastSynced: ReturnType<typeof vi.fn>
      }
      expect(mockDb.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Issue',
          external_id: 'issue-abc',
          source_id: 'src-1',
          source: 'YouTrack',
          status: TaskStatus.NotStarted,
          priority: 'medium',
          assignee: 'John Doe',
          labels: ['important']
        })
      )
      expect(mockDb.updateTaskSourceLastSynced).toHaveBeenCalledWith('src-1')
    })

    it('updates existing tasks on re-sync', async () => {
      const issue = makeIssue()
      mockClientInstance.getAllIssues.mockResolvedValue([issue])

      const existingTask = {
        id: 'task-existing',
        description: 'old desc',
        attachments: []
      }

      const ctx = makeContext()
      const mockDb = ctx.db as unknown as {
        getTaskByExternalId: ReturnType<typeof vi.fn>
        getTask: ReturnType<typeof vi.fn>
        updateTask: ReturnType<typeof vi.fn>
      }
      mockDb.getTaskByExternalId.mockReturnValue(existingTask)
      mockDb.getTask.mockReturnValue(existingTask)

      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(0)
      expect(result.updated).toBe(1)
      expect(mockDb.updateTask).toHaveBeenCalledWith(
        'task-existing',
        expect.objectContaining({
          title: 'Test Issue',
          status: TaskStatus.NotStarted,
          priority: 'medium',
          assignee: 'John Doe'
        })
      )
    })

    it('maps YouTrack states to local statuses correctly', async () => {
      const testCases = [
        { state: 'Open', expected: TaskStatus.NotStarted },
        { state: 'In Progress', expected: TaskStatus.AgentWorking },
        { state: 'In Review', expected: TaskStatus.ReadyForReview },
        { state: 'Fixed', expected: TaskStatus.Completed },
        { state: 'Done', expected: TaskStatus.Completed }
      ]

      for (const { state, expected } of testCases) {
        vi.clearAllMocks()
        const issue = makeIssue({
          customFields: [
            { name: 'State', value: { name: state }, projectCustomField: { field: { name: 'State', fieldType: { id: 'state[1]' } } } },
            { name: 'Priority', value: { name: 'Normal' }, projectCustomField: { field: { name: 'Priority', fieldType: { id: 'ownedField[1]' } } } },
            { name: 'Assignee', value: null, projectCustomField: { field: { name: 'Assignee', fieldType: { id: 'user[1]' } } } }
          ]
        })
        mockClientInstance.getAllIssues.mockResolvedValue([issue])

        const ctx = makeContext()
        await plugin.importTasks('src-1', defaultConfig, ctx)

        const mockDb = ctx.db as unknown as { createTask: ReturnType<typeof vi.fn> }
        expect(mockDb.createTask).toHaveBeenCalledWith(
          expect.objectContaining({ status: expected })
        )
      }
    })

    it('maps YouTrack priorities to local priorities', async () => {
      const testCases = [
        { priority: 'Critical', expected: 'critical' },
        { priority: 'Major', expected: 'high' },
        { priority: 'Normal', expected: 'medium' },
        { priority: 'Minor', expected: 'low' }
      ]

      for (const { priority, expected } of testCases) {
        vi.clearAllMocks()
        const issue = makeIssue({
          customFields: [
            { name: 'State', value: { name: 'Open' }, projectCustomField: { field: { name: 'State', fieldType: { id: 'state[1]' } } } },
            { name: 'Priority', value: { name: priority }, projectCustomField: { field: { name: 'Priority', fieldType: { id: 'ownedField[1]' } } } }
          ]
        })
        mockClientInstance.getAllIssues.mockResolvedValue([issue])

        const ctx = makeContext()
        await plugin.importTasks('src-1', defaultConfig, ctx)

        const mockDb = ctx.db as unknown as { createTask: ReturnType<typeof vi.fn> }
        expect(mockDb.createTask).toHaveBeenCalledWith(
          expect.objectContaining({ priority: expected })
        )
      }
    })

    it('builds description with properties table and issue link', async () => {
      const issue = makeIssue()
      mockClientInstance.getAllIssues.mockResolvedValue([issue])

      const ctx = makeContext()
      await plugin.importTasks('src-1', defaultConfig, ctx)

      const mockDb = ctx.db as unknown as { createTask: ReturnType<typeof vi.fn> }
      const createCall = mockDb.createTask.mock.calls[0][0]
      expect(createCall.description).toContain('Issue description body')
      expect(createCall.description).toContain('View in YouTrack')
      expect(createCall.description).toContain('TST-1')
      expect(createCall.description).toContain('**Properties**')
    })

    it('handles null description gracefully', async () => {
      const issue = makeIssue({ description: null })
      mockClientInstance.getAllIssues.mockResolvedValue([issue])

      const ctx = makeContext()
      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(1)
      expect(result.errors).toHaveLength(0)
    })

    it('skips issues with empty summary', async () => {
      const issue = makeIssue({ summary: '' })
      mockClientInstance.getAllIssues.mockResolvedValue([issue])

      const ctx = makeContext()
      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(0)
    })

    it('builds YQL query with project and filters', async () => {
      mockClientInstance.getAllIssues.mockResolvedValue([])

      const config = {
        ...defaultConfig,
        assignee: ['john', 'jane'],
        state: ['Open', 'In Progress'],
        priority: ['Critical'],
        issue_type: ['Bug'],
        custom_query: '#Unresolved'
      }

      const ctx = makeContext()
      await plugin.importTasks('src-1', config, ctx)

      const yql = mockClientInstance.getAllIssues.mock.calls[0][0]
      expect(yql).toContain('project: {TST}')
      expect(yql).toContain('for: {john}, {jane}')
      expect(yql).toContain('State: {Open}, {In Progress}')
      expect(yql).toContain('Priority: {Critical}')
      expect(yql).toContain('Type: {Bug}')
      expect(yql).toContain('#Unresolved')
    })

    it('always does a full sync without incremental updated filter', async () => {
      mockClientInstance.getAllIssues.mockResolvedValue([])

      const ctx = makeContext()
      const mockDb = ctx.db as unknown as {
        getTaskSource: ReturnType<typeof vi.fn>
      }
      mockDb.getTaskSource.mockReturnValue({
        name: 'YouTrack',
        last_synced_at: '2025-06-15T10:30:00.000Z'
      })

      await plugin.importTasks('src-1', defaultConfig, ctx)

      const yql = mockClientInstance.getAllIssues.mock.calls[0][0] as string
      // Full sync should NOT include an updated: filter
      expect(yql).not.toMatch(/updated:/)
      expect(yql).toContain('project: {TST}')
    })

    it('captures per-issue errors without failing the whole import', async () => {
      const goodIssue = makeIssue({ id: 'good', idReadable: 'TST-1' })
      const badIssue = makeIssue({ id: 'bad', idReadable: 'TST-2' })
      mockClientInstance.getAllIssues.mockResolvedValue([goodIssue, badIssue])

      const ctx = makeContext()
      const mockDb = ctx.db as unknown as { createTask: ReturnType<typeof vi.fn> }
      // First call succeeds, second fails
      mockDb.createTask
        .mockReturnValueOnce({ id: 'task-1' })
        .mockImplementationOnce(() => { throw new Error('DB error') })

      const result = await plugin.importTasks('src-1', defaultConfig, ctx)

      expect(result.imported).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('TST-2')
    })
  })

  describe('exportUpdate', () => {
    it('updates summary on title change', async () => {
      const task = { external_id: 'issue-abc' } as TaskRecord
      await plugin.exportUpdate(task, { title: 'New Title' }, defaultConfig, makeContext())

      expect(mockClientInstance.updateIssue).toHaveBeenCalledWith(
        'issue-abc',
        expect.objectContaining({ summary: 'New Title' })
      )
    })

    it('updates State custom field on status change', async () => {
      const task = { external_id: 'issue-abc' } as TaskRecord
      await plugin.exportUpdate(
        task,
        { status: TaskStatus.AgentWorking },
        defaultConfig,
        makeContext()
      )

      expect(mockClientInstance.updateIssue).toHaveBeenCalledWith(
        'issue-abc',
        expect.objectContaining({
          customFields: expect.arrayContaining([
            { name: 'State', value: { name: 'In Progress' } }
          ])
        })
      )
    })

    it('does nothing when task has no external_id', async () => {
      const task = { external_id: null } as unknown as TaskRecord
      await plugin.exportUpdate(task, { title: 'X' }, defaultConfig, makeContext())
      expect(mockClientInstance.updateIssue).not.toHaveBeenCalled()
    })
  })

  describe('executeAction', () => {
    it('open_in_youtrack returns issue URL', async () => {
      mockClientInstance.getIssue.mockResolvedValue({ idReadable: 'TST-42' })

      const task = { external_id: 'issue-abc' } as TaskRecord
      const result = await plugin.executeAction(
        'open_in_youtrack',
        task,
        undefined,
        defaultConfig,
        makeContext()
      )

      expect(result.success).toBe(true)
      expect(result.taskUpdate?._openUrl).toBe(
        'https://youtrack.example.com/issue/TST-42'
      )
    })

    it('add_comment calls addComment on client', async () => {
      mockClientInstance.addComment.mockResolvedValue(undefined)

      const task = { external_id: 'issue-abc' } as TaskRecord
      const result = await plugin.executeAction(
        'add_comment',
        task,
        'Test comment',
        defaultConfig,
        makeContext()
      )

      expect(result.success).toBe(true)
      expect(mockClientInstance.addComment).toHaveBeenCalledWith(
        'issue-abc',
        'Test comment'
      )
    })

    it('add_comment fails without input', async () => {
      const task = { external_id: 'issue-abc' } as TaskRecord
      const result = await plugin.executeAction(
        'add_comment',
        task,
        undefined,
        defaultConfig,
        makeContext()
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('required')
    })

    it('change_state updates State custom field', async () => {
      mockClientInstance.updateIssue.mockResolvedValue(undefined)

      const task = { external_id: 'issue-abc' } as TaskRecord
      const result = await plugin.executeAction(
        'change_state',
        task,
        'In Progress',
        defaultConfig,
        makeContext()
      )

      expect(result.success).toBe(true)
      expect(result.taskUpdate?.status).toBe(TaskStatus.AgentWorking)
      expect(mockClientInstance.updateIssue).toHaveBeenCalledWith(
        'issue-abc',
        { customFields: [{ name: 'State', value: { name: 'In Progress' } }] }
      )
    })

    it('complete action updates State to Done and sets Completed status', async () => {
      mockClientInstance.updateIssue.mockResolvedValue(undefined)

      const task = { external_id: 'issue-abc' } as TaskRecord
      const result = await plugin.executeAction(
        'complete',
        task,
        undefined,
        defaultConfig,
        makeContext()
      )

      expect(result.success).toBe(true)
      expect(result.taskUpdate?.status).toBe(TaskStatus.Completed)
      expect(mockClientInstance.updateIssue).toHaveBeenCalledWith(
        'issue-abc',
        { customFields: [{ name: 'State', value: { name: 'Done' } }] }
      )
    })

    it('complete action returns error on API failure', async () => {
      mockClientInstance.updateIssue.mockRejectedValue(new Error('API timeout'))

      const task = { external_id: 'issue-abc' } as TaskRecord
      const result = await plugin.executeAction(
        'complete',
        task,
        undefined,
        defaultConfig,
        makeContext()
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('Failed to complete issue')
    })

    it('returns error for unknown action', async () => {
      const task = { external_id: 'issue-abc' } as TaskRecord
      const result = await plugin.executeAction(
        'unknown_action',
        task,
        undefined,
        defaultConfig,
        makeContext()
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown action')
    })

    it('returns error when task has no external_id', async () => {
      const task = { external_id: null } as unknown as TaskRecord
      const result = await plugin.executeAction(
        'add_comment',
        task,
        'text',
        defaultConfig,
        makeContext()
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('no external ID')
    })
  })

  describe('getUsers', () => {
    it('returns mapped users', async () => {
      mockClientInstance.getUsers.mockResolvedValue([
        { id: '1', login: 'john', fullName: 'John Doe', email: 'john@example.com' },
        { id: '2', login: 'jane', fullName: '', email: '' }
      ])

      const users = await plugin.getUsers(defaultConfig, makeContext())

      expect(users).toHaveLength(2)
      expect(users[0]).toEqual({ id: 'john', email: 'john@example.com', name: 'John Doe' })
      expect(users[1]).toEqual({ id: 'jane', email: '', name: 'jane' }) // fallback to login
    })

    it('returns empty array on error', async () => {
      mockClientInstance.getUsers.mockRejectedValue(new Error('Network error'))
      const users = await plugin.getUsers(defaultConfig, makeContext())
      expect(users).toEqual([])
    })
  })

  describe('reassignTask', () => {
    it('updates Assignee custom field', async () => {
      mockClientInstance.updateIssue.mockResolvedValue(undefined)

      const task = { external_id: 'issue-abc' } as TaskRecord
      const result = await plugin.reassignTask(
        task,
        ['john'],
        defaultConfig,
        makeContext()
      )

      expect(result.success).toBe(true)
      expect(mockClientInstance.updateIssue).toHaveBeenCalledWith(
        'issue-abc',
        { customFields: [{ name: 'Assignee', value: { login: 'john' } }] }
      )
    })

    it('returns error when no user specified', async () => {
      const task = { external_id: 'issue-abc' } as TaskRecord
      const result = await plugin.reassignTask(task, [], defaultConfig, makeContext())

      expect(result.success).toBe(false)
      expect(result.error).toContain('No user specified')
    })
  })

  describe('getSetupDocumentation', () => {
    it('returns markdown documentation', () => {
      const docs = plugin.getSetupDocumentation!()
      expect(docs).toContain('# YouTrack Integration Setup')
      expect(docs).toContain('Permanent Token')
      expect(docs).toContain('YQL')
    })
  })
})
