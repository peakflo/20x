import { Button } from '@/components/ui/Button'
import { Loader2, CheckCircle2, XCircle, RefreshCw } from 'lucide-react'
import type { ProvisionResult } from '@/lib/presetup-api'

interface PresetupProvisioningStateProps {
  templateName: string
  phase: 'provisioning' | 'complete' | 'error'
  error: string | null
  provisionResult: ProvisionResult | null
  onRetry: () => void
  onDismiss: () => void
  onComplete: () => void
}

export function PresetupProvisioningState({
  templateName,
  phase,
  error,
  provisionResult,
  onRetry,
  onDismiss,
  onComplete
}: PresetupProvisioningStateProps) {
  if (phase === 'provisioning') {
    return (
      <div className="flex flex-col items-center py-8 gap-4">
        <div className="relative">
          <Loader2 className="h-10 w-10 text-primary animate-spin" />
        </div>
        <div className="text-center">
          <h3 className="text-sm font-semibold text-foreground">
            Setting up {templateName}
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Creating workflows, integrations, and skills for your account...
          </p>
        </div>
        {/* Indeterminate progress bar */}
        <div className="w-full max-w-xs h-1 bg-muted rounded-full overflow-hidden">
          <div className="h-full w-1/3 bg-primary rounded-full animate-[indeterminate_1.5s_ease-in-out_infinite]" />
        </div>
      </div>
    )
  }

  if (phase === 'complete') {
    const resources = provisionResult?.provisionedResources
    return (
      <div className="flex flex-col items-center py-8 gap-4">
        <CheckCircle2 className="h-10 w-10 text-emerald-400" />
        <div className="text-center">
          <h3 className="text-sm font-semibold text-foreground">
            {templateName} is ready!
          </h3>
          {resources && (
            <p className="text-xs text-muted-foreground mt-1">
              Created {resources.workflows.length} workflow{resources.workflows.length !== 1 ? 's' : ''},
              {' '}{resources.integrations.length} integration{resources.integrations.length !== 1 ? 's' : ''},
              {' '}and {resources.skills.length} skill{resources.skills.length !== 1 ? 's' : ''}.
            </p>
          )}
        </div>
        <Button size="sm" onClick={onComplete}>
          Done
        </Button>
      </div>
    )
  }

  // Error state
  return (
    <div className="flex flex-col items-center py-8 gap-4">
      <XCircle className="h-10 w-10 text-red-400" />
      <div className="text-center">
        <h3 className="text-sm font-semibold text-foreground">
          Setup failed
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          {error || 'Something went wrong while setting up the package.'}
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onDismiss}>
          Skip for now
        </Button>
        <Button size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Try again
        </Button>
      </div>
    </div>
  )
}
