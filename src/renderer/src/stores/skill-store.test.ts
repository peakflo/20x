import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSkillStore } from './skill-store'

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
    it('fetches and sets skills', async () => {
      const skills = [{ id: 's1', name: 'Deploy' }]
      ;(mockElectronAPI.skills.getAll as any).mockResolvedValue(skills)

      await useSkillStore.getState().fetchSkills()

      expect(useSkillStore.getState().skills).toEqual(skills)
      expect(useSkillStore.getState().isLoading).toBe(false)
    })

    it('sets error on failure', async () => {
      ;(mockElectronAPI.skills.getAll as any).mockRejectedValue(new Error('fail'))

      await useSkillStore.getState().fetchSkills()

      expect(useSkillStore.getState().error).toBeTruthy()
    })
  })

  describe('createSkill', () => {
    it('creates skill and sorts by name', async () => {
      useSkillStore.setState({
        skills: [{ id: 's1', name: 'Zeta' }] as any
      })
      const newSkill = { id: 's2', name: 'Alpha' }
      ;(mockElectronAPI.skills.create as any).mockResolvedValue(newSkill)

      const result = await useSkillStore.getState().createSkill({ name: 'Alpha', description: '', content: '' })

      expect(result).toEqual(newSkill)
      const skills = useSkillStore.getState().skills
      expect(skills[0].name).toBe('Alpha')
      expect(skills[1].name).toBe('Zeta')
    })
  })

  describe('updateSkill', () => {
    it('updates skill in list', async () => {
      useSkillStore.setState({ skills: [{ id: 's1', name: 'Old' }] as any })
      const updated = { id: 's1', name: 'Updated' }
      ;(mockElectronAPI.skills.update as any).mockResolvedValue(updated)

      await useSkillStore.getState().updateSkill('s1', { name: 'Updated' })

      expect(useSkillStore.getState().skills[0].name).toBe('Updated')
    })
  })

  describe('deleteSkill', () => {
    it('removes skill from list', async () => {
      useSkillStore.setState({
        skills: [{ id: 's1' }, { id: 's2' }] as any,
        selectedSkillId: null
      })
      ;(mockElectronAPI.skills.delete as any).mockResolvedValue(true)

      const result = await useSkillStore.getState().deleteSkill('s1')

      expect(result).toBe(true)
      expect(useSkillStore.getState().skills).toHaveLength(1)
    })

    it('clears selection if deleted skill was selected', async () => {
      useSkillStore.setState({
        skills: [{ id: 's1' }] as any,
        selectedSkillId: 's1'
      })
      ;(mockElectronAPI.skills.delete as any).mockResolvedValue(true)

      await useSkillStore.getState().deleteSkill('s1')

      expect(useSkillStore.getState().selectedSkillId).toBeNull()
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
