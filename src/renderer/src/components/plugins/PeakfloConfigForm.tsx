import { useCallback } from 'react'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import type { PluginFormProps } from './PluginFormProps'

export function PeakfloConfigForm({ value, onChange }: PluginFormProps) {
  const updateField = useCallback(
    (key: string, val: unknown) => {
      onChange({ ...value, [key]: val })
    },
    [value, onChange]
  )

  return (
    <div className="space-y-3">
      {/* API Key */}
      <div className="space-y-1.5">
        <Label htmlFor="api_key">API Key</Label>
        <Input
          id="api_key"
          type="password"
          value={(value.api_key as string) ?? ''}
          onChange={(e) => updateField('api_key', e.target.value)}
          placeholder="Enter your Peakflo API key"
          required
        />
        <p className="text-xs text-muted-foreground">
          Get from your Peakflo dashboard settings
        </p>
      </div>

      {/* Organization ID */}
      <div className="space-y-1.5">
        <Label htmlFor="organization_id">Organization ID</Label>
        <Input
          id="organization_id"
          type="text"
          value={(value.organization_id as string) ?? ''}
          onChange={(e) => updateField('organization_id', e.target.value)}
          placeholder="Enter your organization ID"
        />
        <p className="text-xs text-muted-foreground">Optional: Filter tasks by organization</p>
      </div>
    </div>
  )
}
