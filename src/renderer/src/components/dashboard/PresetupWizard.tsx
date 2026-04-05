import { useEffect, useState } from 'react'
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
import { useDashboardStore, type PresetupTemplate } from '@/stores/dashboard-store'

// ─── Types from presetup template definition ─────────────────

interface QuestionOption {
  value: string
  label: string
  workflows?: unknown[]
  integrations?: unknown[]
}

interface TemplateQuestion {
  id: string
  question: string
  hint?: string
  options: QuestionOption[]
}

interface TemplateDefinition {
  questions?: TemplateQuestion[]
  workflows?: unknown[]
  integrations?: unknown[]
}

interface FullTemplate {
  slug: string
  name: string
  description: string
  category: string
  icon: string
  definition: TemplateDefinition
}

// ─── Icon map ─────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ElementType> = {
  Calculator,
  UserPlus
}

function getIcon(iconName: string): React.ElementType {
  return ICON_MAP[iconName] || Package
}

// ─── Wizard component ─────────────────────────────────────────

interface PresetupWizardProps {
  template: PresetupTemplate
  onClose: () => void
}

export function PresetupWizard({ template, onClose }: PresetupWizardProps) {
  // Full template data fetched from API (includes questions)
  const [fullTemplate, setFullTemplate] = useState<FullTemplate | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Wizard state
  const [currentStep, setCurrentStep] = useState(0)
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({})
  const [provisioning, setProvisioning] = useState(false)
  const [provisionDone, setProvisionDone] = useState(false)

  const Icon = getIcon(template.icon)
  const questions = fullTemplate?.definition?.questions || []
  const totalSteps = questions.length + 1 // overview + questions

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
          console.error('Failed to fetch template details:', err)
          setError(err.message || 'Failed to load template details')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [template.slug])

  const handleSelectOption = (questionId: string, value: string) => {
    setSelectedOptions((prev) => ({ ...prev, [questionId]: value }))
  }

  const handleProvision = async () => {
    setProvisioning(true)
    try {
      await enterpriseApi.apiRequest('POST', '/api/presetup/provision', {
        templateSlug: template.slug,
        selectedOptions
      })
      setProvisionDone(true)
      // Refresh presetup status in dashboard
      await useDashboardStore.getState().fetchPresetups()
    } catch (err) {
      console.error('Provisioning failed:', err)
      setError(err instanceof Error ? err.message : 'Provisioning failed')
    } finally {
      setProvisioning(false)
    }
  }

  const canProceed = () => {
    if (currentStep === 0) return true // overview step — always can proceed
    const question = questions[currentStep - 1]
    if (!question) return true
    return !!selectedOptions[question.id]
  }

  const handleNext = () => {
    if (currentStep < totalSteps - 1) {
      setCurrentStep((s) => s + 1)
    } else {
      handleProvision()
    }
  }

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1)
    }
  }

  // ─── Render ─────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-lg mx-4 rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
        {/* Close button */}
        <button
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors z-10 cursor-pointer"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>

        {/* Progress bar */}
        {!loading && !error && !provisionDone && (
          <div className="h-1 bg-muted">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${((currentStep + 1) / (totalSteps + 1)) * 100}%` }}
            />
          </div>
        )}

        <div className="p-6">
          {/* Loading state */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Loading setup wizard...</p>
            </div>
          )}

          {/* Error state */}
          {error && !loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          )}

          {/* Done state */}
          {provisionDone && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <div className="rounded-full bg-green-500/10 p-4">
                <Check className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <div className="text-center">
                <h3 className="text-lg font-semibold">{template.name} is ready!</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Your workflows and integrations have been set up.
                </p>
              </div>
              <Button onClick={onClose}>
                Done
              </Button>
            </div>
          )}

          {/* Wizard steps */}
          {!loading && !error && !provisionDone && (
            <>
              {/* Step 0: Overview */}
              {currentStep === 0 && (
                <div className="space-y-4">
                  <div className="flex items-start gap-4">
                    <div className="rounded-lg bg-primary/10 p-3 shrink-0">
                      <Icon className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <h2 className="text-lg font-semibold">{template.name}</h2>
                      <p className="text-sm text-muted-foreground mt-1">
                        {template.description}
                      </p>
                    </div>
                  </div>

                  {/* What's included */}
                  <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
                    <h3 className="text-sm font-medium">What&apos;s included:</h3>
                    <ul className="space-y-2">
                      {(fullTemplate?.definition?.workflows || []).length > 0 && (
                        <li className="text-sm text-muted-foreground flex items-center gap-2">
                          <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                          {fullTemplate!.definition.workflows!.length} workflow{fullTemplate!.definition.workflows!.length > 1 ? 's' : ''}
                        </li>
                      )}
                      {(fullTemplate?.definition?.integrations || []).length > 0 && (
                        <li className="text-sm text-muted-foreground flex items-center gap-2">
                          <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                          {fullTemplate!.definition.integrations!.length} integration{fullTemplate!.definition.integrations!.length > 1 ? 's' : ''}
                        </li>
                      )}
                      {questions.length > 0 && (
                        <li className="text-sm text-muted-foreground flex items-center gap-2">
                          <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                          Customizable setup ({questions.length} question{questions.length > 1 ? 's' : ''})
                        </li>
                      )}
                    </ul>
                  </div>
                </div>
              )}

              {/* Question steps */}
              {currentStep > 0 && currentStep <= questions.length && (() => {
                const question = questions[currentStep - 1]
                if (!question) return null
                const selected = selectedOptions[question.id]

                return (
                  <div className="space-y-4">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">
                        Step {currentStep} of {questions.length}
                      </p>
                      <h2 className="text-lg font-semibold">{question.question}</h2>
                      {question.hint && (
                        <p className="text-sm text-muted-foreground mt-1">{question.hint}</p>
                      )}
                    </div>

                    <div className="space-y-2">
                      {question.options.map((option) => (
                        <button
                          key={option.value}
                          className={`w-full text-left rounded-lg border p-4 transition-all cursor-pointer ${
                            selected === option.value
                              ? 'border-primary bg-primary/5 ring-1 ring-primary'
                              : 'border-border/50 hover:border-border hover:bg-muted/30'
                          }`}
                          onClick={() => handleSelectOption(question.id, option.value)}
                        >
                          <div className="flex items-center gap-3">
                            <div
                              className={`h-4 w-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                                selected === option.value
                                  ? 'border-primary'
                                  : 'border-muted-foreground/30'
                              }`}
                            >
                              {selected === option.value && (
                                <div className="h-2 w-2 rounded-full bg-primary" />
                              )}
                            </div>
                            <span className="text-sm font-medium">{option.label}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })()}

              {/* Navigation buttons */}
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-border/50">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleBack}
                  disabled={currentStep === 0}
                  className="gap-1.5"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </Button>

                <Button
                  size="sm"
                  onClick={handleNext}
                  disabled={!canProceed() || provisioning}
                  className="gap-1.5"
                >
                  {provisioning ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Setting up...
                    </>
                  ) : currentStep >= totalSteps - 1 ? (
                    <>
                      Set up
                      <Check className="h-3.5 w-3.5" />
                    </>
                  ) : (
                    <>
                      Next
                      <ArrowRight className="h-3.5 w-3.5" />
                    </>
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
