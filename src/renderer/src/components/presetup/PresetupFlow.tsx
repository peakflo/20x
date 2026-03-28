import { useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogTitle,
  DialogDescription
} from '@/components/ui/Dialog'
import { usePresetupStore, collectIntegrationKeys } from '@/stores/presetup-store'
import { PresetupTemplateCard } from './PresetupTemplateCard'
import { PresetupWizard } from './PresetupWizard'
import { PresetupProvisioningState } from './PresetupProvisioningState'
import { PresetupConnectIntegrations } from './PresetupConnectIntegrations'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { Loader2, Package } from 'lucide-react'
import { VisuallyHidden } from '@/components/ui/VisuallyHidden'

interface PresetupFlowProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PresetupFlow({ open, onOpenChange }: PresetupFlowProps) {
  const {
    phase,
    templates,
    selectedTemplate,
    answers,
    error,
    provisionResult,
    checkAndStart,
    selectTemplate,
    setAnswer,
    proceedAfterWizard,
    proceedAfterIntegrations,
    submitProvision,
    reset,
    dismiss
  } = usePresetupStore()

  const { currentTenant } = useEnterpriseStore()

  // Load templates when dialog opens
  useEffect(() => {
    if (open && phase === 'idle') {
      checkAndStart()
    }
  }, [open])

  // Auto-close dialog when phase returns to idle (e.g., all templates already provisioned)
  const hasChecked = usePresetupStore((s) => s.status !== null)
  useEffect(() => {
    if (open && phase === 'idle' && hasChecked) {
      onOpenChange(false)
    }
  }, [open, phase, hasChecked])

  const handleDismiss = () => {
    dismiss()
    onOpenChange(false)
  }

  const handleComplete = () => {
    reset()
    onOpenChange(false)
  }

  // Prevent closing during provisioning
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && phase === 'provisioning') return
    if (!nextOpen) {
      handleDismiss()
    } else {
      onOpenChange(true)
    }
  }

  const dialogTitle = (): string => {
    switch (phase) {
      case 'loading':
        return 'Loading packages...'
      case 'template-selection':
        return 'Choose a setup package'
      case 'wizard':
        return selectedTemplate?.name || 'Configure package'
      case 'connect-integrations':
        return 'Connect integrations'
      case 'provisioning':
        return 'Installing...'
      case 'complete':
        return 'Setup complete'
      case 'error':
        return 'Setup'
      default:
        return 'Presetup'
    }
  }

  const dialogDescription = (): string => {
    switch (phase) {
      case 'template-selection':
        return 'Select a preconfigured package to get started quickly with workflows, integrations, and skills.'
      case 'wizard':
        return 'Answer a few questions to customise the package for your needs.'
      case 'connect-integrations':
        return 'Connect the required integrations before installing the package.'
      default:
        return ''
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={phase === 'template-selection' ? 'max-w-2xl' : 'max-w-xl'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-4 w-4" />
            {dialogTitle()}
          </DialogTitle>
          {dialogDescription() ? (
            <DialogDescription>{dialogDescription()}</DialogDescription>
          ) : (
            <VisuallyHidden><DialogDescription>Presetup package configuration</DialogDescription></VisuallyHidden>
          )}
        </DialogHeader>
        <DialogBody>
          {/* Loading */}
          {phase === 'loading' && (
            <div className="flex flex-col items-center py-8 gap-3">
              <Loader2 className="h-8 w-8 text-primary animate-spin" />
              <p className="text-xs text-muted-foreground">Loading available packages...</p>
            </div>
          )}

          {/* Template selection grid */}
          {phase === 'template-selection' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {templates.map((t) => (
                <PresetupTemplateCard
                  key={t.slug}
                  template={t}
                  onSelect={selectTemplate}
                />
              ))}
            </div>
          )}

          {/* Wizard */}
          {phase === 'wizard' && selectedTemplate && (
            <PresetupWizard
              template={selectedTemplate}
              onComplete={(wizardAnswers) => {
                // Merge wizard answers into store
                Object.entries(wizardAnswers).forEach(([qId, val]) => setAnswer(qId, val))
                usePresetupStore.setState({ answers: wizardAnswers })
                proceedAfterWizard()
              }}
              onBack={() => {
                usePresetupStore.setState({
                  phase: 'template-selection',
                  selectedTemplate: null,
                  answers: {}
                })
              }}
            />
          )}

          {/* Connect integrations */}
          {phase === 'connect-integrations' && selectedTemplate && (
            <PresetupConnectIntegrations
              integrationKeys={collectIntegrationKeys(selectedTemplate, answers)}
              templateName={selectedTemplate.name}
              tenantId={currentTenant?.id || ''}
              onComplete={proceedAfterIntegrations}
              onBack={() => {
                const hasQuestions = selectedTemplate.definition.questions.length > 0
                usePresetupStore.setState({
                  phase: hasQuestions ? 'wizard' : 'template-selection'
                })
              }}
            />
          )}

          {/* Provisioning / Complete / Error */}
          {(phase === 'provisioning' || phase === 'complete') && selectedTemplate && (
            <PresetupProvisioningState
              templateName={selectedTemplate.name}
              phase={phase}
              error={error}
              provisionResult={provisionResult}
              onRetry={submitProvision}
              onDismiss={handleDismiss}
              onComplete={handleComplete}
            />
          )}

          {/* Error — can happen with or without a selected template (e.g. API unreachable) */}
          {phase === 'error' && (
            <PresetupProvisioningState
              templateName={selectedTemplate?.name || 'Package'}
              phase="error"
              error={error}
              provisionResult={provisionResult}
              onRetry={selectedTemplate ? submitProvision : checkAndStart}
              onDismiss={handleDismiss}
              onComplete={handleComplete}
            />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
