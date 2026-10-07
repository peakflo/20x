import { create } from 'zustand'
import type { WorkfloProject, CreateProjectDTO, UpdateProjectDTO } from '@/types'
import { projectApi } from '@/lib/ipc-client'

interface ProjectState {
  projects: WorkfloProject[]
  /** Top-level task count per project id, refreshed alongside the project list. */
  taskCounts: Record<string, number>
  isLoading: boolean
  error: string | null

  fetchProjects: () => Promise<void>
  createProject: (data: CreateProjectDTO) => Promise<WorkfloProject | null>
  updateProject: (id: string, data: UpdateProjectDTO) => Promise<WorkfloProject | null>
  deleteProject: (id: string) => Promise<boolean>
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  taskCounts: {},
  isLoading: false,
  error: null,

  fetchProjects: async () => {
    set({ isLoading: true, error: null })
    try {
      const [projects, taskCounts] = await Promise.all([
        projectApi.getAll(),
        projectApi.getTaskCounts()
      ])
      set({ projects, taskCounts, isLoading: false })
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  createProject: async (data) => {
    try {
      const project = await projectApi.create(data)
      set((state) => ({ projects: [...state.projects, project] }))
      return project
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  updateProject: async (id, data) => {
    try {
      const updated = await projectApi.update(id, data)
      if (updated) {
        set((state) => ({
          projects: state.projects.map((p) => (p.id === id ? updated : p))
        }))
      }
      return updated || null
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  deleteProject: async (id) => {
    try {
      const success = await projectApi.delete(id)
      if (success) {
        set((state) => {
          const taskCounts = { ...state.taskCounts }
          delete taskCounts[id]
          return {
            projects: state.projects.filter((p) => p.id !== id),
            taskCounts
          }
        })
      }
      return success
    } catch (err) {
      set({ error: String(err) })
      return false
    }
  }
}))
