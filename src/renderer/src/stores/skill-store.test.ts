import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { useSkillStore } from './skill-store'
import type { Skill } from '@/types'

const mockElectronAPI = window.electronAPI

beforeEach(() => {
  useSkillStore.setState({
    skills: [],
    selectedSkillId: null,
    isLoading: false,
    error: null
  })
  vi.clearAllMocks()
})

describe('useSkillStore', () => {
  describe('fetchSkills', () => {
    it('fetches and sorts skills by confidence (high to low)', async () => {
      const skills = [
        { id: 's1', name: 'Low', confidence: 0.3 },
        { id: 's2', name: 'High', confidence: 0.9 },
        { id: 's3', name: 'Medium', confidence: 0.6 }
      ]
      ;(mockElectronAPI.skills.getAll as unknown as Mock).mockResolvedValue(skills)

      await useSkillStore.getState().fetchSkills()

      const sortedSkills = useSkillStore.getState().skills
      expect(sortedSkills[0].name).toBe('High')   // 0.9
      expect(sortedSkills[1].name).toBe('Medium') // 0.6
      expect(sortedSkills[2].name).toBe('Low')    // 0.3
      expect(useSkillStore.getState().isLoading).toBe(false)
    })

    it('sets error on failure', async () => {
      ;(mockElectronAPI.skills.getAll as unknown as Mock).mockRejectedValue(new Error('fail'))

      await useSkillStore.getState().fetchSkills()

      expect(useSkillStore.getState().error).toBeTruthy()
    })
  })

  describe('createSkill', () => {
    it('creates skill and sorts by confidence (high to low)', async () => {
      useSkillStore.setState({
        skills: [{ id: 's1', name: 'Zeta', confidence: 0.5 }] as unknown as Skill[]
      })
      const newSkill = { id: 's2', name: 'Alpha', confidence: 0.8 }
      ;(mockElectronAPI.skills.create as unknown as Mock).mockResolvedValue(newSkill)

      const result = await useSkillStore.getState().createSkill({ name: 'Alpha', description: '', content: '' })

      expect(result).toEqual(newSkill)
      const skills = useSkillStore.getState().skills
      expect(skills[0].name).toBe('Alpha') // Higher confidence (0.8) comes first
      expect(skills[1].name).toBe('Zeta')  // Lower confidence (0.5) comes second
    })

    it('creates skill with tags and metadata', async () => {
      const newSkill = {
        id: 's1',
        name: 'test-skill',
        confidence: 0.7,
        uses: 0,
        tags: ['api', 'testing']
      }
      ;(mockElectronAPI.skills.create as unknown as Mock).mockResolvedValue(newSkill)

      const result = await useSkillStore.getState().createSkill({
        name: 'test-skill',
        description: 'Test description',
        content: 'Test content',
        tags: ['api', 'testing']
      })

      expect(result).toEqual(newSkill)
      expect(result?.tags).toEqual(['api', 'testing'])
    })

    it('handles skill creation with edge case confidence values', async () => {
      const skills = [
        { id: 's1', name: 'Zero', confidence: 0.0 },
        { id: 's2', name: 'One', confidence: 1.0 },
        { id: 's3', name: 'Half', confidence: 0.5 }
      ]

      for (const skill of skills) {
        ;(mockElectronAPI.skills.create as unknown as Mock).mockResolvedValue(skill)
        await useSkillStore.getState().createSkill({ name: skill.name, description: '', content: '' })
      }

      const sorted = useSkillStore.getState().skills
      expect(sorted[0].confidence).toBe(1.0) // Highest first
      expect(sorted[1].confidence).toBe(0.5)
      expect(sorted[2].confidence).toBe(0.0) // Lowest last
    })
  })

  describe('updateSkill', () => {
    it('updates skill and re-sorts by confidence', async () => {
      useSkillStore.setState({
        skills: [
          { id: 's1', name: 'First', confidence: 0.8 },
          { id: 's2', name: 'Second', confidence: 0.5 }
        ] as unknown as Skill[]
      })
      const updated = { id: 's2', name: 'Second', confidence: 0.9 }
      ;(mockElectronAPI.skills.update as unknown as Mock).mockResolvedValue(updated)

      await useSkillStore.getState().updateSkill('s2', { confidence: 0.9 })

      const skills = useSkillStore.getState().skills
      expect(skills[0].name).toBe('Second') // Now highest confidence (0.9)
      expect(skills[1].name).toBe('First')  // Lower confidence (0.8)
    })

    it('updates skill tags', async () => {
      useSkillStore.setState({
        skills: [{ id: 's1', name: 'Test', tags: ['old'], confidence: 0.5 }] as unknown as Skill[]
      })
      const updated = { id: 's1', name: 'Test', tags: ['new', 'updated'], confidence: 0.5 }
      ;(mockElectronAPI.skills.update as unknown as Mock).mockResolvedValue(updated)

      await useSkillStore.getState().updateSkill('s1', { tags: ['new', 'updated'] })

      expect(useSkillStore.getState().skills[0].tags).toEqual(['new', 'updated'])
    })

    it('updates multiple fields at once', async () => {
      useSkillStore.setState({
        skills: [{ id: 's1', name: 'Old', description: 'Old desc', confidence: 0.5, tags: [] }] as unknown as Skill[]
      })
      const updated = {
        id: 's1',
        name: 'New',
        description: 'New desc',
        confidence: 0.8,
        tags: ['updated']
      }
      ;(mockElectronAPI.skills.update as unknown as Mock).mockResolvedValue(updated)

      await useSkillStore.getState().updateSkill('s1', {
        name: 'New',
        description: 'New desc',
        confidence: 0.8,
        tags: ['updated']
      })

      const skill = useSkillStore.getState().skills[0]
      expect(skill.name).toBe('New')
      expect(skill.description).toBe('New desc')
      expect(skill.confidence).toBe(0.8)
      expect(skill.tags).toEqual(['updated'])
    })

    it('handles update errors', async () => {
      useSkillStore.setState({
        skills: [{ id: 's1', name: 'Test', confidence: 0.5 }] as unknown as Skill[]
      })
      ;(mockElectronAPI.skills.update as unknown as Mock).mockRejectedValue(new Error('Update failed'))

      const result = await useSkillStore.getState().updateSkill('s1', { name: 'New' })

      expect(result).toBeNull()
      expect(useSkillStore.getState().error).toBeTruthy()
    })
  })

  describe('deleteSkill', () => {
    it('removes skill from list', async () => {
      useSkillStore.setState({
        skills: [{ id: 's1' }, { id: 's2' }] as unknown as Skill[],
        selectedSkillId: null
      })
      ;(mockElectronAPI.skills.delete as unknown as Mock).mockResolvedValue(true)

      const result = await useSkillStore.getState().deleteSkill('s1')

      expect(result).toBe(true)
      expect(useSkillStore.getState().skills).toHaveLength(1)
      expect(useSkillStore.getState().skills[0].id).toBe('s2')
    })

    it('clears selection if deleted skill was selected', async () => {
      useSkillStore.setState({
        skills: [{ id: 's1' }] as unknown as Skill[],
        selectedSkillId: 's1'
      })
      ;(mockElectronAPI.skills.delete as unknown as Mock).mockResolvedValue(true)

      await useSkillStore.getState().deleteSkill('s1')

      expect(useSkillStore.getState().selectedSkillId).toBeNull()
    })

    it('preserves selection if different skill was deleted', async () => {
      useSkillStore.setState({
        skills: [{ id: 's1' }, { id: 's2' }] as unknown as Skill[],
        selectedSkillId: 's2'
      })
      ;(mockElectronAPI.skills.delete as unknown as Mock).mockResolvedValue(true)

      await useSkillStore.getState().deleteSkill('s1')

      expect(useSkillStore.getState().selectedSkillId).toBe('s2')
    })

    it('handles delete errors', async () => {
      useSkillStore.setState({
        skills: [{ id: 's1' }] as unknown as Skill[]
      })
      ;(mockElectronAPI.skills.delete as unknown as Mock).mockRejectedValue(new Error('Delete failed'))

      const result = await useSkillStore.getState().deleteSkill('s1')

      expect(result).toBe(false)
      expect(useSkillStore.getState().error).toBeTruthy()
      expect(useSkillStore.getState().skills).toHaveLength(1) // Skill not removed on error
    })
  })

  describe('selectSkill', () => {
    it('sets selectedSkillId', () => {
      useSkillStore.getState().selectSkill('s1')
      expect(useSkillStore.getState().selectedSkillId).toBe('s1')
    })

    it('clears with null', () => {
      useSkillStore.getState().selectSkill('s1')
      useSkillStore.getState().selectSkill(null)
      expect(useSkillStore.getState().selectedSkillId).toBeNull()
    })
  })
})
