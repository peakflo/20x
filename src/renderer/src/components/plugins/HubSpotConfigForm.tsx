import { useState, useEffect, useCallback } from 'react'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { OAuthDialog } from '@/components/oauth/OAuthDialog'
import { oauthApi } from '@/lib/oauth-api'
import { pluginApi } from '@/lib/ipc-client'
import type { PluginFormProps } from './PluginFormProps'
import type { ConfigFieldOption } from '@/types'

export function HubSpotConfigForm({ value, onChange, sourceId, onRequestSave }: PluginFormProps) {
  const [showOAuthDialog, setShowOAuthDialog] = useState(false)
  const [oauthConnected, setOauthConnected] = useState(false)
  const [pipelines, setPipelines] = useState<ConfigFieldOption[]>([])
  const [owners, setOwners] = useState<ConfigFieldOption[]>([])
  const [loadingPipelines, setLoadingPipelines] = useState(false)
  const [loadingOwners, setLoadingOwners] = useState(false)

  // Initialize default auth_type if not set
  useEffect(() => {
    if (value.auth_type === undefined) {
      onChange({ ...value, auth_type: 'oauth' })
    }
  }, [])

  const updateField = useCallback(
    (key: string, val: unknown) => {
      onChange({ ...value, [key]: val })
    },
    [value, onChange]
  )

  // Check if OAuth token exists (only for OAuth auth type)
  useEffect(() => {
    if (value.auth_type === 'oauth' && sourceId && window.electronAPI?.oauth) {
      oauthApi
        .getValidToken(sourceId)
        .then((token) => {
          setOauthConnected(!!token)
        })
        .catch(() => {
          setOauthConnected(false)
        })
    }
  }, [sourceId, value.auth_type])

  const handleOAuthSuccess = async () => {
    setShowOAuthDialog(false)

    if (sourceId && window.electronAPI?.oauth) {
      try {
        const token = await oauthApi.getValidToken(sourceId)
        setOauthConnected(!!token)
        // Auto-load dropdowns after OAuth success
        fetchPipelines()
        fetchOwners()
      } catch {
        setOauthConnected(false)
      }
    }
  }

  const fetchPipelines = useCallback(async () => {
    if (!sourceId || !oauthConnected) return

    setLoadingPipelines(true)
    try {
      const options = await pluginApi.resolveOptions('hubspot', 'pipelines', value, undefined, sourceId)
      setPipelines(options)
    } catch (err) {
      console.error('Failed to fetch pipelines:', err)
      setPipelines([])
    } finally {
      setLoadingPipelines(false)
    }
  }, [sourceId, oauthConnected, value])

  const fetchOwners = useCallback(async () => {
    if (!sourceId || !oauthConnected) return

    setLoadingOwners(true)
    try {
      const options = await pluginApi.resolveOptions('hubspot', 'owners', value, undefined, sourceId)
      setOwners(options)
    } catch (err) {
      console.error('Failed to fetch owners:', err)
      setOwners([])
    } finally {
      setLoadingOwners(false)
    }
  }, [sourceId, oauthConnected, value])

  // Auto-load dropdowns when OAuth is connected
  useEffect(() => {
    if (oauthConnected && sourceId) {
      fetchPipelines()
      fetchOwners()
    }
  }, [oauthConnected, sourceId])

  const authType = (value.auth_type as string) || 'oauth'
  const isOAuth = authType === 'oauth'
  const hasOAuthCredentials = value.client_id && value.client_secret
  const canStartOAuth = isOAuth && hasOAuthCredentials

  return (
    <>
      <div className="space-y-3">
        {/* Authentication Method */}
        <div className="space-y-1.5">
          <Label htmlFor="auth_type">Authentication Method</Label>
          <select
            id="auth_type"
            value={authType}
            onChange={(e) => updateField('auth_type', e.target.value)}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
          >
            <option value="oauth">OAuth 2.0 (Recommended)</option>
            <option value="private_app">Private App Access Token</option>
          </select>
          <p className="text-xs text-muted-foreground">Choose how to authenticate with HubSpot</p>
        </div>

        {/* OAuth Fields */}
        {isOAuth && (
          <>
            {/* OAuth Setup Link */}
            <div className="space-y-1.5">
              <Label>OAuth Setup</Label>
              <p className="text-xs text-muted-foreground">
                👉 Create OAuth app at{' '}
                <button
                  type="button"
                  onClick={() =>
                    window.electronAPI.shell.openExternal('https://developers.hubspot.com/apps')
                  }
                  className="text-primary hover:underline"
                >
                  developers.hubspot.com/apps
                </button>
                . Set redirect URI to:{' '}
                <code className="text-xs bg-muted px-1 rounded">http://localhost:3000/callback</code> (or
                ports 3000-3010)
              </p>
            </div>

            {/* Client ID */}
            <div className="space-y-1.5">
              <Label htmlFor="client_id">OAuth Client ID</Label>
              <Input
                id="client_id"
                type="text"
                value={(value.client_id as string) ?? ''}
                onChange={(e) => updateField('client_id', e.target.value)}
                placeholder="Enter your HubSpot OAuth Client ID"
              />
              <p className="text-xs text-muted-foreground">Copy from your HubSpot OAuth app Auth tab</p>
            </div>

            {/* Client Secret */}
            <div className="space-y-1.5">
              <Label htmlFor="client_secret">OAuth Client Secret</Label>
              <Input
                id="client_secret"
                type="password"
                value={(value.client_secret as string) ?? ''}
                onChange={(e) => updateField('client_secret', e.target.value)}
                placeholder="Enter your HubSpot OAuth Client Secret"
              />
              <p className="text-xs text-muted-foreground">Stored securely (encrypted)</p>
            </div>

            {/* OAuth Connect Button */}
            <div className="space-y-1.5 pt-2">
              <Button
                type="button"
                onClick={() => {
                  // If no sourceId, auto-save first
                  if (!sourceId && onRequestSave) {
                    const saved = onRequestSave()
                    if (!saved) return
                    return
                  }
                  setShowOAuthDialog(true)
                }}
                disabled={!canStartOAuth}
                variant={oauthConnected ? 'outline' : 'default'}
                className="w-full"
              >
                {oauthConnected ? '✓ Connected to HubSpot' : 'Connect to HubSpot'}
              </Button>
              {!sourceId && !hasOAuthCredentials && (
                <p className="text-xs text-muted-foreground">
                  ℹ️ Fill in Client ID and Client Secret above to continue
                </p>
              )}
              {!sourceId && hasOAuthCredentials ? (
                <p className="text-xs text-muted-foreground">
                  ℹ️ Click to save source and start OAuth flow
                </p>
              ) : null}
            </div>
          </>
        )}

        {/* Private App Fields */}
        {!isOAuth && (
          <div className="space-y-1.5">
            <Label htmlFor="access_token">Private App Access Token</Label>
            <Input
              id="access_token"
              type="password"
              value={(value.access_token as string) ?? ''}
              onChange={(e) => updateField('access_token', e.target.value)}
              placeholder="Enter your Private App token"
            />
            <p className="text-xs text-muted-foreground">
              Get from Settings → Integrations → Private Apps. Requires "tickets",
              "crm.objects.contacts.read", "crm.objects.owners.read", "files", and "forms-uploaded-files" scopes.
            </p>
          </div>
        )}

        {/* Optional Filters */}
        {oauthConnected && (
          <div className="pt-2 border-t border-border">
            <p className="text-xs font-medium text-muted-foreground mb-2">Optional Filters</p>

            {/* Pipeline Filter */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="pipeline_id">Pipeline Filter</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={fetchPipelines}
                  disabled={loadingPipelines}
                  className="h-6 px-2 text-xs"
                >
                  {loadingPipelines ? 'Loading...' : '↻ Refresh'}
                </Button>
              </div>
              <select
                id="pipeline_id"
                value={(value.pipeline_id as string) ?? ''}
                onChange={(e) => updateField('pipeline_id', e.target.value)}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
                disabled={loadingPipelines}
              >
                <option value="">All Pipelines</option>
                {pipelines.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Filter tickets by workflow pipeline
              </p>
            </div>

            {/* Owner Filter */}
            <div className="space-y-1.5 mt-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="owner_id">Owner Filter (Assigned To)</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={fetchOwners}
                  disabled={loadingOwners}
                  className="h-6 px-2 text-xs"
                >
                  {loadingOwners ? 'Loading...' : '↻ Refresh'}
                </Button>
              </div>
              <select
                id="owner_id"
                value={(value.owner_id as string) ?? ''}
                onChange={(e) => updateField('owner_id', e.target.value)}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
                disabled={loadingOwners}
              >
                <option value="">All Owners</option>
                {owners.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Filter tickets by assigned user
              </p>
            </div>
          </div>
        )}
      </div>

      {/* OAuth Dialog */}
      {isOAuth && sourceId && showOAuthDialog && (
        <OAuthDialog
          open={showOAuthDialog}
          provider="hubspot"
          config={value}
          sourceId={sourceId}
          onSuccess={handleOAuthSuccess}
          onCancel={() => setShowOAuthDialog(false)}
        />
      )}
    </>
  )
}
