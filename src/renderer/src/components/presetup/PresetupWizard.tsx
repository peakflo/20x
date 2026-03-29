import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import type { PresetupTemplate, PresetupQuestion } from '@/lib/presetup-api'
import { ChevronLeft, ChevronRight, Plug, Workflow } from 'lucide-react'

interface PresetupWizardProps {
  template: PresetupTemplate
  onComplete: (answers: Record<string, string>) => void
  onBack: () => void
}

export function PresetupWizard({ template, onComplete, onBack }: PresetupWizardProps) {
  const questions = template.definition.questions
  const [currentStep, setCurrentStep] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})

  const question: PresetupQuestion | undefined = questions[currentStep]
  const isLastStep = currentStep === questions.length - 1
  const selectedValue = question ? answers[question.id] : undefined

  const handleSelect = (questionId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }))
  }

  const handleNext = () => {
    if (isLastStep) {
      onComplete(answers)
    } else {
      setCurrentStep((s) => s + 1)
    }
  }

  const handlePrev = () => {
    if (currentStep === 0) {
      onBack()
    } else {
      setCurrentStep((s) => s - 1)
    }
  }

  if (!question) {
    // No questions — show confirmation
    return (
      <div className="space-y-6">
        <div className="text-center py-4">
          <h3 className="text-sm font-semibold text-foreground mb-2">
            Ready to install {template.name}?
          </h3>
          <p className="text-xs text-muted-foreground">
            This will set up the workflows, integrations, and skills for your account.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onBack} className="flex-1">
            <ChevronLeft className="h-3.5 w-3.5 mr-1" />
            Back
          </Button>
          <Button size="sm" onClick={() => onComplete({})} className="flex-1">
            Install package
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          Step {currentStep + 1} of {questions.length}
        </span>
        <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${((currentStep + 1) / questions.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Question */}
      <div>
        <h3 className="text-sm font-semibold text-foreground">{question.question}</h3>
        {question.hint && (
          <p className="text-xs text-muted-foreground mt-1">{question.hint}</p>
        )}
      </div>

      {/* Options */}
      <div className="space-y-2">
        {question.options.map((option) => {
          const isSelected = selectedValue === option.value
          return (
            <button
              key={option.value}
              type="button"
              className={`w-full text-left p-3 rounded-lg border transition-colors ${
                isSelected
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/30 bg-card'
              }`}
              onClick={() => handleSelect(question.id, option.value)}
            >
              <div className="text-sm font-medium text-foreground">{option.label}</div>
              {option.description && (
                <div className="text-xs text-muted-foreground mt-0.5">{option.description}</div>
              )}
              {/* Show what this option adds */}
              <div className="flex flex-wrap gap-1 mt-1.5">
                {option.workflows && option.workflows.length > 0 && (
                  <Badge variant="blue">
                    <Workflow className="h-3 w-3 mr-0.5" />
                    +{option.workflows.length} workflow{option.workflows.length !== 1 ? 's' : ''}
                  </Badge>
                )}
                {option.integrations && option.integrations.length > 0 && (
                  <Badge variant="green">
                    <Plug className="h-3 w-3 mr-0.5" />
                    +{option.integrations.length} integration{option.integrations.length !== 1 ? 's' : ''}
                  </Badge>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Navigation */}
      <div className="flex gap-2 pt-2">
        <Button variant="outline" size="sm" onClick={handlePrev} className="flex-1">
          <ChevronLeft className="h-3.5 w-3.5 mr-1" />
          Back
        </Button>
        <Button
          size="sm"
          onClick={handleNext}
          disabled={!selectedValue}
          className="flex-1"
        >
          {isLastStep ? 'Set up' : 'Next'}
          {!isLastStep && <ChevronRight className="h-3.5 w-3.5 ml-1" />}
        </Button>
      </div>
    </div>
  )
}
