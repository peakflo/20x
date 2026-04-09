import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Calculator,
  UserPlus,
  Package,
  Loader2,
  ArrowRight,
  ArrowLeft,
  Check,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { enterpriseApi } from '@/lib/ipc-client'
import type { PresetupTemplate } from '@/stores/dashboard-store'

// ─── Types ────────────────────────────────────────────────────

interface QuestionOption {
  value: string
  label: string
  workflows?: { marketplaceTemplateSlug: string }[]
  integrations?: { key: string; name: string; required?: boolean; description?: string }[]
}

interface TemplateQuestion {
  id: string
  question: string
  hint?: string
  options: QuestionOption[]
}

interface TemplateDefinition {
  questions?: TemplateQuestion[]
  workflows?: { marketplaceTemplateSlug: string }[]
  integrations?: { key: string; name: string; required?: boolean; description?: string }[]
  skills?: { name: string; description: string }[]
}

interface FullTemplate {
  slug: string
  name: string
  description: string
  category: string
  icon: string | null
  definition: TemplateDefinition
}

// ─── Integration key → IntegrationType mapping ───────────────

// Maps presetup template integration keys to IntegrationType (same as workflow-builder)
const INTEGRATION_KEY_TO_TYPE: Record<string, string> = {
  email: 'google-mail',
  gmail: 'google-mail',
  outlook: 'outlook',
  slack: 'slack',
  hubspot: 'hubspot',
  salesforce: 'salesforce',
  xero: 'xero',
}

function isOAuthIntegration(key: string): boolean {
  return key in INTEGRATION_KEY_TO_TYPE
}

// ─── Icon map ─────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ElementType> = {
  Calculator,
  UserPlus
}
function getIcon(name: string | null): React.ElementType {
  return (name && ICON_MAP[name]) || Package
}

// ─── Derive workflow-builder frontend URL from API URL ────────

async function getWorkfloFrontendUrl(): Promise<string> {
  const apiUrl = await enterpriseApi.getApiUrl()
  const parsed = new URL(apiUrl)
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
    parsed.port = '4000'
  } else {
    parsed.hostname = parsed.hostname.replace('-api.', '-app.').replace(/^api\./, 'app.')
  }
  return parsed.origin
}

// ─── Sub-components ───────────────────────────────────────────

/** Walk through questions, then open workflow-builder to connect & install */
function WizardQuestions({
  template,
  onComplete,
  onBack
}: {
  template: FullTemplate
  onComplete: (opts: Record<string, string>) => void
  onBack: () => void
}) {
  const questions = template.definition.questions ?? []
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})

  const Icon = getIcon(template.icon)
  const current = questions[step]
  const isLast = step === questions.length - 1
  const hasAnswer = current ? !!answers[current.id] : false

  // No questions — skip straight to completion
  if (questions.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-primary/10 p-2.5 shrink-0">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="font-medium text-sm">{template.name}</p>
            <p className="text-xs text-muted-foreground">{template.description}</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          This package is ready to be installed with default settings.
        </p>
        <div className="flex gap-3">
          <Button variant="outline" onClick={onBack} className="flex-1">
            Cancel
          </Button>
          <Button onClick={() => onComplete({})} className="flex-1">
            Continue
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Progress dots */}
      <div className="flex items-center gap-3">
        <p className="text-xs text-muted-foreground shrink-0">
          Step {step + 1} of {questions.length}
        </p>
        <div className="flex gap-1.5 flex-1">
          {questions.map((_, idx) => (
            <div
              key={idx}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                idx <= step ? 'bg-primary' : 'bg-muted'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Question */}
      {current && (
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">{current.question}</h3>
            {current.hint && (
              <p className="text-xs text-muted-foreground mt-1">{current.hint}</p>
            )}
          </div>
          <div className="space-y-2">
            {current.options.map((opt) => {
              const selected = answers[current.id] === opt.value
              return (
                <button
                  key={opt.value}
                  className={`w-full rounded-xl border-2 p-3 text-left transition-all cursor-pointer ${
                    selected
                      ? 'border-primary bg-primary/5 shadow-sm'
                      : 'border-border hover:border-primary/40 hover:bg-muted/50'
                  }`}
                  onClick={() => setAnswers((a) => ({ ...a, [current.id]: opt.value }))}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-xs">{opt.label}</span>
                    {selected && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  {(opt.workflows?.length || opt.integrations?.length) ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {opt.integrations?.map((int) => (
                        <span
                          key={int.key}
                          className="inline-flex rounded-md bg-green-500/10 px-2 py-0.5 text-[10px] text-green-700 dark:text-green-300"
                        >
                          + {int.name}
                        </span>
                      ))}
                      {opt.workflows?.map((wf) => (
                        <span
                          key={wf.marketplaceTemplateSlug}
                          className="inline-flex rounded-md bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-700 dark:text-blue-300"
                        >
                          + workflow
                        </span>
                      ))}
                    </div>
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Nav */}
      <div className="flex gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => (step === 0 ? onBack() : setStep((s) => s - 1))}
          className="flex-1"
        >
          {step === 0 ? 'Cancel' : <><ArrowLeft className="mr-1 h-3.5 w-3.5" /> Previous</>}
        </Button>
        <Button
          size="sm"
          onClick={() => (isLast ? onComplete(answers) : setStep((s) => s + 1))}
          disabled={!hasAnswer}
          className="flex-1"
        >
          Next <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

// ─── Integrations step ───────────────────────────────────────

interface ExistingIntegration {
  id: string
  name: string
  type: string
}

interface RequiredIntegration {
  key: string
  name: string
  required: boolean
}

function IntegrationsStep({
  requiredIntegrations,
  existingIntegrations,
  loadingIntegrations,
  selectedIntegrations,
  onSelectIntegration,
  onContinue,
  onBack,
}: {
  requiredIntegrations: RequiredIntegration[]
  existingIntegrations: ExistingIntegration[]
  loadingIntegrations: boolean
  selectedIntegrations: Record<string, string | null>
  onSelectIntegration: (key: string, id: string | null) => void
  onContinue: () => void
  onBack: () => void
}) {
  const existingByType = useMemo(() => {
    const byType: Record<string, ExistingIntegration[]> = {}
    for (const intg of existingIntegrations) {
      if (!byType[intg.type]) byType[intg.type] = []
      byType[intg.type].push(intg)
    }
    return byType
  }, [existingIntegrations])

  if (loadingIntegrations) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <p className="text-xs text-muted-foreground">Loading integrations...</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Connect integrations</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Select existing connections or connect new accounts in your browser.
        </p>
      </div>

      <div className="space-y-2">
        {requiredIntegrations.map((integration) => {
          const integrationType = INTEGRATION_KEY_TO_TYPE[integration.key]
          const existing = integrationType ? (existingByType[integrationType] ?? []) : []
          const selectedId = selectedIntegrations[integration.key]

          return (
            <div
              key={integration.key}
              className="rounded-xl border border-border p-3 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs font-medium">{integration.name}</span>
                  {integration.required && (
                    <span className="text-[10px] text-orange-600 dark:text-orange-400 font-medium">
                      Required
                    </span>
                  )}
                </div>
                {selectedId !== null && selectedId !== undefined ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : null}
              </div>

              {existing.length > 0 ? (
                <select
                  value={selectedId ?? '__new__'}
                  onChange={(e) => {
                    const val = e.target.value
                    onSelectIntegration(integration.key, val === '__new__' ? null : val)
                  }}
                  className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="__new__">🔗 Connect new in browser</option>
                  {existing.map((intg) => (
                    <option key={intg.id} value={intg.id}>
                      ✓ {intg.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Will connect in browser
                </p>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex gap-3">
        <Button variant="outline" size="sm" onClick={onBack} className="flex-1">
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back
        </Button>
        <Button size="sm" onClick={onContinue} className="flex-1">
          Open in browser
          <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

// ─── Main wizard dialog ───────────────────────────────────────

interface PresetupWizardProps {
  template: PresetupTemplate
  onClose: () => void
}

export function PresetupWizard({ template, onClose }: PresetupWizardProps) {
  const [fullTemplate, setFullTemplate] = useState<FullTemplate | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  type WizardStep = 'questions' | 'integrations'
  const [wizardStep, setWizardStep] = useState<WizardStep>('questions')
  const [wizardAnswers, setWizardAnswers] = useState<Record<string, string>>({})
  const [existingIntegrations, setExistingIntegrations] = useState<ExistingIntegration[]>([])
  const [loadingIntegrations, setLoadingIntegrations] = useState(false)
  const [selectedIntegrations, setSelectedIntegrations] = useState<Record<string, string | null>>({})

  // Fetch full template on mount
  useEffect(() => {
    let cancelled = false
    enterpriseApi
      .apiRequest('GET', `/api/presetup/templates/${template.slug}`)
      .then((data) => {
        if (!cancelled) {
          setFullTemplate(data as FullTemplate)
          setLoading(false)
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setFetchError(err.message || 'Failed to load template')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [template.slug])

  // Open workflow-builder connect page with resolved integration keys and pre-selected IDs
  const handleOpenInBrowser = useCallback(
    async (opts: Record<string, string>, integrationSelections: Record<string, string | null>) => {
      try {
        const frontendUrl = await getWorkfloFrontendUrl()

        const integrationKeys = new Set<string>()
        for (const int of fullTemplate?.definition.integrations ?? []) {
          integrationKeys.add(int.key)
        }
        for (const question of fullTemplate?.definition.questions ?? []) {
          const selectedValue = opts[question.id]
          if (!selectedValue) continue
          const option = question.options.find((o) => o.value === selectedValue)
          if (option?.integrations) {
            for (const int of option.integrations) {
              integrationKeys.add(int.key)
            }
          }
        }

        const params = new URLSearchParams()
        if (integrationKeys.size > 0) {
          params.set('integrations', Array.from(integrationKeys).join(','))
        }

        params.set('templateSlug', template.slug)
        if (Object.keys(opts).length > 0) {
          const optPairs = Object.entries(opts).map(([k, v]) => `${k}:${v}`)
          params.set('selectedOptions', optPairs.join(','))
        }

        // Pass pre-selected existing integration IDs
        const connectedEntries = Object.entries(integrationSelections)
          .filter(([, id]) => id !== null)
          .map(([key, id]) => `${key}:${id}`)
        if (connectedEntries.length > 0) {
          params.set('connectedIntegrations', connectedEntries.join(','))
        }

        const { accessToken, refreshToken, tenantId } = await enterpriseApi.getAuthTokens()
        if (tenantId) params.set('tenantId', tenantId)

        const hashParams = new URLSearchParams()
        hashParams.set('access_token', accessToken)
        hashParams.set('refresh_token', refreshToken)

        const connectUrl = `${frontendUrl}/presetup/connect?${params.toString()}#${hashParams.toString()}`
        await window.electronAPI.shell.openExternal(connectUrl)
      } catch {
        // Best-effort fallback
      }
      onClose()
    },
    [fullTemplate, template.slug, onClose]
  )

  // After wizard questions → transition to integrations step (or open browser directly)
  const handleQuestionsComplete = useCallback(
    async (opts: Record<string, string>) => {
      setWizardAnswers(opts)

      // Collect required OAuth integration keys
      const integrationKeys = new Set<string>()
      for (const int of fullTemplate?.definition.integrations ?? []) {
        if (isOAuthIntegration(int.key)) integrationKeys.add(int.key)
      }
      for (const question of fullTemplate?.definition.questions ?? []) {
        const selectedValue = opts[question.id]
        if (!selectedValue) continue
        const option = question.options.find((o) => o.value === selectedValue)
        if (option?.integrations) {
          for (const int of option.integrations) {
            if (isOAuthIntegration(int.key)) integrationKeys.add(int.key)
          }
        }
      }

      if (integrationKeys.size === 0) {
        // No integrations needed, go directly to browser
        await handleOpenInBrowser(opts, {})
        return
      }

      setWizardStep('integrations')

      // Fetch existing integrations
      setLoadingIntegrations(true)
      try {
        const data = await enterpriseApi.apiRequest('GET', '/api/integrations')
        setExistingIntegrations(data as ExistingIntegration[])
      } catch {
        setExistingIntegrations([])
      } finally {
        setLoadingIntegrations(false)
      }
    },
    [fullTemplate, handleOpenInBrowser]
  )

  // Compute required integrations for the integrations step
  const requiredIntegrations = useMemo((): RequiredIntegration[] => {
    if (!fullTemplate) return []
    const seen = new Set<string>()
    const result: RequiredIntegration[] = []

    const addInt = (int: { key: string; name: string; required?: boolean }) => {
      if (seen.has(int.key) || !isOAuthIntegration(int.key)) return
      seen.add(int.key)
      result.push({ key: int.key, name: int.name, required: int.required ?? false })
    }

    for (const int of fullTemplate.definition.integrations ?? []) addInt(int)
    for (const question of fullTemplate.definition.questions ?? []) {
      const val = wizardAnswers[question.id]
      if (!val) continue
      const option = question.options.find((o) => o.value === val)
      option?.integrations?.forEach(addInt)
    }

    return result
  }, [fullTemplate, wizardAnswers])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-md mx-4 rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
        <button
          className="absolute top-3.5 right-3.5 text-muted-foreground hover:text-foreground transition-colors z-10 cursor-pointer"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="p-5">
          {/* Loading */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-xs text-muted-foreground">Loading setup wizard...</p>
            </div>
          )}

          {/* Fetch error */}
          {fetchError && !loading && (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <p className="text-xs text-destructive">{fetchError}</p>
              <Button variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          )}

          {/* Wizard content */}
          {!loading && !fetchError && fullTemplate && (
            <>
              <div className="mb-4">
                <h2 className="text-sm font-semibold">Set up {template.name}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {wizardStep === 'questions'
                    ? `Answer a few questions to configure ${template.name} for your team.`
                    : 'Configure your integrations before installing.'}
                </p>
              </div>

              {wizardStep === 'questions' && (
                <WizardQuestions
                  template={fullTemplate}
                  onComplete={handleQuestionsComplete}
                  onBack={onClose}
                />
              )}

              {wizardStep === 'integrations' && (
                <IntegrationsStep
                  requiredIntegrations={requiredIntegrations}
                  existingIntegrations={existingIntegrations}
                  loadingIntegrations={loadingIntegrations}
                  selectedIntegrations={selectedIntegrations}
                  onSelectIntegration={(key, id) =>
                    setSelectedIntegrations((prev) => ({ ...prev, [key]: id }))
                  }
                  onContinue={() => handleOpenInBrowser(wizardAnswers, selectedIntegrations)}
                  onBack={() => setWizardStep('questions')}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
