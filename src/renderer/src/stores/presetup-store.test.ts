import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { usePresetupStore } from './presetup-store'

const mockElectronAPI = window.electronAPI

const mockTemplate = {
  id: '1',
  slug: 'ai-accountant',
  name: 'AI Accountant',
  description: 'Accounting automation',
  version: '1.0.0',
  category: 'finance',
  tags: ['accounting', 'automation'],
  icon: 'Calculator',
  definition: {
    workflows: [{ slug: 'invoice-processing', name: 'Invoice Processing' }],
    integrations: [{ key: 'xero', name: 'Xero', required: true }],
    skills: [{ name: 'data-extraction', description: 'Extract data from invoices' }],
    questions: [
      {
        id: 'accounting_software',
        question: 'Which accounting software do you use?',
        hint: 'Select your primary accounting tool',
        options: [
          { value: 'xero', label: 'Xero', integrations: [{ key: 'xero', name: 'Xero' }] },
          { value: 'quickbooks', label: 'QuickBooks', integrations: [{ key: 'quickbooks', name: 'QuickBooks' }] }
        ]
      }
    ]
  }
}

const mockStatusAllUnprovisioned = {
  tenantId: 'tenant-1',
  templates: [{ slug: 'ai-accountant', name: 'AI Accountant', isProvisioned: false }],
  provisionedCount: 0,
  availableCount: 1
}

const mockStatusAllProvisioned = {
  tenantId: 'tenant-1',
  templates: [{ slug: 'ai-accountant', name: 'AI Accountant', isProvisioned: true, provisionedAt: '2026-01-01' }],
  provisionedCount: 1,
  availableCount: 0
}

beforeEach(() => {
  usePresetupStore.getState().reset()
  vi.clearAllMocks()
})

describe('usePresetupStore', () => {
  describe('checkAndStart', () => {
    it('transitions to template-selection when unprovisioned templates exist', async () => {
      ;(mockElectronAPI.enterprise.apiRequest as unknown as Mock)
        .mockResolvedValueOnce(mockStatusAllUnprovisioned) // getStatus
        .mockResolvedValueOnce([mockTemplate]) // listTemplates

      await usePresetupStore.getState().checkAndStart()

      expect(usePresetupStore.getState().phase).toBe('template-selection')
      expect(usePresetupStore.getState().templates).toHaveLength(1)
      expect(usePresetupStore.getState().templates[0].slug).toBe('ai-accountant')
    })

    it('stays idle when all templates are provisioned', async () => {
      ;(mockElectronAPI.enterprise.apiRequest as unknown as Mock)
        .mockResolvedValueOnce(mockStatusAllProvisioned)
        .mockResolvedValueOnce([mockTemplate])

      await usePresetupStore.getState().checkAndStart()

      expect(usePresetupStore.getState().phase).toBe('idle')
      expect(usePresetupStore.getState().templates).toHaveLength(0)
    })

    it('transitions to error on API failure', async () => {
      ;(mockElectronAPI.enterprise.apiRequest as unknown as Mock)
        .mockRejectedValue(new Error('Network error'))

      await usePresetupStore.getState().checkAndStart()

      expect(usePresetupStore.getState().phase).toBe('error')
      expect(usePresetupStore.getState().error).toBe('Network error')
    })
  })

  describe('selectTemplate', () => {
    it('transitions to wizard phase when template has questions', () => {
      usePresetupStore.getState().selectTemplate(mockTemplate)

      expect(usePresetupStore.getState().phase).toBe('wizard')
      expect(usePresetupStore.getState().selectedTemplate?.slug).toBe('ai-accountant')
      expect(usePresetupStore.getState().answers).toEqual({})
    })

    it('transitions to provisioning when template has no questions', async () => {
      const noQuestionsTemplate = {
        ...mockTemplate,
        definition: { ...mockTemplate.definition, questions: [] }
      }

      ;(mockElectronAPI.enterprise.apiRequest as unknown as Mock)
        .mockResolvedValueOnce({
          status: 'completed',
          templateSlug: 'ai-accountant',
          provisionedResources: { workflows: [], integrations: [], skills: [] }
        })

      usePresetupStore.getState().selectTemplate(noQuestionsTemplate)

      // Should immediately start provisioning
      expect(usePresetupStore.getState().selectedTemplate?.slug).toBe('ai-accountant')
    })
  })

  describe('setAnswer', () => {
    it('updates answers map', () => {
      usePresetupStore.getState().setAnswer('accounting_software', 'xero')

      expect(usePresetupStore.getState().answers).toEqual({ accounting_software: 'xero' })
    })

    it('overwrites previous answer for same question', () => {
      usePresetupStore.getState().setAnswer('accounting_software', 'xero')
      usePresetupStore.getState().setAnswer('accounting_software', 'quickbooks')

      expect(usePresetupStore.getState().answers).toEqual({ accounting_software: 'quickbooks' })
    })
  })

  describe('submitProvision', () => {
    it('calls provision API and transitions to complete on success', async () => {
      usePresetupStore.setState({
        selectedTemplate: mockTemplate,
        answers: { accounting_software: 'xero' },
        phase: 'wizard'
      })

      ;(mockElectronAPI.enterprise.apiRequest as unknown as Mock)
        .mockResolvedValueOnce({
          status: 'completed',
          templateSlug: 'ai-accountant',
          provisionedResources: {
            workflows: ['invoice-processing'],
            integrations: ['xero'],
            skills: ['data-extraction']
          }
        })

      await usePresetupStore.getState().submitProvision()

      expect(mockElectronAPI.enterprise.apiRequest).toHaveBeenCalledWith(
        'POST',
        '/api/presetup/provision',
        { templateSlug: 'ai-accountant', selectedOptions: { accounting_software: 'xero' } }
      )
      expect(usePresetupStore.getState().phase).toBe('complete')
      expect(usePresetupStore.getState().provisionResult?.status).toBe('completed')
    })

    it('handles already_provisioned as success', async () => {
      usePresetupStore.setState({
        selectedTemplate: mockTemplate,
        answers: {},
        phase: 'provisioning'
      })

      ;(mockElectronAPI.enterprise.apiRequest as unknown as Mock)
        .mockResolvedValueOnce({
          status: 'already_provisioned',
          templateSlug: 'ai-accountant'
        })

      await usePresetupStore.getState().submitProvision()

      expect(usePresetupStore.getState().phase).toBe('complete')
    })

    it('transitions to error on failed status', async () => {
      usePresetupStore.setState({
        selectedTemplate: mockTemplate,
        answers: {},
        phase: 'provisioning'
      })

      ;(mockElectronAPI.enterprise.apiRequest as unknown as Mock)
        .mockResolvedValueOnce({
          status: 'failed',
          templateSlug: 'ai-accountant',
          errors: ['Workflow clone failed']
        })

      await usePresetupStore.getState().submitProvision()

      expect(usePresetupStore.getState().phase).toBe('error')
      expect(usePresetupStore.getState().error).toBe('Workflow clone failed')
    })

    it('transitions to error on API exception', async () => {
      usePresetupStore.setState({
        selectedTemplate: mockTemplate,
        answers: {},
        phase: 'provisioning'
      })

      ;(mockElectronAPI.enterprise.apiRequest as unknown as Mock)
        .mockRejectedValueOnce(new Error('Timeout'))

      await usePresetupStore.getState().submitProvision()

      expect(usePresetupStore.getState().phase).toBe('error')
      expect(usePresetupStore.getState().error).toBe('Timeout')
    })

    it('does nothing when no template is selected', async () => {
      await usePresetupStore.getState().submitProvision()

      expect(mockElectronAPI.enterprise.apiRequest).not.toHaveBeenCalled()
    })
  })

  describe('reset', () => {
    it('resets all state to initial values', () => {
      usePresetupStore.setState({
        templates: [mockTemplate],
        selectedTemplate: mockTemplate,
        answers: { q: 'a' },
        phase: 'complete',
        error: 'some error'
      })

      usePresetupStore.getState().reset()

      const state = usePresetupStore.getState()
      expect(state.templates).toEqual([])
      expect(state.selectedTemplate).toBeNull()
      expect(state.answers).toEqual({})
      expect(state.phase).toBe('idle')
      expect(state.error).toBeNull()
    })
  })

  describe('dismiss', () => {
    it('transitions to idle phase', () => {
      usePresetupStore.setState({ phase: 'template-selection' })

      usePresetupStore.getState().dismiss()

      expect(usePresetupStore.getState().phase).toBe('idle')
    })
  })
})
