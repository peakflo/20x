import { useState, useCallback } from 'react'
import { ExternalLink, Plug, CheckCircle2, ArrowRight, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/Button'

interface PresetupConnectIntegrationsProps {
  integrationKeys: string[]
  templateName: string
  tenantId: string
  onComplete: () => void
  onBack: () => void
}

/** Map integration keys to human-readable names */
const INTEGRATION_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  slack: 'Slack',
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  xero: 'Xero',
  quickbooks: 'QuickBooks',
  linkedin: 'LinkedIn'
}

/**
 * Derive the workflow-builder UI URL from the API URL.
 * local:      http://localhost:2000 → http://localhost:4000
 * stage:      https://stage-api.peakflo.ai → https://stage-app.peakflo.ai
 * production: https://api.peakflo.ai → https://app.peakflo.ai
 */
function apiUrlToUiUrl(apiUrl: string): string {
  if (apiUrl.includes('localhost:2000')) {
    return 'http://localhost:4000'
  }
  if (apiUrl.includes('stage-api.peakflo.ai')) {
    return 'https://stage-app.peakflo.ai'
  }
  if (apiUrl.includes('api.peakflo.ai')) {
    return 'https://app.peakflo.ai'
  }
  // Fallback: try replacing port or api prefix
  return apiUrl.replace(':2000', ':4000').replace('://api.', '://app.')
}

export function PresetupConnectIntegrations({
  integrationKeys,
  templateName,
  tenantId,
  onComplete,
  onBack
}: PresetupConnectIntegrationsProps) {
  const [opening, setOpening] = useState(false)
  const [opened, setOpened] = useState(false)

  const handleOpenBrowser = useCallback(async () => {
    setOpening(true)
    try {
      const tokens = await window.electronAPI.enterprise.getSupabaseTokens()

      if (!tokens.accessToken || !tokens.refreshToken) {
        console.error('[Presetup] No Supabase tokens available')
        // Still try to open — user can login manually
      }

      const uiUrl = apiUrlToUiUrl(tokens.apiUrl)
      const integrationsParam = integrationKeys.join(',')

      // Build URL with tokens in hash fragment (never sent to server)
      let url = `${uiUrl}/presetup/connect?integrations=${encodeURIComponent(integrationsParam)}&tenantId=${encodeURIComponent(tenantId)}`

      if (tokens.accessToken && tokens.refreshToken) {
        url += `#access_token=${encodeURIComponent(tokens.accessToken)}&refresh_token=${encodeURIComponent(tokens.refreshToken)}`
      }

      // Open in default browser
      window.open(url, '_blank')
      setOpened(true)
    } catch (err) {
      console.error('[Presetup] Failed to open browser:', err)
    } finally {
      setOpening(false)
    }
  }, [integrationKeys])

  return (
    <div className="space-y-5">
      <div className="text-center space-y-2">
        <div className="flex justify-center mb-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Plug className="h-6 w-6 text-primary" />
          </div>
        </div>
        <h3 className="text-lg font-semibold">Connect your integrations</h3>
        <p className="text-sm text-muted-foreground">
          {templateName} requires the following integrations. Click the button below to connect them in your browser.
        </p>
      </div>

      {/* List of integrations */}
      <div className="space-y-2">
        {integrationKeys.map((key) => (
          <div
            key={key}
            className="flex items-center gap-3 rounded-lg border p-3"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
              <Plug className="h-4 w-4" />
            </div>
            <span className="text-sm font-medium">
              {INTEGRATION_NAMES[key] || key}
            </span>
          </div>
        ))}
      </div>

      {/* Open browser button */}
      <Button
        className="w-full rounded-xl"
        onClick={handleOpenBrowser}
        disabled={opening}
      >
        <ExternalLink className="mr-2 h-4 w-4" />
        {opening ? 'Opening browser…' : 'Connect integrations in browser'}
      </Button>

      {opened && (
        <div className="flex items-center gap-2 rounded-lg border-2 border-green-200 bg-green-50/50 p-3 dark:border-green-800 dark:bg-green-900/20">
          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
          <p className="text-sm text-green-700 dark:text-green-300">
            A browser tab has been opened. Connect your integrations there, then click Continue below.
          </p>
        </div>
      )}

      {/* Navigation */}
      <div className="flex gap-3">
        <Button
          variant="outline"
          onClick={onBack}
          className="flex-1 rounded-xl"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button
          onClick={onComplete}
          className="flex-1 rounded-xl"
          disabled={!opened}
        >
          Continue
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
