import { useEffect, useState, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { pluginApi } from '@/lib/ipc-client'
import { oauthApi } from '@/lib/oauth-api'
import { OAuthDialog } from '@/components/oauth/OAuthDialog'
import type { ConfigFieldSchema, ConfigFieldOption } from '@/types'

interface PluginConfigFormProps {
  pluginId: string
  mcpServerId?: string
  sourceId?: string
  value: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
}

export function PluginConfigForm({ pluginId, mcpServerId, sourceId, value, onChange }: PluginConfigFormProps) {
  const [schema, setSchema] = useState<ConfigFieldSchema[]>([])
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, ConfigFieldOption[]>>({})
  const [showOAuthDialog, setShowOAuthDialog] = useState(false)
  const [oauthConnected, setOauthConnected] = useState(false)

  // Check if this plugin requires OAuth
  const requiresOAuth = pluginId === 'linear'

  useEffect(() => {
    pluginApi.getConfigSchema(pluginId).then(setSchema)
  }, [pluginId])

  // Check if OAuth token exists when editing an existing source
  useEffect(() => {
    if (requiresOAuth && sourceId && window.electronAPI?.oauth) {
      oauthApi.getValidToken(sourceId).then((token) => {
        if (token) {
          setOauthConnected(true)
        }
      }).catch(() => {
        // Token doesn't exist or expired
        setOauthConnected(false)
      })
    }
  }, [requiresOAuth, sourceId])

  // Resolve dynamic-select options
  const resolveDynamicOptions = useCallback(() => {
    const dynamicFields = schema.filter((f) => f.type === 'dynamic-select' && f.optionsResolver)
    for (const field of dynamicFields) {
      pluginApi
        .resolveOptions(pluginId, field.optionsResolver!, value, mcpServerId, sourceId)
        .then((options) => {
          setDynamicOptions((prev) => ({ ...prev, [field.key]: options }))
        })
    }
  }, [schema, pluginId, mcpServerId, sourceId, value])

  useEffect(() => {
    resolveDynamicOptions()
  }, [resolveDynamicOptions])

  const updateField = useCallback(
    (key: string, val: unknown) => {
      onChange({ ...value, [key]: val })
    },
    [value, onChange]
  )

  const isVisible = (field: ConfigFieldSchema): boolean => {
    if (!field.dependsOn) return true
    const depVal = value[field.dependsOn.field]
    if (field.dependsOn.value === '__any__') return depVal != null && depVal !== ''
    return depVal === field.dependsOn.value
  }

  const handleOAuthSuccess = async () => {
    setShowOAuthDialog(false)

    // Verify token actually exists before marking as connected
    if (sourceId && window.electronAPI?.oauth) {
      try {
        const token = await oauthApi.getValidToken(sourceId)
        setOauthConnected(!!token)
      } catch {
        setOauthConnected(false)
      }
    }

    // Refresh dynamic options (teams dropdown) after OAuth completes
    setTimeout(() => {
      resolveDynamicOptions()
    }, 100)
  }

  const canStartOAuth = requiresOAuth && value.client_id && value.client_secret && sourceId

  const shouldShowField = (field: ConfigFieldSchema): boolean => {
    // For Linear plugin, hide teams field until OAuth is connected
    if (requiresOAuth && field.key === 'team_ids' && !oauthConnected) {
      return false
    }
    return true
  }

  if (schema.length === 0) return null

  // Find setup link field (if any)
  const setupLinkField = schema.find(f => f.key.startsWith('_') && f.placeholder?.startsWith('http'))

  return (
    <>
      <div className="space-y-3">
        {/* Render setup link first if it exists */}
        {setupLinkField && (
          <div className="space-y-1.5">
            <Label>{setupLinkField.label}</Label>
            {setupLinkField.description && (
              <p className="text-xs text-muted-foreground">{setupLinkField.description}</p>
            )}
            {renderField(setupLinkField, value[setupLinkField.key] ?? setupLinkField.default, updateField, dynamicOptions[setupLinkField.key], resolveDynamicOptions)}
          </div>
        )}

        {/* Render regular fields */}
        {schema
          .filter(isVisible)
          .filter(shouldShowField)
          .filter(field => !field.key.startsWith('_')) // Hide helper fields
          .map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label>{field.label}</Label>
              {field.description && (
                <p className="text-xs text-muted-foreground">{field.description}</p>
              )}
              {renderField(field, value[field.key] ?? field.default, updateField, dynamicOptions[field.key], resolveDynamicOptions)}
            </div>
          ))}

        {/* OAuth Connect Button */}
        {requiresOAuth && (
          <div className="space-y-1.5 pt-2">
            <Button
              type="button"
              onClick={() => setShowOAuthDialog(true)}
              disabled={!canStartOAuth}
              variant={oauthConnected ? 'outline' : 'default'}
              className="w-full"
            >
              {oauthConnected ? '✓ Connected to Linear' : 'Connect to Linear'}
            </Button>
            {!sourceId && (
              <p className="text-xs text-muted-foreground">
                ℹ️ Save the source first, then click to authenticate
              </p>
            )}
            {sourceId && !canStartOAuth && (
              <p className="text-xs text-muted-foreground">
                ℹ️ Fill in Client ID and Client Secret above to continue
              </p>
            )}
          </div>
        )}
      </div>

      {/* OAuth Dialog */}
      {requiresOAuth && sourceId && showOAuthDialog && (
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

function renderField(
  field: ConfigFieldSchema,
  currentValue: unknown,
  onChange: (key: string, val: unknown) => void,
  resolvedOptions?: ConfigFieldOption[],
  onRefresh?: () => void
) {
  // Special handling for setup link fields (fields starting with _)
  if (field.key.startsWith('_') && field.placeholder?.startsWith('http')) {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => window.electronAPI.shell.openExternal(field.placeholder!)}
        className="w-full justify-start gap-2"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
        Create Linear OAuth App
      </Button>
    )
  }

  switch (field.type) {
    case 'text':
    case 'password':
      return (
        <Input
          type={field.type === 'password' ? 'password' : 'text'}
          value={(currentValue as string) ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          placeholder={field.placeholder}
          required={field.required}
        />
      )

    case 'number':
      return (
        <Input
          type="number"
          value={currentValue != null ? String(currentValue) : ''}
          onChange={(e) => onChange(field.key, e.target.value ? Number(e.target.value) : undefined)}
          placeholder={field.placeholder}
          required={field.required}
        />
      )

    case 'checkbox':
      return (
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={!!currentValue}
            onChange={(e) => onChange(field.key, e.target.checked)}
            className="rounded border-input"
          />
          {field.label}
        </label>
      )

    case 'select':
      return (
        <select
          value={(currentValue as string) ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
        >
          {!field.required && <option value="">None</option>}
          {(field.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )

    case 'dynamic-select': {
      const options = resolvedOptions ?? []
      return (
        <div className="flex gap-2">
          <select
            value={(currentValue as string) ?? ''}
            onChange={(e) => onChange(field.key, e.target.value)}
            className="flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
          >
            <option value="">{field.placeholder || 'Select...'}</option>
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {onRefresh && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={onRefresh}
              title="Refresh options"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          )}
        </div>
      )
    }

    case 'key-value': {
      const entries = Object.entries((currentValue as Record<string, string>) ?? {})
      const updateEntry = (oldKey: string, newKey: string, newVal: string) => {
        const next = { ...(currentValue as Record<string, string>) }
        if (oldKey !== newKey) delete next[oldKey]
        next[newKey] = newVal
        onChange(field.key, next)
      }
      const removeEntry = (key: string) => {
        const next = { ...(currentValue as Record<string, string>) }
        delete next[key]
        onChange(field.key, next)
      }
      const addEntry = () => {
        onChange(field.key, { ...(currentValue as Record<string, string>), '': '' })
      }

      return (
        <div className="space-y-1.5">
          {entries.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={k}
                onChange={(e) => updateEntry(k, e.target.value, v)}
                placeholder="key"
                className="flex-1 text-xs h-8"
              />
              <Input
                value={v}
                onChange={(e) => updateEntry(k, k, e.target.value)}
                placeholder="value"
                className="flex-1 text-xs h-8"
              />
              <button
                type="button"
                onClick={() => removeEntry(k)}
                className="text-destructive text-xs px-1"
              >
                x
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addEntry}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            + Add entry
          </button>
        </div>
      )
    }

    default:
      return (
        <Input
          value={(currentValue as string) ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          placeholder={field.placeholder}
        />
      )
  }
}
