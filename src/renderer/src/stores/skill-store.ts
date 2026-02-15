import { create } from 'zustand'
import type { Skill, CreateSkillDTO, UpdateSkillDTO } from '@/types'
import { skillApi } from '@/lib/ipc-client'

interface SkillState {
  skills: Skill[]
  selectedSkillId: string | null
  isLoading: boolean
  error: string | null

  fetchSkills: () => Promise<void>
  createSkill: (data: CreateSkillDTO) => Promise<Skill | null>
  updateSkill: (id: string, data: UpdateSkillDTO) => Promise<Skill | null>
  deleteSkill: (id: string) => Promise<boolean>
  selectSkill: (id: string | null) => void
}

export const useSkillStore = create<SkillState>((set) => ({
  skills: [],
  selectedSkillId: null,
  isLoading: false,
  error: null,

  fetchSkills: async () => {
    set({ isLoading: true, error: null })
    try {
      const skills = await skillApi.getAll()
      // Sort by confidence (high to low)
      const sortedSkills = skills.sort((a, b) => b.confidence - a.confidence)
      set({ skills: sortedSkills, isLoading: false })
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  createSkill: async (data) => {
    try {
      const skill = await skillApi.create(data)
      // Sort by confidence (high to low)
      set((state) => ({ skills: [...state.skills, skill].sort((a, b) => b.confidence - a.confidence) }))
      return skill
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  updateSkill: async (id, data) => {
    try {
      const updated = await skillApi.update(id, data)
      if (updated) {
        set((state) => ({
          // Sort by confidence (high to low) after update
          skills: state.skills.map((s) => (s.id === id ? updated : s)).sort((a, b) => b.confidence - a.confidence)
        }))
      }
      return updated || null
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  deleteSkill: async (id) => {
    try {
      const success = await skillApi.delete(id)
      if (success) {
        set((state) => ({
          skills: state.skills.filter((s) => s.id !== id),
          selectedSkillId: state.selectedSkillId === id ? null : state.selectedSkillId
        }))
      }
      return success
    } catch (err) {
      set({ error: String(err) })
      return false
    }
  },

  selectSkill: (id) => set({ selectedSkillId: id })
}))
