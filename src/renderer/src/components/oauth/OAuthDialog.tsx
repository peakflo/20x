import { useState, useEffect, useCallback, useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { oauthApi } from '@/lib/oauth-api'

interface OAuthDialogProps {
  open: boolean
  provider: string
  config: Record<string, unknown>
  sourceId: string
  onSuccess: () => void
  onCancel: () => void
}

type FlowState = 'waiting' | 'success' | 'error'

export function OAuthDialog({ open, provider, config, sourceId, onSuccess, onCancel }: OAuthDialogProps) {
  const [state, setState] = useState<FlowState>('waiting')
  const [error, setError] = useState<string | null>(null)
  const flowStartedRef = useRef(false)

  const startOAuthFlow = useCallback(async () => {
    if (flowStartedRef.current) return // Prevent duplicate calls
    flowStartedRef.current = true

    try {
      setState('waiting')
      setError(null)

      // HubSpot uses localhost redirect (entire flow handled in main process)
      if (provider === 'hubspot') {
        await oauthApi.startLocalhostFlow(provider, config, sourceId)
        setState('success')
        // Auto-close after success
        setTimeout(() => {
          onSuccess()
        }, 1000)
        return
      }

      // Linear uses custom URL scheme (nuanu://)
      const authUrl = await oauthApi.startFlow(provider, config)
      await window.electronAPI.shell.openExternal(authUrl)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to start OAuth flow'
      setError(errorMsg)
      setState('error')
      flowStartedRef.current = false
    }
  }, [provider, config, sourceId, onSuccess])

  // Auto-start OAuth flow when dialog opens (only once)
  useEffect(() => {
    if (open) {
      startOAuthFlow()
    } else {
      // Reset state when dialog closes
      setState('waiting')
      setError(null)
      flowStartedRef.current = false
    }
  }, [open, startOAuthFlow])

  useEffect(() => {
    if (!open) return

    // Listen for OAuth callback from main process
    const unlisten = window.electronAPI.onOAuthCallback(async ({ code, state: oauthState }) => {
      try {
        setState('waiting')
        await oauthApi.exchangeCode(provider, code, oauthState, sourceId)
        setState('success')

        // Auto-close after success
        setTimeout(() => {
          onSuccess()
        }, 1000)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Authentication failed'
        setError(errorMsg)
        setState('error')
      }
    })

    return unlisten
  }, [open, provider, sourceId, onSuccess])

  const providerDisplayName =
    provider === 'linear' ? 'Linear' :
    provider === 'hubspot' ? 'HubSpot' :
    provider

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect to {providerDisplayName}</DialogTitle>
          <DialogDescription>
            Authorize pf-desktop to access your {providerDisplayName} workspace
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {state === 'waiting' && (
            <>
              <div className="flex flex-col gap-2 items-center py-4">
                <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-muted-foreground text-center">
                  Waiting for authorization... Complete the OAuth flow in your browser.
                </p>
              </div>
              <Button onClick={onCancel} variant="outline" className="w-full">
                Cancel
              </Button>
            </>
          )}

          {state === 'success' && (
            <div className="flex flex-col gap-2 items-center py-4">
              <div className="h-12 w-12 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <svg className="h-6 w-6 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm text-foreground font-medium">
                Successfully connected to {providerDisplayName}!
              </p>
            </div>
          )}

          {state === 'error' && (
            <>
              <div className="flex flex-col gap-2 items-center py-4">
                <div className="h-12 w-12 rounded-full bg-destructive/20 flex items-center justify-center">
                  <svg className="h-6 w-6 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <p className="text-sm text-destructive font-medium">Authentication failed</p>
                <p className="text-xs text-muted-foreground text-center">{error}</p>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => {
                  flowStartedRef.current = false
                  startOAuthFlow()
                }} className="flex-1">
                  Retry
                </Button>
                <Button onClick={onCancel} variant="outline">
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
