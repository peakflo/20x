import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'
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
  onRequestSave?: () => boolean // Returns true if save was triggered
}

export function PluginConfigForm({ pluginId, mcpServerId, sourceId, value, onChange, onRequestSave }: PluginConfigFormProps) {
  const [schema, setSchema] = useState<ConfigFieldSchema[]>([])
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, ConfigFieldOption[]>>({})
  const [loadingFields, setLoadingFields] = useState<Set<string>>(new Set())
  const [showOAuthDialog, setShowOAuthDialog] = useState(false)
  const [oauthConnected, setOauthConnected] = useState(false)

  // Check if this plugin requires OAuth
  const requiresOAuth = pluginId === 'linear' || pluginId === 'hubspot'

  useEffect(() => {
    pluginApi.getConfigSchema(pluginId).then((newSchema) => {
      setSchema(newSchema)

      // Initialize default values for fields that have defaults but no current value
      const updates: Record<string, unknown> = {}
      for (const field of newSchema) {
        if (field.default !== undefined && value[field.key] === undefined) {
          updates[field.key] = field.default
        }
      }

      if (Object.keys(updates).length > 0) {
        onChange({ ...value, ...updates })
      }
    })
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
      setLoadingFields((prev) => new Set(prev).add(field.key))
      pluginApi
        .resolveOptions(pluginId, field.optionsResolver!, value, mcpServerId, sourceId)
        .then((options) => {
          setDynamicOptions((prev) => ({ ...prev, [field.key]: options }))
        })
        .finally(() => {
          setLoadingFields((prev) => {
            const next = new Set(prev)
            next.delete(field.key)
            return next
          })
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

  // For HubSpot, show OAuth if auth_type is 'oauth' OR undefined (defaults to oauth)
  const hubspotAuthType = value.auth_type as string | undefined
  const showOAuthButton = pluginId === 'linear' || (pluginId === 'hubspot' && (!hubspotAuthType || hubspotAuthType === 'oauth'))
  const hasCredentials = value.client_id && value.client_secret
  const canStartOAuth = showOAuthButton && hasCredentials

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
            {renderField(setupLinkField, value[setupLinkField.key] ?? setupLinkField.default, updateField, dynamicOptions[setupLinkField.key], resolveDynamicOptions, loadingFields.has(setupLinkField.key))}
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
              {renderField(field, value[field.key] ?? field.default, updateField, dynamicOptions[field.key], resolveDynamicOptions, loadingFields.has(field.key))}
            </div>
          ))}

        {/* OAuth Connect Button */}
        {showOAuthButton && (
          <div className="space-y-1.5 pt-2">
            <Button
              type="button"
              onClick={() => {
                // If no sourceId, try to auto-save first
                if (!sourceId && onRequestSave) {
                  const saved = onRequestSave()
                  if (!saved) {
                    // Can't auto-save, show message
                    return
                  }
                  // Source will be saved and dialog will close, then user reopens to connect
                  return
                }
                // Otherwise, start OAuth flow normally
                setShowOAuthDialog(true)
              }}
              disabled={!canStartOAuth}
              variant={oauthConnected ? 'outline' : 'default'}
              className="w-full"
            >
              {oauthConnected
                ? `✓ Connected to ${pluginId === 'linear' ? 'Linear' : 'HubSpot'}`
                : `Connect to ${pluginId === 'linear' ? 'Linear' : 'HubSpot'}`}
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
            {sourceId && !hasCredentials && (
              <p className="text-xs text-muted-foreground">
                ℹ️ Fill in Client ID and Client Secret above to continue
              </p>
            )}
          </div>
        )}
      </div>

      {/* OAuth Dialog */}
      {showOAuthButton && sourceId && showOAuthDialog && (
        <OAuthDialog
          open={showOAuthDialog}
          provider={pluginId as 'linear' | 'hubspot'}
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
  onRefresh?: () => void,
  isLoading?: boolean
) {
  // Special handling for setup link fields (fields starting with _)
  if (field.key.startsWith('_') && field.placeholder?.startsWith('http')) {
    // Extract provider name from URL (e.g., "hubspot.com" -> "HubSpot")
    const url = field.placeholder
    let providerName = 'OAuth'
    if (url.includes('hubspot.com')) {
      providerName = 'HubSpot'
    } else if (url.includes('linear.app')) {
      providerName = 'Linear'
    }

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
        Create {providerName} OAuth App
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

      if (field.multiSelect) {
        const selected = Array.isArray(currentValue) ? (currentValue as string[]) : []
        const toggleValue = (val: string) => {
          const next = selected.includes(val)
            ? selected.filter((v) => v !== val)
            : [...selected, val]
          onChange(field.key, next)
        }
        return (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {isLoading ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading options...
                  </span>
                ) : (
                  selected.length > 0 ? `${selected.length} selected` : 'None selected'
                )}
              </span>
              {onRefresh && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={onRefresh}
                  title="Refresh options"
                  className="h-7 w-7"
                  disabled={isLoading}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                </Button>
              )}
            </div>
            <div className="max-h-48 overflow-y-auto rounded-md border border-input p-1.5 space-y-0.5">
              {isLoading && options.length === 0 && (
                <div className="flex items-center justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
              {!isLoading && options.length === 0 && (
                <p className="text-xs text-muted-foreground px-2 py-1">No options available</p>
              )}
              {options.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-2 text-sm cursor-pointer rounded px-2 py-1 hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(opt.value)}
                    onChange={() => toggleValue(opt.value)}
                    className="rounded border-input"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
        )
      }

      return (
        <div className="flex gap-2">
          <select
            value={(currentValue as string) ?? ''}
            onChange={(e) => onChange(field.key, e.target.value)}
            className="flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
            disabled={isLoading}
          >
            <option value="">
              {isLoading ? 'Loading...' : (field.placeholder || 'Select...')}
            </option>
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
              disabled={isLoading}
            >
              {isLoading
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RefreshCw className="h-4 w-4" />
              }
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
