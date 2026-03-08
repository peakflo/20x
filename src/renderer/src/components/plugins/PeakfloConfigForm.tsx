import { useCallback } from 'react'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import type { PluginFormProps } from './PluginFormProps'

export function PeakfloConfigForm({ value, onChange }: PluginFormProps) {
  const { isAuthenticated, currentTenant, userEmail } = useEnterpriseStore()
  const isEnterpriseMode = !!(value.enterprise_mode || isAuthenticated)

  const updateField = useCallback(
    (key: string, val: unknown) => {
      onChange({ ...value, [key]: val })
    },
    [value, onChange]
  )

  // ── Enterprise connected mode ────────────────────────────────
  if (isEnterpriseMode && isAuthenticated && currentTenant) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950 p-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-2 w-2 rounded-full bg-green-500" />
            <span className="text-sm font-medium text-green-800 dark:text-green-200">
              Enterprise Connected
            </span>
          </div>
          <div className="space-y-1 text-sm text-green-700 dark:text-green-300">
            <p>
              <span className="font-medium">Organization:</span>{' '}
              {currentTenant.name}
            </p>
            {userEmail && (
              <p>
                <span className="font-medium">Account:</span> {userEmail}
              </p>
            )}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Tasks are synced from your Workflo organization via REST API. No MCP
          server or API key required. Agents, skills, and MCP servers are
          automatically synced from your organization hierarchy.
        </p>
      </div>
    )
  }

  // ── Legacy mode (API key + org ID) ───────────────────────────
  return (
    <div className="space-y-3">
      {isAuthenticated && !currentTenant && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950 p-3">
          <p className="text-xs text-yellow-700 dark:text-yellow-300">
            Enterprise signed in but no organization selected. Select an
            organization in Enterprise settings or configure API key below.
          </p>
        </div>
      )}

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
        <p className="text-xs text-muted-foreground">
          Optional: Filter tasks by organization
        </p>
      </div>
    </div>
  )
}
