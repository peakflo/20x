import { create } from 'zustand'
import { presetupApi } from '@/lib/presetup-api'
import type {
  PresetupTemplate,
  PresetupStatusResponse,
  ProvisionResult
} from '@/lib/presetup-api'

export type PresetupPhase =
  | 'idle'
  | 'loading'
  | 'template-selection'
  | 'wizard'
  | 'provisioning'
  | 'complete'
  | 'error'

interface PresetupState {
  // Data
  templates: PresetupTemplate[]
  status: PresetupStatusResponse | null
  selectedTemplate: PresetupTemplate | null
  provisionResult: ProvisionResult | null

  // Wizard state
  answers: Record<string, string>

  // Lifecycle
  phase: PresetupPhase
  error: string | null

  // Actions
  checkAndStart: () => Promise<void>
  selectTemplate: (template: PresetupTemplate) => void
  setAnswer: (questionId: string, value: string) => void
  submitProvision: () => Promise<void>
  reset: () => void
  dismiss: () => void
}

export const usePresetupStore = create<PresetupState>((set, get) => ({
  templates: [],
  status: null,
  selectedTemplate: null,
  provisionResult: null,
  answers: {},
  phase: 'idle',
  error: null,

  checkAndStart: async () => {
    set({ phase: 'loading', error: null })
    try {
      const [status, templates] = await Promise.all([
        presetupApi.getStatus(),
        presetupApi.listTemplates()
      ])

      // Filter to only unprovisioned templates
      const provisionedSlugs = new Set(
        status.templates.filter((t) => t.isProvisioned).map((t) => t.slug)
      )
      const unprovisionedTemplates = templates.filter((t) => !provisionedSlugs.has(t.slug))

      if (unprovisionedTemplates.length === 0) {
        // All templates already provisioned — nothing to show
        set({ phase: 'idle', status, templates: [] })
        return
      }

      set({
        phase: 'template-selection',
        status,
        templates: unprovisionedTemplates
      })
    } catch (err) {
      set({
        phase: 'error',
        error: err instanceof Error ? err.message : 'Failed to load presetup templates'
      })
    }
  },

  selectTemplate: (template) => {
    const hasQuestions = template.definition.questions.length > 0
    set({
      selectedTemplate: template,
      answers: {},
      phase: hasQuestions ? 'wizard' : 'provisioning'
    })
    // If no questions, immediately start provisioning
    if (!hasQuestions) {
      get().submitProvision()
    }
  },

  setAnswer: (questionId, value) => {
    set((s) => ({
      answers: { ...s.answers, [questionId]: value }
    }))
  },

  submitProvision: async () => {
    const { selectedTemplate, answers } = get()
    if (!selectedTemplate) return

    set({ phase: 'provisioning', error: null, provisionResult: null })
    try {
      const result = await presetupApi.provision(selectedTemplate.slug, answers)

      if (result.status === 'completed' || result.status === 'partial' || result.status === 'already_provisioned') {
        set({ phase: 'complete', provisionResult: result })
      } else {
        // status === 'failed' — extract error messages from failed steps
        const failedSteps = (result.steps || []).filter((s) => s.status === 'failed')
        const errorMsg = failedSteps.map((s) => s.message || `${s.type} ${s.identifier} failed`).join(', ')
        set({
          phase: 'error',
          error: errorMsg || 'Provisioning failed',
          provisionResult: result
        })
      }
    } catch (err) {
      set({
        phase: 'error',
        error: err instanceof Error ? err.message : 'Provisioning request failed'
      })
    }
  },

  reset: () => {
    set({
      templates: [],
      status: null,
      selectedTemplate: null,
      provisionResult: null,
      answers: {},
      phase: 'idle',
      error: null
    })
  },

  dismiss: () => {
    set({ phase: 'idle' })
  }
}))
