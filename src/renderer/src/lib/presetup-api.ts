/**
 * Presetup API service — calls workflow-builder presetup endpoints
 * via the existing enterprise:apiRequest IPC channel.
 */
import { enterpriseApi } from './ipc-client'

// ---------------------------------------------------------------------------
// Types (matching workflow-builder backend schema)
// ---------------------------------------------------------------------------

export interface WorkflowRef {
  slug: string
  name: string
  description?: string
}

export interface IntegrationRef {
  key: string
  name: string
  required?: boolean
}

export interface SkillRef {
  name: string
  description?: string
}

export interface PresetupQuestionOption {
  value: string
  label: string
  description?: string
  workflows?: WorkflowRef[]
  integrations?: IntegrationRef[]
  skills?: SkillRef[]
}

export interface PresetupQuestion {
  id: string
  question: string
  hint?: string
  options: PresetupQuestionOption[]
}

export interface PresetupTemplateDefinition {
  workflows: WorkflowRef[]
  integrations: IntegrationRef[]
  skills: SkillRef[]
  questions: PresetupQuestion[]
}

export interface PresetupTemplate {
  id: string
  slug: string
  name: string
  description: string
  version: string
  category: string
  tags: string[]
  icon: string
  definition: PresetupTemplateDefinition
}

export interface TemplateStatus {
  slug: string
  name: string
  isProvisioned: boolean
  provisionedAt?: string
}

export interface PresetupStatusResponse {
  tenantId: string
  templates: TemplateStatus[]
  provisionedCount: number
  availableCount: number
}

export interface ProvisionResult {
  status: 'completed' | 'already_provisioned' | 'failed'
  templateSlug: string
  provisionedResources?: {
    workflows: string[]
    integrations: string[]
    skills: string[]
  }
  errors?: string[]
}

// ---------------------------------------------------------------------------
// API service
// ---------------------------------------------------------------------------

export const presetupApi = {
  async getStatus(): Promise<PresetupStatusResponse> {
    const res = await enterpriseApi.apiRequest('GET', '/api/presetup/status')
    return res as PresetupStatusResponse
  },

  async listTemplates(): Promise<PresetupTemplate[]> {
    const res = await enterpriseApi.apiRequest('GET', '/api/presetup/templates')
    return res as PresetupTemplate[]
  },

  async getTemplate(slug: string): Promise<PresetupTemplate> {
    const res = await enterpriseApi.apiRequest('GET', `/api/presetup/templates/${slug}`)
    return res as PresetupTemplate
  },

  async provision(
    templateSlug: string,
    selectedOptions: Record<string, string>
  ): Promise<ProvisionResult> {
    const res = await enterpriseApi.apiRequest('POST', '/api/presetup/provision', {
      templateSlug,
      selectedOptions
    })
    return res as ProvisionResult
  },

  async getStatusBySlug(slug: string): Promise<TemplateStatus> {
    const res = await enterpriseApi.apiRequest('GET', `/api/presetup/status/${slug}`)
    return res as TemplateStatus
  }
}
