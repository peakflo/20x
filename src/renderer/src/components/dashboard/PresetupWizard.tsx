import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Calculator,
  UserPlus,
  Package,
  Loader2,
  ArrowRight,
  ArrowLeft,
  Check,
  CheckCircle2,
  XCircle,
  RefreshCw,
  X,
  Plug
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { enterpriseApi } from '@/lib/ipc-client'
import { useDashboardStore, type PresetupTemplate } from '@/stores/dashboard-store'

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

interface IntegrationRef {
  key: string
  name: string
  required?: boolean
  description?: string
}

interface TemplateDefinition {
  questions?: TemplateQuestion[]
  workflows?: { marketplaceTemplateSlug: string }[]
  integrations?: IntegrationRef[]
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

// ─── Icon map ─────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ElementType> = {
  Calculator,
  UserPlus
}
function getIcon(name: string | null): React.ElementType {
  return (name && ICON_MAP[name]) || Package
}

// ─── Collect integrations from base + selected options ────────

function collectIntegrations(
  base: IntegrationRef[],
  questions: TemplateQuestion[],
  selectedOptions: Record<string, string>
): IntegrationRef[] {
  const merged = new Map<string, IntegrationRef>()

  for (const int of base) {
    merged.set(int.key, int)
  }

  for (const q of questions) {
    const val = selectedOptions[q.id]
    if (!val) continue
    const opt = q.options.find((o) => o.value === val)
    if (!opt?.integrations) continue
    for (const int of opt.integrations) {
      const existing = merged.get(int.key)
      merged.set(int.key, {
        key: int.key,
        name: int.name,
        required: existing?.required || int.required || false,
        description: int.description || existing?.description
      })
    }
  }
  return Array.from(merged.values())
}

// ─── Sub-components ───────────────────────────────────────────

type WizardStep = 'wizard' | 'connect-integrations' | 'provisioning'

/** Step 1: Walk through questions */
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
            Install package
            <Check className="ml-2 h-4 w-4" />
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
          {isLast ? (
            <>Next <ArrowRight className="ml-1 h-3.5 w-3.5" /></>
          ) : (
            <>Next <ArrowRight className="ml-1 h-3.5 w-3.5" /></>
          )}
        </Button>
      </div>
    </div>
  )
}

/** Step 2: Review integrations — then provision and open workflow-builder to connect */
function ConnectIntegrations({
  integrations,
  onComplete,
  onBack
}: {
  integrations: IntegrationRef[]
  onComplete: () => void
  onBack: () => void
}) {
  useEffect(() => {
    if (integrations.length === 0) {
      onComplete()
    }
  }, [integrations.length, onComplete])

  if (integrations.length === 0) {
    return null
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        {integrations.map((int) => (
          <div
            key={int.key}
            className="flex items-center gap-3 rounded-xl border border-border/50 p-3"
          >
            <div className="rounded-lg bg-muted p-2 shrink-0">
              <Plug className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{int.name}</span>
                {int.required && (
                  <span className="text-[10px] text-orange-600 dark:text-orange-400 font-medium">
                    Required
                  </span>
                )}
              </div>
              {int.description && (
                <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                  {int.description}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-3">
        <Button variant="outline" size="sm" onClick={onBack} className="flex-1">
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Previous
        </Button>
        <Button size="sm" onClick={onComplete} className="flex-1">
          Install &amp; connect <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

/** Step 3: Provisioning progress / result */
function ProvisioningState({
  templateName,
  isLoading,
  error,
  isSuccess,
  onRetry,
  onContinue,
  onConnectIntegrations
}: {
  templateName: string
  isLoading: boolean
  error: string | null
  isSuccess: boolean
  onRetry: () => void
  onContinue: () => void
  onConnectIntegrations: () => void
}) {
  return (
    <div className="py-4">
      {isLoading && (
        <div className="flex flex-col items-center gap-3 py-6">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <h3 className="text-sm font-semibold">Setting up {templateName}</h3>
          <p className="text-xs text-muted-foreground text-center max-w-xs">
            Configuring workflows, integrations, and AI skills. This usually takes a few seconds.
          </p>
          <div className="w-full max-w-xs h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full animate-pulse" style={{ width: '60%' }} />
          </div>
        </div>
      )}

      {isSuccess && (
        <div className="flex flex-col items-center gap-3 py-6">
          <CheckCircle2 className="h-10 w-10 text-green-500" />
          <h3 className="text-sm font-semibold">{templateName} is ready!</h3>
          <p className="text-xs text-muted-foreground text-center max-w-xs">
            Workflows and AI skills have been configured. Connect your integrations to start using them.
          </p>
          <Button size="sm" onClick={onConnectIntegrations} className="w-full max-w-xs">
            Connect integrations <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onContinue} className="w-full max-w-xs">
            I&apos;ll do it later
          </Button>
        </div>
      )}

      {error && (
        <div className="flex flex-col items-center gap-3 py-6">
          <XCircle className="h-10 w-10 text-destructive" />
          <h3 className="text-sm font-semibold">Setup encountered an issue</h3>
          <p className="text-xs text-destructive text-center max-w-xs">{error}</p>
          <div className="flex gap-3 w-full max-w-xs">
            <Button variant="outline" size="sm" onClick={onRetry} className="flex-1">
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Try again
            </Button>
            <Button variant="ghost" size="sm" onClick={onContinue} className="flex-1">
              Skip for now
            </Button>
          </div>
        </div>
      )}
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

  const [dialogStep, setDialogStep] = useState<WizardStep>('wizard')
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({})
  const [isProvisioning, setIsProvisioning] = useState(false)
  const [provisionSuccess, setProvisionSuccess] = useState(false)
  const [provisionError, setProvisionError] = useState<string | null>(null)

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
    return () => { cancelled = true }
  }, [template.slug])

  // Integrations to show after wizard questions
  const integrationsToConnect = useMemo(() => {
    if (!fullTemplate) return []
    return collectIntegrations(
      fullTemplate.definition.integrations ?? [],
      fullTemplate.definition.questions ?? [],
      selectedOptions
    )
  }, [fullTemplate, selectedOptions])

  const handleWizardComplete = useCallback((opts: Record<string, string>) => {
    setSelectedOptions(opts)
    setDialogStep('connect-integrations')
  }, [])

  const handleIntegrationsComplete = useCallback(async () => {
    setDialogStep('provisioning')
    setIsProvisioning(true)
    setProvisionSuccess(false)
    setProvisionError(null)

    try {
      await enterpriseApi.apiRequest('POST', '/api/presetup/provision', {
        templateSlug: template.slug,
        selectedOptions
      })
      setProvisionSuccess(true)
      await useDashboardStore.getState().fetchPresetups()
    } catch (err) {
      setProvisionError(err instanceof Error ? err.message : 'Provisioning failed')
    } finally {
      setIsProvisioning(false)
    }
  }, [template.slug, selectedOptions])

  const handleRetry = useCallback(() => {
    setDialogStep('connect-integrations')
    setProvisionError(null)
    setProvisionSuccess(false)
  }, [])

  const handleConnectIntegrations = useCallback(async () => {
    try {
      const apiUrl = await enterpriseApi.getApiUrl()
      const integrationsUrl = `${apiUrl}/settings/integrations?presetup=${template.slug}`
      await window.electronAPI.shell.openExternal(integrationsUrl)
    } catch {
      // Fallback — try without query param
      const apiUrl = await enterpriseApi.getApiUrl()
      await window.electronAPI.shell.openExternal(`${apiUrl}/settings/integrations`)
    }
    onClose()
  }, [template.slug, onClose])

  // ─── Dialog titles ────────────────────────────────────

  const title = useMemo(() => {
    switch (dialogStep) {
      case 'wizard': return `Set up ${template.name}`
      case 'connect-integrations': return 'Connect integrations'
      case 'provisioning': return ''
    }
  }, [dialogStep, template.name])

  const subtitle = useMemo(() => {
    switch (dialogStep) {
      case 'wizard': return `Answer a few questions to configure ${template.name} for your team.`
      case 'connect-integrations': return `These integrations will be connected after setup.`
      case 'provisioning': return ''
    }
  }, [dialogStep, template.name])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-md mx-4 rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
        {/* Close button — hidden during provisioning */}
        {!isProvisioning && (
          <button
            className="absolute top-3.5 right-3.5 text-muted-foreground hover:text-foreground transition-colors z-10 cursor-pointer"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        )}

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
              <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
            </div>
          )}

          {/* Wizard content */}
          {!loading && !fetchError && fullTemplate && (
            <>
              {/* Header */}
              {title && dialogStep !== 'provisioning' && (
                <div className="mb-4">
                  <h2 className="text-sm font-semibold">{title}</h2>
                  {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
                </div>
              )}

              {dialogStep === 'wizard' && (
                <WizardQuestions
                  template={fullTemplate}
                  onComplete={handleWizardComplete}
                  onBack={onClose}
                />
              )}

              {dialogStep === 'connect-integrations' && (
                <ConnectIntegrations
                  integrations={integrationsToConnect}
                  onComplete={handleIntegrationsComplete}
                  onBack={() => setDialogStep('wizard')}
                />
              )}

              {dialogStep === 'provisioning' && (
                <ProvisioningState
                  templateName={fullTemplate.name}
                  isLoading={isProvisioning}
                  error={provisionError}
                  isSuccess={provisionSuccess}
                  onRetry={handleRetry}
                  onContinue={onClose}
                  onConnectIntegrations={handleConnectIntegrations}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
