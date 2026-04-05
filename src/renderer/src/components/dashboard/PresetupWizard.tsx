import { useEffect, useState, useCallback } from 'react'
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

// ─── Main wizard dialog ───────────────────────────────────────

interface PresetupWizardProps {
  template: PresetupTemplate
  onClose: () => void
}

export function PresetupWizard({ template, onClose }: PresetupWizardProps) {
  const [fullTemplate, setFullTemplate] = useState<FullTemplate | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

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

  // After wizard questions → open workflow-builder connect page with resolved integration keys
  const handleWizardComplete = useCallback(
    async (opts: Record<string, string>) => {
      try {
        const frontendUrl = await getWorkfloFrontendUrl()

        // Collect integration keys from base template + selected question options
        const integrationKeys = new Set<string>()

        // Base template integrations
        for (const int of fullTemplate?.definition.integrations ?? []) {
          integrationKeys.add(int.key)
        }

        // Integrations added by selected question options
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

        // Build deep-link: /presetup/connect?integrations=gmail,xero&tenantId=abc#access_token=...&refresh_token=...
        const params = new URLSearchParams()
        if (integrationKeys.size > 0) {
          params.set('integrations', Array.from(integrationKeys).join(','))
        }

        // Get auth tokens and tenantId for WB authentication
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
    [fullTemplate, onClose]
  )

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
                  Answer a few questions to configure {template.name} for your team.
                </p>
              </div>

              <WizardQuestions
                template={fullTemplate}
                onComplete={handleWizardComplete}
                onBack={onClose}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
