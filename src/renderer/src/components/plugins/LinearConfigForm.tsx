import { useState, useEffect, useCallback } from 'react'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { OAuthDialog } from '@/components/oauth/OAuthDialog'
import { oauthApi } from '@/lib/oauth-api'
import type { PluginFormProps } from './PluginFormProps'

export function LinearConfigForm({ value, onChange, sourceId, onRequestSave }: PluginFormProps) {
  const [showOAuthDialog, setShowOAuthDialog] = useState(false)
  const [oauthConnected, setOauthConnected] = useState(false)

  const updateField = useCallback(
    (key: string, val: unknown) => {
      onChange({ ...value, [key]: val })
    },
    [value, onChange]
  )

  // Check if OAuth token exists
  useEffect(() => {
    if (sourceId && window.electronAPI?.oauth) {
      oauthApi
        .getValidToken(sourceId)
        .then((token) => {
          setOauthConnected(!!token)
        })
        .catch(() => {
          setOauthConnected(false)
        })
    }
  }, [sourceId])

  const handleOAuthSuccess = async () => {
    setShowOAuthDialog(false)

    if (sourceId && window.electronAPI?.oauth) {
      try {
        const token = await oauthApi.getValidToken(sourceId)
        setOauthConnected(!!token)
      } catch {
        setOauthConnected(false)
      }
    }
  }

  const hasCredentials = value.client_id && value.client_secret
  const canStartOAuth = hasCredentials

  return (
    <>
      <div className="space-y-3">
        {/* OAuth Setup Link */}
        <div className="space-y-1.5">
          <Label>OAuth Setup</Label>
          <p className="text-xs text-muted-foreground">
            👉 Create OAuth app at{' '}
            <button
              type="button"
              onClick={() =>
                window.electronAPI.shell.openExternal('https://linear.app/settings/api/applications/new')
              }
              className="text-primary hover:underline"
            >
              linear.app/settings/api
            </button>
            . Set redirect URI to: <code className="text-xs bg-muted px-1 rounded">nuanu://oauth/callback</code>
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
            placeholder="Enter your Linear OAuth Client ID"
            required
          />
          <p className="text-xs text-muted-foreground">
            Copy from your Linear OAuth application
          </p>
        </div>

        {/* Client Secret */}
        <div className="space-y-1.5">
          <Label htmlFor="client_secret">OAuth Client Secret</Label>
          <Input
            id="client_secret"
            type="password"
            value={(value.client_secret as string) ?? ''}
            onChange={(e) => updateField('client_secret', e.target.value)}
            placeholder="Enter your Linear OAuth Client Secret"
            required
          />
          <p className="text-xs text-muted-foreground">Stored securely (encrypted)</p>
        </div>

        {/* Permissions/Scope */}
        <div className="space-y-1.5">
          <Label htmlFor="scope">Permissions</Label>
          <select
            id="scope"
            value={(value.scope as string) ?? 'read,write'}
            onChange={(e) => updateField('scope', e.target.value)}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
            <option value="read,write">Read + Write</option>
            <option value="read,write,issues:create">Read + Write + Create Issues</option>
            <option value="read,write,issues:create,comments:create">All Permissions</option>
          </select>
          <p className="text-xs text-muted-foreground">OAuth scopes for Linear API access</p>
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
            {oauthConnected ? '✓ Connected to Linear' : 'Connect to Linear'}
          </Button>
          {!sourceId && !hasCredentials && (
            <p className="text-xs text-muted-foreground">
              ℹ️ Fill in Client ID and Client Secret above to continue
            </p>
          )}
          {!sourceId && hasCredentials ? (
            <p className="text-xs text-muted-foreground">
              ℹ️ Click to save source and start OAuth flow
            </p>
          ) : null}
        </div>
      </div>

      {/* OAuth Dialog */}
      {sourceId && showOAuthDialog && (
        <OAuthDialog
          open={showOAuthDialog}
          provider="linear"
          config={value}
          sourceId={sourceId}
          onSuccess={handleOAuthSuccess}
          onCancel={() => setShowOAuthDialog(false)}
        />
      )}
    </>
  )
}
