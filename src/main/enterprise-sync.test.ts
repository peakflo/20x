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

describe('EnterpriseSyncManager — Skills 2-Way Sync', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDb: any
  let mockApiClient: Record<string, ReturnType<typeof vi.fn>>
  let syncManager: EnterpriseSyncManager

  beforeEach(() => {
    mockDb = {
      db: {
        pragma: vi.fn().mockReturnValue([{ name: 'enterprise_skill_id' }]),
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
      createSkill: vi.fn().mockResolvedValue(makeServerSkill()),
      updateSkill: vi.fn().mockResolvedValue(makeServerSkill()),
      deleteSkill: vi.fn().mockResolvedValue(undefined),
      updateOrgNode: vi.fn().mockResolvedValue(makeOrgNode()),
      cleanupDuplicateSkills: vi.fn().mockResolvedValue({ deleted: 0, kept: 0 })
    }

    syncManager = new EnterpriseSyncManager(mockDb as never, mockApiClient as never)
  })

  // ── Push local skills to server ──────────────────────────────────────

  describe('pushLocalSkills', () => {
    it('creates new skill on server for local skill without enterprise_skill_id', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.createSkill.mockResolvedValue(makeServerSkill({ id: 'server-new' }))

      const result = await syncManager.syncAll('user-1')

      expect(mockApiClient.createSkill).toHaveBeenCalledWith({
        name: 'Test Skill',
        description: 'A test skill',
        content: '# Test',
        confidence: 0.8,
        tags: ['test'],
        uses: 5,
        lastUsed: '2026-03-10T00:00:00Z'
      })

      // Should store the server ID and sync baseline locally
      expect(mockDb.updateSkill).toHaveBeenCalledWith('local-1', {
        enterprise_skill_id: 'server-new',
        uses_at_last_sync: 5
      })
      expect(result.skills.pushed).toBe(1)
    })

    it('updates existing skill on server for local skill with enterprise_skill_id', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: 'server-existing', uses: 5, uses_at_last_sync: 0 })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.updateSkill.mockResolvedValue(makeServerSkill({ id: 'server-existing' }))

      const result = await syncManager.syncAll('user-1')

      expect(mockApiClient.updateSkill).toHaveBeenCalledWith('server-existing', {
        name: 'Test Skill',
        description: 'A test skill',
        content: '# Test',
        confidence: 0.8,
        tags: ['test'],
        usesDelta: 5,
        lastUsed: '2026-03-10T00:00:00Z'
      })
      expect(result.skills.pushed).toBe(1)
    })

    it('skips [Workflo]-prefixed skills entirely (pulled from server)', async () => {
      const localSkill = makeLocalSkill({
        name: '[Workflo] My Skill',
        enterprise_skill_id: null
      })
      mockDb.getSkills.mockReturnValue([localSkill])

      await syncManager.syncAll('user-1')

      // [Workflo] skills are pulled copies — should not be pushed back
      expect(mockApiClient.createSkill).not.toHaveBeenCalled()
      expect(mockApiClient.updateSkill).not.toHaveBeenCalled()
    })

    it('skips built-in Mastermind skill', async () => {
      const mastermind = makeLocalSkill({ name: 'Mastermind' })
      mockDb.getSkills.mockReturnValue([mastermind])

      const result = await syncManager.syncAll('user-1')

      expect(mockApiClient.createSkill).not.toHaveBeenCalled()
      expect(mockApiClient.updateSkill).not.toHaveBeenCalled()
      expect(result.skills.pushed).toBe(0)
    })

    it('re-creates skill on server when update returns 404', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: 'deleted-server-id' })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.updateSkill.mockRejectedValue(new Error('404 Not Found'))
      mockApiClient.createSkill.mockResolvedValue(makeServerSkill({ id: 'new-server-id' }))

      const result = await syncManager.syncAll('user-1')

      expect(mockApiClient.createSkill).toHaveBeenCalled()
      expect(mockDb.updateSkill).toHaveBeenCalledWith('local-1', {
        enterprise_skill_id: 'new-server-id',
        uses_at_last_sync: 5
      })
      expect(result.skills.pushed).toBe(1)
    })

    it('records error but continues on push failure', async () => {
      const skill1 = makeLocalSkill({ id: 'local-1', name: 'Skill 1' })
      const skill2 = makeLocalSkill({ id: 'local-2', name: 'Skill 2' })
      mockDb.getSkills.mockReturnValue([skill1, skill2])
      mockApiClient.createSkill
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(makeServerSkill({ id: 'server-2' }))

      const result = await syncManager.syncAll('user-1')

      expect(result.errors).toContainEqual(expect.stringContaining('Push skill Skill 1'))
      expect(result.skills.pushed).toBe(1) // Second skill succeeded
    })
  })

  // ── Assign skills to node ────────────────────────────────────────────

  describe('assignSkillsToNode', () => {
    it('assigns only pushed skill IDs to node (no merge with existing)', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.createSkill.mockResolvedValue(makeServerSkill({ id: 'pushed-1' }))

      await syncManager.syncAll('user-1')

      // Should only contain the pushed ID, not any pre-existing node IDs
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledWith('node-1', {
        skillIds: ['pushed-1']
      })
    })

    it('deduplicates skill IDs', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: 'already-on-node' })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.updateSkill.mockResolvedValue(makeServerSkill({ id: 'already-on-node' }))

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
      mockApiClient.listSkills.mockResolvedValue([serverSkill])
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
      mockApiClient.listSkills.mockResolvedValue([serverSkill])

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
      mockApiClient.listSkills.mockResolvedValue([serverSkill])

      const linkedLocal = makeLocalSkill({
        enterprise_skill_id: 'server-1',
        updated_at: '2026-03-10T00:00:00Z'
      })
      mockDb.getSkillByEnterpriseId.mockReturnValue(linkedLocal)

      const result = await syncManager.syncAll('user-1')

      // updateSkill should NOT be called with content update (only from push)
      expect(result.skills.updated).toBe(0)
    })

    it('links existing [Workflo]-prefixed skill by name', async () => {
      const serverSkill = makeServerSkill({ id: 'server-x', name: 'My Skill' })
      mockApiClient.listSkills.mockResolvedValue([serverSkill])
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

      // Should link the enterprise ID
      expect(mockDb.updateSkill).toHaveBeenCalledWith('local-by-name', {
        enterprise_skill_id: 'server-x'
      })
    })

    it('links existing skill by exact name (no prefix)', async () => {
      const serverSkill = makeServerSkill({ id: 'server-y', name: 'Exact Name' })
      mockApiClient.listSkills.mockResolvedValue([serverSkill])
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

      // Should link the enterprise ID
      expect(mockDb.updateSkill).toHaveBeenCalledWith('local-exact', {
        enterprise_skill_id: 'server-y'
      })
    })
  })

  // ── Full sync flow ────────────────────────────────────────────────────

  describe('full syncAll flow', () => {
    it('pushes, assigns, then pulls in correct order', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.createSkill.mockResolvedValue(makeServerSkill({ id: 'pushed-id' }))
      mockApiClient.listSkills.mockResolvedValue([
        makeServerSkill({ id: 'pushed-id', name: 'Test Skill' }),
        makeServerSkill({ id: 'other-id', name: 'Other Team Skill' })
      ])

      // After push, the skill has enterprise_skill_id
      mockDb.getSkillByEnterpriseId.mockImplementation((id: string) => {
        if (id === 'pushed-id') return makeLocalSkill({ enterprise_skill_id: 'pushed-id' })
        return undefined
      })

      const result = await syncManager.syncAll('user-1')

      // Push happened
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

      const result = await syncManager.syncAll('user-1')

      // Should sync all nodes
      expect(result.errors.length).toBe(0)
    })

    it('reports errors in result without crashing', async () => {
      mockApiClient.listOrgNodes.mockRejectedValue(new Error('Network down'))

      const result = await syncManager.syncAll('user-1')

      expect(result.errors).toContainEqual(expect.stringContaining('Sync failed'))
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
      mockApiClient.createSkill.mockResolvedValue(makeServerSkill({ id: 'pushed-1' }))

      await syncManager.syncAll('user-1')

      // Should call updateOrgNode for each user node
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledTimes(2)
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledWith('node-a', expect.objectContaining({ skillIds: expect.any(Array) }))
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledWith('node-b', expect.objectContaining({ skillIds: expect.any(Array) }))
    })

    it('skips Mastermind from push and node assignment', async () => {
      const mastermind = makeLocalSkill({
        name: 'Mastermind',
        enterprise_skill_id: 'mastermind-server-id'
      })
      mockDb.getSkills.mockReturnValue([mastermind])

      await syncManager.syncAll('user-1')

      // Should not push
      expect(mockApiClient.createSkill).not.toHaveBeenCalled()
      // Should assign empty skillIds (Mastermind is skipped)
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledWith(
        'node-1',
        { skillIds: [] }
      )
    })

    it('skips [Workflo]-prefixed skills from push and node assignment', async () => {
      const pulledSkill = makeLocalSkill({
        name: '[Workflo] Other Team Skill',
        enterprise_skill_id: 'other-team-id'
      })
      mockDb.getSkills.mockReturnValue([pulledSkill])

      await syncManager.syncAll('user-1')

      // Should not push pulled skills back
      expect(mockApiClient.createSkill).not.toHaveBeenCalled()
      expect(mockApiClient.updateSkill).not.toHaveBeenCalled()
      // Should not assign pulled skills to this node
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledWith(
        'node-1',
        { skillIds: [] }
      )
    })

    it('handles assign skills failure gracefully', async () => {
      const localSkill = makeLocalSkill({ enterprise_skill_id: null })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.createSkill.mockResolvedValue(makeServerSkill({ id: 'pushed-1' }))
      mockApiClient.updateOrgNode.mockRejectedValue(new Error('Permission denied'))
      // getOrgNode is called both in syncNode and assignSkillsToNode
      mockApiClient.getOrgNode.mockResolvedValue({
        node: makeOrgNode(),
        mcpServers: [],
        taskSources: []
      })

      const result = await syncManager.syncAll('user-1')

      // Should report assignment error but still succeed on push and pull
      expect(result.errors).toContainEqual(expect.stringContaining('Assign skills to node'))
      expect(result.skills.pushed).toBe(1)
    })

    it('includes result.skills.pushed in sync output', async () => {
      const result = await syncManager.syncAll('user-1')

      // Verify the pushed counter exists in the result shape
      expect(result.skills).toHaveProperty('pushed')
      expect(result.skills).toHaveProperty('created')
      expect(result.skills).toHaveProperty('updated')
    })

    it('sends usesDelta (not absolute uses) when pushing to server', async () => {
      // Skill used 10 times total, 3 since last sync
      const localSkill = makeLocalSkill({
        enterprise_skill_id: 'server-1',
        uses: 10,
        uses_at_last_sync: 7
      })
      mockDb.getSkills.mockReturnValue([localSkill])
      mockApiClient.updateSkill.mockResolvedValue(makeServerSkill({ id: 'server-1' }))

      await syncManager.syncAll('user-1')

      expect(mockApiClient.updateSkill).toHaveBeenCalledWith('server-1',
        expect.objectContaining({ usesDelta: 3 })
      )
      // Should NOT send absolute uses
      const callArgs = mockApiClient.updateSkill.mock.calls[0][1]
      expect(callArgs).not.toHaveProperty('uses')

      // Should update uses_at_last_sync locally after push
      expect(mockDb.updateSkill).toHaveBeenCalledWith('local-1', { uses_at_last_sync: 10 })
    })

    it('skips usage push when no delta (uses_at_last_sync matches uses)', async () => {
      const localSkill = makeLocalSkill({
        enterprise_skill_id: 'server-1',
        uses: 5,
        uses_at_last_sync: 5
      })
      // Server has same content — no content change AND no usage delta
      mockApiClient.listSkills.mockResolvedValue([
        makeServerSkill({
          id: 'server-1',
          name: 'Test Skill',
          description: 'A test skill',
          content: '# Test',
          confidence: 0.8,
          tags: ['test']
        })
      ])
      mockDb.getSkills.mockReturnValue([localSkill])

      await syncManager.syncAll('user-1')

      // Should not call updateSkill at all — nothing changed
      expect(mockApiClient.updateSkill).not.toHaveBeenCalled()
    })

    it('handles multiple skills with mixed states', async () => {
      const skills = [
        makeLocalSkill({ id: 'local-1', name: 'New Skill', enterprise_skill_id: null }),
        makeLocalSkill({ id: 'local-2', name: '[Workflo] Pulled Skill', enterprise_skill_id: 'server-pulled' }),
        makeLocalSkill({ id: 'local-3', name: 'Mastermind' }),
        makeLocalSkill({ id: 'local-4', name: 'Existing Skill', enterprise_skill_id: 'server-existing' })
      ]
      mockDb.getSkills.mockReturnValue(skills)
      mockApiClient.createSkill.mockResolvedValue(makeServerSkill({ id: 'server-new' }))
      mockApiClient.updateSkill.mockResolvedValue(makeServerSkill({ id: 'server-existing' }))

      const result = await syncManager.syncAll('user-1')

      // New Skill → created, Existing Skill → updated, [Workflo] Pulled → skipped, Mastermind → skipped
      expect(mockApiClient.createSkill).toHaveBeenCalledTimes(1)
      expect(mockApiClient.updateSkill).toHaveBeenCalledTimes(1)
      expect(result.skills.pushed).toBe(2)

      // Node should only have local skills, not pulled [Workflo] ones
      expect(mockApiClient.updateOrgNode).toHaveBeenCalledWith('node-1', {
        skillIds: expect.arrayContaining(['server-new', 'server-existing'])
      })
      const assignedIds = mockApiClient.updateOrgNode.mock.calls[0][1].skillIds
      expect(assignedIds).not.toContain('server-pulled')
    })
  })
})
