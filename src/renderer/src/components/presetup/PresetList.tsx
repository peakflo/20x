import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { presetupApi } from '@/lib/presetup-api'
import type { PresetupTemplate, TemplateStatus } from '@/lib/presetup-api'
import { getTemplateIcon } from '@/components/presetup/icon-map'
import {
  Loader2,
  CheckCircle2,
  Workflow,
  Plug,
  Sparkles,
  AlertCircle
} from 'lucide-react'

export interface PresetListProps {
  onSelectTemplate: (template: PresetupTemplate) => void
}

export function PresetList({ onSelectTemplate }: PresetListProps) {
  const [templates, setTemplates] = useState<PresetupTemplate[]>([])
  const [statuses, setStatuses] = useState<Map<string, TemplateStatus>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadPresets = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [allTemplates, statusRes] = await Promise.all([
        presetupApi.listTemplates(),
        presetupApi.getStatus()
      ])

      setTemplates(allTemplates)

      const statusMap = new Map<string, TemplateStatus>()
      for (const ts of statusRes.templates) {
        statusMap.set(ts.slug, ts)
      }
      setStatuses(statusMap)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load packages')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPresets()
  }, [loadPresets])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading packages…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 py-3 px-3 rounded-md bg-destructive/10 border border-destructive/20">
        <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
        <span className="text-sm text-destructive">{error}</span>
        <Button variant="ghost" size="sm" onClick={loadPresets} className="ml-auto text-xs">
          Retry
        </Button>
      </div>
    )
  }

  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-2">
        No setup packages available for your organization.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {templates.map((template) => {
        const status = statuses.get(template.slug)
        const isInstalled = status?.isProvisioned ?? false
        const Icon = getTemplateIcon(template.icon)
        const { workflows, integrations, skills } = template.definition

        return (
          <div
            key={template.slug}
            className={`border rounded-lg p-3 transition-colors ${
              isInstalled
                ? 'border-green-200 bg-green-50/30 dark:border-green-800/50 dark:bg-green-900/10'
                : 'border-border hover:border-primary/50 cursor-pointer'
            }`}
            onClick={!isInstalled ? () => onSelectTemplate(template) : undefined}
            role={!isInstalled ? 'button' : undefined}
            tabIndex={!isInstalled ? 0 : undefined}
            onKeyDown={!isInstalled ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelectTemplate(template)
              }
            } : undefined}
          >
            <div className="flex items-start gap-3">
              {/* Icon */}
              <div className={`h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0 ${
                isInstalled ? 'bg-green-100 dark:bg-green-900/30' : 'bg-primary/10'
              }`}>
                <Icon className={`h-4 w-4 ${isInstalled ? 'text-green-600 dark:text-green-400' : 'text-primary'}`} />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-medium text-foreground truncate">{template.name}</h4>
                  {isInstalled && (
                    <Badge variant="green" className="shrink-0 gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      Installed
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{template.description}</p>

                {/* Resource counts */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {workflows.length > 0 && (
                    <span className="inline-flex items-center text-xs text-muted-foreground">
                      <Workflow className="h-3 w-3 mr-0.5" />
                      {workflows.length}
                    </span>
                  )}
                  {integrations.length > 0 && (
                    <span className="inline-flex items-center text-xs text-muted-foreground">
                      <Plug className="h-3 w-3 mr-0.5" />
                      {integrations.length}
                    </span>
                  )}
                  {skills.length > 0 && (
                    <span className="inline-flex items-center text-xs text-muted-foreground">
                      <Sparkles className="h-3 w-3 mr-0.5" />
                      {skills.length}
                    </span>
                  )}
                </div>
              </div>

              {/* Action */}
              <div className="shrink-0 self-center">
                {!isInstalled && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelectTemplate(template)
                    }}
                  >
                    Install
                  </Button>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
