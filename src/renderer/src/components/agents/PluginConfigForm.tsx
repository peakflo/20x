import { useEffect, useState, useCallback } from 'react'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { pluginApi } from '@/lib/ipc-client'
import type { ConfigFieldSchema, ConfigFieldOption } from '@/types'

interface PluginConfigFormProps {
  pluginId: string
  mcpServerId?: string
  value: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
}

export function PluginConfigForm({ pluginId, mcpServerId, value, onChange }: PluginConfigFormProps) {
  const [schema, setSchema] = useState<ConfigFieldSchema[]>([])
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, ConfigFieldOption[]>>({})

  useEffect(() => {
    pluginApi.getConfigSchema(pluginId).then(setSchema)
  }, [pluginId])

  // Resolve dynamic-select options
  useEffect(() => {
    const dynamicFields = schema.filter((f) => f.type === 'dynamic-select' && f.optionsResolver)
    for (const field of dynamicFields) {
      pluginApi
        .resolveOptions(pluginId, field.optionsResolver!, value, mcpServerId)
        .then((options) => {
          setDynamicOptions((prev) => ({ ...prev, [field.key]: options }))
        })
    }
  }, [schema, pluginId, mcpServerId])

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

  if (schema.length === 0) return null

  return (
    <div className="space-y-3">
      {schema.filter(isVisible).map((field) => (
        <div key={field.key} className="space-y-1.5">
          <Label>{field.label}</Label>
          {field.description && (
            <p className="text-xs text-muted-foreground">{field.description}</p>
          )}
          {renderField(field, value[field.key] ?? field.default, updateField, dynamicOptions[field.key])}
        </div>
      ))}
    </div>
  )
}

function renderField(
  field: ConfigFieldSchema,
  currentValue: unknown,
  onChange: (key: string, val: unknown) => void,
  resolvedOptions?: ConfigFieldOption[]
) {
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
        <select
          value={(currentValue as string) ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
        >
          <option value="">{field.placeholder || 'Select...'}</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
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
