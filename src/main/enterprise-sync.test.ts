import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EnterpriseSyncManager } from './enterprise-sync'
import type { SkillRecord } from './database'
import type { WorkfloSkill, WorkfloOrgNode } from './workflo-api-client'

// ── Helpers ──────────────────────────────────────────────────────────────

function makeLocalSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: 'local-1',
    name: 'Test Skill',
    description: 'A test skill',
    content: '# Test',
    version: 1,
    confidence: 0.8,
    uses: 5,
    last_used: '2026-03-10T00:00:00Z',
    tags: ['test'],
    enterprise_skill_id: null,
    uses_at_last_sync: 0,
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-10T00:00:00Z',
    ...overrides
  }
}

function makeServerSkill(overrides: Partial<WorkfloSkill> = {}): WorkfloSkill {
  return {
    id: 'server-1',
    name: 'Test Skill',
    description: 'A test skill',
    content: '# Test',
    tags: ['test'],
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-10T00:00:00Z',
    ...overrides
  }
}

function makeOrgNode(overrides: Partial<WorkfloOrgNode> = {}): WorkfloOrgNode {
  return {
    id: 'node-1',
    tenantId: 'tenant-1',
    name: 'Node 1',
    description: null,
    parentId: null,
    position: 0,
    userIds: ['user-1'],
    skillIds: [],
    agents: [],
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-10T00:00:00Z',
    ...overrides
  }
}

// ── Test Suite ────────────────────────────────────────────────────────────

describe('EnterpriseSyncManager — Skills 2-Way Sync (Batch)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDb: any
  let mockApiClient: Record<string, ReturnType<typeof vi.fn>>
  let syncManager: EnterpriseSyncManager

  beforeEach(() => {
    mockDb = {
      db: {
        pragma: vi.fn().mockReturnValue([{ name: 'enterprise_skill_id' }, { name: 'uses_at_last_sync' }]),
        exec: vi.fn()
      },
      getSkills: vi.fn().mockReturnValue([]),
      getSkill: vi.fn(),
      getSkillByName: vi.fn().mockReturnValue(undefined),
      getSkillByEnterpriseId: vi.fn().mockReturnValue(undefined),
      getDeletedEnterpriseSkills: vi.fn().mockReturnValue([]),
      createSkill: vi.fn().mockImplementation((data) => ({ id: 'new-local-id', ...data })),
      updateSkill: vi.fn().mockImplementation((id, data) => ({ id, ...data })),
      deleteSkill: vi.fn(),
      hardDeleteSkill: vi.fn().mockReturnValue(true),
      getAgents: vi.fn().mockReturnValue([]),
      createAgent: vi.fn(),
      updateAgent: vi.fn(),
      getMcpServers: vi.fn().mockReturnValue([]),
      createMcpServer: vi.fn(),
      updateMcpServer: vi.fn(),
      getTaskSources: vi.fn().mockReturnValue([]),
      createTaskSource: vi.fn()
    }

    mockApiClient = {
      listOrgNodes: vi.fn().mockResolvedValue([makeOrgNode()]),
      getOrgNode: vi.fn().mockResolvedValue({
        node: makeOrgNode(),
        mcpServers: [],
        taskSources: []
      }),
      listSkills: vi.fn().mockResolvedValue([]),
      batchSyncSkills: vi.fn().mockResolvedValue({ created: 0, updated: 0, skills: [] }),
      createSkill: vi.fn().mockResolvedValue(makeServerSkill()),
      updateSkill: vi.fn().mockResolvedValue(makeServerSkill()),
      deleteSkill: vi.fn().mockResolvedValue(undefined),
      updateOrgNode: vi.fn().mockResolvedValue(makeOrgNode()),
      cleanupDuplicateSkills: vi.fn().mockResolvedValue({ deleted: 0, kept: 0 })
    }

    syncManager = new EnterpriseSyncManager(mockDb as never, mockApiClient as never)
  })

  // ── Batch sync skills to server ──────────────────────────────────────

  describe('batchSyncSkills', () => {
    it('sends all local skills in a single batch-sync API call', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 1,
        updated: 0,
        skills: [makeServerSkill({ id: 'server-new', name: 'Test Skill' })]
      })

      const result = await syncManager.syncAll('user-1')

      // Should use batchSyncSkills instead of createSkill/updateSkill
      expect(mockApiClient.batchSyncSkills).toHaveBeenCalledTimes(1)
      expect(mockApiClient.batchSyncSkills).toHaveBeenCalledWith([{
        name: 'Test Skill',
        description: 'A test skill',
        content: '# Test',
        confidence: 0.8,
        uses: 5,
        lastUsed: '2026-03-10T00:00:00Z',
        tags: ['test']
      }])

      // Should NOT use per-skill API calls
      expect(mockApiClient.createSkill).not.toHaveBeenCalled()
      expect(mockApiClient.updateSkill).not.toHaveBeenCalled()

      // Should link local skill to server skill
      expect(mockDb.updateSkill).toHaveBeenCalledWith('local-1', {
        enterprise_skill_id: 'server-new',
        uses_at_last_sync: 5
      })
      expect(result.skills.pushed).toBe(1)
    })

    it('skips [Workflo]-prefixed skills from batch sync', async () => {
      const localSkill = makeLocalSkill({
        name: '[Workflo] My Skill',
        enterprise_skill_id: null
      })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 0,
        skills: []
      })

      await syncManager.syncAll('user-1')

      // batch-sync should be called with empty array (the skill was filtered)
      const batchCall = mockApiClient.batchSyncSkills.mock.calls[0]
      expect(batchCall[0]).toEqual([])
    })

    it('skips built-in Mastermind skill from batch sync', async () => {
      const mastermind = makeLocalSkill({ name: 'Mastermind' })
      mockDb.getSkills.mockReturnValue([mastermind])
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 0,
        skills: []
      })

      const result = await syncManager.syncAll('user-1')

      const batchCall = mockApiClient.batchSyncSkills.mock.calls[0]
      expect(batchCall[0]).toEqual([])
      expect(result.skills.pushed).toBe(0)
    })

    it('handles multiple skills in a single batch call', async () => {
      const skills = [
        makeLocalSkill({ id: 'local-1', name: 'Skill A', enterprise_skill_id: null }),
        makeLocalSkill({ id: 'local-2', name: 'Skill B', enterprise_skill_id: null })
      ]
      mockDb.getSkills.mockReturnValue(skills)
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 2,
        updated: 0,
        skills: [
          makeServerSkill({ id: 'server-a', name: 'Skill A' }),
          makeServerSkill({ id: 'server-b', name: 'Skill B' })
        ]
      })

      const result = await syncManager.syncAll('user-1')

      expect(mockApiClient.batchSyncSkills).toHaveBeenCalledTimes(1)
      const payload = mockApiClient.batchSyncSkills.mock.calls[0][0]
      expect(payload).toHaveLength(2)
      expect(payload[0].name).toBe('Skill A')
      expect(payload[1].name).toBe('Skill B')
      expect(result.skills.pushed).toBe(2)
    })

    it('retries on transient failure with exponential backoff', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.batchSyncSkills
        .mockRejectedValueOnce(new Error('500 Internal Server Error'))
        .mockResolvedValueOnce({
          created: 1,
          updated: 0,
          skills: [makeServerSkill({ id: 'server-1', name: 'Test Skill' })]
        })

      const result = await syncManager.syncAll('user-1')

      expect(mockApiClient.batchSyncSkills).toHaveBeenCalledTimes(2)
      expect(result.skills.pushed).toBe(1)
      expect(result.errors).toHaveLength(0)
    })

    it('does not retry on 400 validation error', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.batchSyncSkills.mockRejectedValue(new Error('400 Bad Request: validation failed'))

      const result = await syncManager.syncAll('user-1')

      expect(mockApiClient.batchSyncSkills).toHaveBeenCalledTimes(1)
      expect(result.errors).toContainEqual(expect.stringContaining('Batch sync chunk'))
    })

    it('records error but does not crash on batch sync failure', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.batchSyncSkills.mockRejectedValue(new Error('Network error'))

      const result = await syncManager.syncAll('user-1')

      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors).toContainEqual(expect.stringContaining('Batch sync chunk'))
    })

    it('uses batch-sync response for pull phase (no extra listSkills call)', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])

      const remoteSkill = makeServerSkill({ id: 'remote-1', name: 'Remote Skill' })
      const pushedSkill = makeServerSkill({ id: 'pushed-1', name: 'Test Skill' })

      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 1,
        updated: 0,
        skills: [pushedSkill, remoteSkill] // Response includes ALL tenant skills
      })

      // After batch sync links the pushed skill, getSkillByEnterpriseId should find it
      mockDb.getSkillByEnterpriseId.mockImplementation((id: string) => {
        if (id === 'pushed-1') return makeLocalSkill({ enterprise_skill_id: 'pushed-1' })
        return undefined
      })
      mockDb.getSkillByName.mockReturnValue(undefined)

      const result = await syncManager.syncAll('user-1')

      // listSkills should NOT be called — batch-sync response is used for pull
      expect(mockApiClient.listSkills).not.toHaveBeenCalled()

      // Remote skill should be pulled locally
      expect(mockDb.createSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '[Workflo] Remote Skill',
          enterprise_skill_id: 'remote-1'
        })
      )
      expect(result.skills.created).toBe(1)
    })
  })

  // ── Assign skills to node ────────────────────────────────────────────

  describe('assignSkillsToNode', () => {
    it('assigns pushed skill IDs to node', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 1,
        updated: 0,
        skills: [makeServerSkill({ id: 'pushed-1', name: 'Test Skill' })]
      })

      await syncManager.syncAll('user-1')

      expect(mockApiClient.updateOrgNode).toHaveBeenCalledWith('node-1', {
        skillIds: ['pushed-1']
      })
    })

    it('deduplicates skill IDs', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: 'already-on-node' })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 1,
        skills: [makeServerSkill({ id: 'already-on-node', name: 'Test Skill' })]
      })

      await syncManager.syncAll('user-1')

      const updateCall = mockApiClient.updateOrgNode.mock.calls[0]
      const skillIds = updateCall[1].skillIds as string[]
      const uniqueIds = new Set(skillIds)
      expect(skillIds.length).toBe(uniqueIds.size)
    })
  })

  // ── Pull server skills ────────────────────────────────────────────────

  describe('pullServerSkills', () => {
    it('creates new local skill from server skill not seen before', async () => {
      const serverSkill = makeServerSkill({ id: 'server-new', name: 'Remote Skill' })
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 0,
        skills: [serverSkill]
      })
      mockDb.getSkillByEnterpriseId.mockReturnValue(undefined)
      mockDb.getSkillByName.mockReturnValue(undefined)

      const result = await syncManager.syncAll('user-1')

      expect(mockDb.createSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '[Workflo] Remote Skill',
          enterprise_skill_id: 'server-new'
        })
      )
      expect(result.skills.created).toBe(1)
    })

    it('updates linked skill when server is newer', async () => {
      const serverSkill = makeServerSkill({
        id: 'server-1',
        content: '# Updated',
        updatedAt: '2026-03-15T00:00:00Z'
      })
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 0,
        skills: [serverSkill]
      })

      const linkedLocal = makeLocalSkill({
        enterprise_skill_id: 'server-1',
        updated_at: '2026-03-10T00:00:00Z'
      })
      mockDb.getSkillByEnterpriseId.mockReturnValue(linkedLocal)

      const result = await syncManager.syncAll('user-1')

      expect(mockDb.updateSkill).toHaveBeenCalledWith(
        'local-1',
        expect.objectContaining({ content: '# Updated' })
      )
      expect(result.skills.updated).toBe(1)
    })

    it('does not update linked skill when local is newer', async () => {
      const serverSkill = makeServerSkill({
        id: 'server-1',
        updatedAt: '2026-03-05T00:00:00Z'
      })
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 0,
        skills: [serverSkill]
      })

      const linkedLocal = makeLocalSkill({
        enterprise_skill_id: 'server-1',
        updated_at: '2026-03-10T00:00:00Z'
      })
      mockDb.getSkillByEnterpriseId.mockReturnValue(linkedLocal)

      const result = await syncManager.syncAll('user-1')

      expect(result.skills.updated).toBe(0)
    })

    it('links existing [Workflo]-prefixed skill by name', async () => {
      const serverSkill = makeServerSkill({ id: 'server-x', name: 'My Skill' })
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 0,
        skills: [serverSkill]
      })
      mockDb.getSkillByEnterpriseId.mockReturnValue(undefined)

      const existingByName = makeLocalSkill({
        id: 'local-by-name',
        name: '[Workflo] My Skill',
        updated_at: '2026-03-05T00:00:00Z'
      })
      mockDb.getSkillByName.mockImplementation((name: string) => {
        if (name === '[Workflo] My Skill') return existingByName
        return undefined
      })

      await syncManager.syncAll('user-1')

      expect(mockDb.updateSkill).toHaveBeenCalledWith('local-by-name', {
        enterprise_skill_id: 'server-x'
      })
    })

    it('links existing skill by exact name (no prefix)', async () => {
      const serverSkill = makeServerSkill({ id: 'server-y', name: 'Exact Name' })
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 0,
        skills: [serverSkill]
      })
      mockDb.getSkillByEnterpriseId.mockReturnValue(undefined)

      const existingByExactName = makeLocalSkill({
        id: 'local-exact',
        name: 'Exact Name',
        updated_at: '2026-03-05T00:00:00Z'
      })
      mockDb.getSkillByName.mockImplementation((name: string) => {
        if (name === 'Exact Name') return existingByExactName
        return undefined
      })

      await syncManager.syncAll('user-1')

      expect(mockDb.updateSkill).toHaveBeenCalledWith('local-exact', {
        enterprise_skill_id: 'server-y'
      })
    })
  })

  // ── Full sync flow ────────────────────────────────────────────────────

  describe('full syncAll flow', () => {
    it('batch syncs, assigns, then pulls in correct order', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 1,
        updated: 0,
        skills: [
          makeServerSkill({ id: 'pushed-id', name: 'Test Skill' }),
          makeServerSkill({ id: 'other-id', name: 'Other Team Skill' })
        ]
      })

      // After batch sync links, the skill has enterprise_skill_id
      mockDb.getSkillByEnterpriseId.mockImplementation((id: string) => {
        if (id === 'pushed-id') return makeLocalSkill({ enterprise_skill_id: 'pushed-id' })
        return undefined
      })

      const result = await syncManager.syncAll('user-1')

      // Batch sync happened (single API call)
      expect(mockApiClient.batchSyncSkills).toHaveBeenCalledTimes(1)
      expect(result.skills.pushed).toBe(1)
      // Node assignment happened
      expect(mockApiClient.updateOrgNode).toHaveBeenCalled()
      // Pull created the new skill from other team
      expect(result.skills.created).toBe(1) // "Other Team Skill"
    })

    it('handles admin mode (no userIds match)', async () => {
      mockApiClient.listOrgNodes.mockResolvedValue([
        makeOrgNode({ id: 'node-a', userIds: [] }),
        makeOrgNode({ id: 'node-b', userIds: [] })
      ])
      mockApiClient.getOrgNode.mockResolvedValue({
        node: makeOrgNode(),
        mcpServers: [],
        taskSources: []
      })
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 0,
        skills: []
      })

      const result = await syncManager.syncAll('user-1')

      // Should sync all nodes
      expect(result.errors.length).toBe(0)
    })

    it('reports errors in result without crashing', async () => {
      mockApiClient.listOrgNodes.mockRejectedValue(new Error('Network down'))
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 0,
        skills: []
      })

      const result = await syncManager.syncAll('user-1')

      expect(result.errors).toContainEqual(expect.stringContaining('Org node sync failed'))
    })

    it('assigns skills to multiple user nodes', async () => {
      const nodeA = makeOrgNode({ id: 'node-a', userIds: ['user-1'] })
      const nodeB = makeOrgNode({ id: 'node-b', userIds: ['user-1'] })
      mockApiClient.listOrgNodes.mockResolvedValue([nodeA, nodeB])
      mockApiClient.getOrgNode.mockResolvedValue({
        node: makeOrgNode(),
        mcpServers: [],
        taskSources: []
      })

      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 1,
        updated: 0,
        skills: [makeServerSkill({ id: 'pushed-1', name: 'Test Skill' })]
      })

      await syncManager.syncAll('user-1')

      // Should call updateOrgNode for each user node
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledTimes(2)
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledWith('node-a', expect.objectContaining({ skillIds: expect.any(Array) }))
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledWith('node-b', expect.objectContaining({ skillIds: expect.any(Array) }))
    })

    it('skips Mastermind from batch sync and node assignment', async () => {
      const mastermind = makeLocalSkill({
        name: 'Mastermind',
        enterprise_skill_id: 'mastermind-server-id'
      })
      mockDb.getSkills.mockReturnValue([mastermind])
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 0,
        skills: []
      })

      await syncManager.syncAll('user-1')

      // Batch sync should have empty payload (Mastermind filtered out)
      const batchPayload = mockApiClient.batchSyncSkills.mock.calls[0][0]
      expect(batchPayload).toEqual([])
      // Should assign empty skillIds
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledWith(
        'node-1',
        { skillIds: [] }
      )
    })

    it('skips [Workflo]-prefixed skills from batch sync and node assignment', async () => {
      const pulledSkill = makeLocalSkill({
        name: '[Workflo] Other Team Skill',
        enterprise_skill_id: 'other-team-id'
      })
      mockDb.getSkills.mockReturnValue([pulledSkill])
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 0,
        skills: []
      })

      await syncManager.syncAll('user-1')

      const batchPayload = mockApiClient.batchSyncSkills.mock.calls[0][0]
      expect(batchPayload).toEqual([])
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledWith(
        'node-1',
        { skillIds: [] }
      )
    })

    it('handles assign skills failure gracefully', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 1,
        updated: 0,
        skills: [makeServerSkill({ id: 'pushed-1', name: 'Test Skill' })]
      })
      mockApiClient.updateOrgNode.mockRejectedValue(new Error('Permission denied'))
      mockApiClient.getOrgNode.mockResolvedValue({
        node: makeOrgNode(),
        mcpServers: [],
        taskSources: []
      })

      const result = await syncManager.syncAll('user-1')

      expect(result.errors).toContainEqual(expect.stringContaining('Assign skills to node'))
      expect(result.skills.pushed).toBe(1)
    })

    it('includes result.skills.pushed in sync output', async () => {
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 0,
        updated: 0,
        skills: []
      })

      const result = await syncManager.syncAll('user-1')

      expect(result.skills).toHaveProperty('pushed')
      expect(result.skills).toHaveProperty('created')
      expect(result.skills).toHaveProperty('updated')
    })

    it('syncs all skills when no org nodes exist (batch sync + pull without node assignment)', async () => {
      mockApiClient.listOrgNodes.mockResolvedValue([])

      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])

      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 1,
        updated: 0,
        skills: [
          makeServerSkill({ id: 'pushed-1', name: 'Test Skill' }),
          makeServerSkill({ id: 'remote-1', name: 'Remote Skill' })
        ]
      })
      mockDb.getSkillByEnterpriseId.mockImplementation((id: string) => {
        if (id === 'pushed-1') return makeLocalSkill({ enterprise_skill_id: 'pushed-1' })
        return undefined
      })
      mockDb.getSkillByName.mockReturnValue(undefined)

      const result = await syncManager.syncAll('user-1')

      // Batch sync works
      expect(mockApiClient.batchSyncSkills).toHaveBeenCalled()
      expect(result.skills.pushed).toBe(1)

      // Node assignment is skipped — no nodes to assign to
      expect(mockApiClient.updateOrgNode).not.toHaveBeenCalled()

      // Remote skill pulled locally
      expect(mockDb.createSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '[Workflo] Remote Skill',
          enterprise_skill_id: 'remote-1'
        })
      )
      expect(result.skills.created).toBe(1)
      expect(result.errors).toHaveLength(0)
    })

    it('still syncs skills when listOrgNodes fails', async () => {
      mockApiClient.listOrgNodes.mockRejectedValue(new Error('Permission denied'))

      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 1,
        updated: 0,
        skills: [makeServerSkill({ id: 'pushed-1', name: 'Test Skill' })]
      })
      mockDb.getSkillByEnterpriseId.mockImplementation((id: string) => {
        if (id === 'pushed-1') return makeLocalSkill({ enterprise_skill_id: 'pushed-1' })
        return undefined
      })

      const result = await syncManager.syncAll('user-1')

      expect(result.errors).toContainEqual(expect.stringContaining('Org node sync failed'))
      expect(mockApiClient.batchSyncSkills).toHaveBeenCalled()
      expect(result.skills.pushed).toBe(1)
      expect(mockApiClient.updateOrgNode).not.toHaveBeenCalled()
    })

    it('handles multiple skills with mixed states', async () => {
      const skills = [
        makeLocalSkill({ id: 'local-1', name: 'New Skill', enterprise_skill_id: null }),
        makeLocalSkill({ id: 'local-2', name: '[Workflo] Pulled Skill', enterprise_skill_id: 'server-pulled' }),
        makeLocalSkill({ id: 'local-3', name: 'Mastermind' }),
        makeLocalSkill({ id: 'local-4', name: 'Existing Skill', enterprise_skill_id: 'server-existing' })
      ]
      mockDb.getSkills.mockReturnValue(skills)
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 1,
        updated: 1,
        skills: [
          makeServerSkill({ id: 'server-new', name: 'New Skill' }),
          makeServerSkill({ id: 'server-existing', name: 'Existing Skill' })
        ]
      })

      const result = await syncManager.syncAll('user-1')

      // Batch sync should only include non-skipped skills
      const batchPayload = mockApiClient.batchSyncSkills.mock.calls[0][0]
      expect(batchPayload).toHaveLength(2) // New Skill + Existing Skill
      expect(batchPayload.map((p: { name: string }) => p.name)).toEqual(['New Skill', 'Existing Skill'])

      // Should NOT include [Workflo] or Mastermind
      expect(batchPayload.map((p: { name: string }) => p.name)).not.toContain('[Workflo] Pulled Skill')
      expect(batchPayload.map((p: { name: string }) => p.name)).not.toContain('Mastermind')

      expect(result.skills.pushed).toBe(2)

      // Node should only have local skills, not pulled [Workflo] ones
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledWith('node-1', {
        skillIds: expect.arrayContaining(['server-new', 'server-existing'])
      })
      const assignedIds = mockApiClient.updateOrgNode.mock.calls[0][1].skillIds
      expect(assignedIds).not.toContain('server-pulled')
    })

    it('makes only 1 API call for skills instead of N per-skill calls', async () => {
      // 5 local skills that would have been 5+ API calls before
      const skills = Array.from({ length: 5 }, (_, i) =>
        makeLocalSkill({
          id: `local-${i}`,
          name: `Skill ${i}`,
          enterprise_skill_id: null
        })
      )
      mockDb.getSkills.mockReturnValue(skills)

      const serverSkills = skills.map((_, i) =>
        makeServerSkill({ id: `server-${i}`, name: `Skill ${i}` })
      )
      mockApiClient.batchSyncSkills.mockResolvedValue({
        created: 5,
        updated: 0,
        skills: serverSkills
      })

      await syncManager.syncAll('user-1')

      // Only 1 batch-sync call instead of 5 create calls
      expect(mockApiClient.batchSyncSkills).toHaveBeenCalledTimes(1)
      expect(mockApiClient.createSkill).not.toHaveBeenCalled()
      expect(mockApiClient.updateSkill).not.toHaveBeenCalled()

      // No separate listSkills call for pull phase
      expect(mockApiClient.listSkills).not.toHaveBeenCalled()
    })
  })
})
