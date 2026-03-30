import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/Button'
import { presetupApi } from '@/lib/presetup-api'
import type { PresetupTemplate, TemplateStatus } from '@/lib/presetup-api'
import { getTemplateIcon } from '@/components/presetup/icon-map'
import {
  Loader2,
  Workflow,
  Plug,
  Sparkles,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Package
} from 'lucide-react'

export interface PresetListProps {
  onSelectTemplate: (template: PresetupTemplate) => void
  /** Render a collapsible section header with hide/show toggle (default: true) */
  collapsible?: boolean
  /** Section title (default: "Setup Packages") */
  title?: string
}

export function PresetList({
  onSelectTemplate,
  collapsible = true,
  title = 'Setup Packages'
}: PresetListProps) {
  const [templates, setTemplates] = useState<PresetupTemplate[]>([])
  const [statuses, setStatuses] = useState<Map<string, TemplateStatus>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)

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

  // ── Header with collapse toggle ──
  const header = collapsible ? (
    <button
      onClick={() => setCollapsed((c) => !c)}
      className="flex items-center gap-2 mb-3 cursor-pointer hover:opacity-80 transition-opacity"
    >
      {collapsed ? (
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      ) : (
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      )}
      <Package className="h-4 w-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold">{title}</h2>
      {!loading && templates.length > 0 && (
        <span className="text-xs text-muted-foreground">({templates.length})</span>
      )}
    </button>
  ) : null

  if (loading) {
    return (
      <div>
        {header}
        {!collapsed && (
          <div className="flex items-center gap-2 py-4 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading packages...</span>
          </div>
        )}
      </div>
    )
  }

  if (error) {
    return (
      <div>
        {header}
        {!collapsed && (
          <div className="flex items-center gap-2 py-3 px-3 rounded-md bg-destructive/10 border border-destructive/20">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
            <span className="text-sm text-destructive">{error}</span>
            <Button variant="ghost" size="sm" onClick={loadPresets} className="ml-auto text-xs">
              Retry
            </Button>
          </div>
        )}
      </div>
    )
  }

  if (templates.length === 0) {
    return (
      <div>
        {header}
        {!collapsed && (
          <p className="text-sm text-muted-foreground py-2">
            No setup packages available for your organization.
          </p>
        )}
      </div>
    )
  }

  return (
    <div>
      {header}
      {!collapsed && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {templates.map((template) => {
            const status = statuses.get(template.slug)
            const isInstalled = status?.isProvisioned ?? false
            const Icon = getTemplateIcon(template.icon)
            const { workflows, integrations, skills } = template.definition

            return (
              <div
                key={template.slug}
                className={`rounded-lg border p-4 transition-all ${
                  isInstalled
                    ? 'border-green-500/30 bg-[#161b22]'
                    : 'border-border/50 bg-[#161b22] cursor-pointer hover:border-border hover:bg-[#1c2129]'
                } group`}
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
                  <div className={`rounded-md p-2 shrink-0 ${
                    isInstalled ? 'bg-green-500/10' : 'bg-primary/10'
                  }`}>
                    <Icon className={`h-5 w-5 ${isInstalled ? 'text-green-500' : 'text-primary'}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium truncate">{template.name}</h3>
                      {isInstalled && <div className="h-2 w-2 rounded-full bg-green-500 shrink-0" />}
                    </div>
                    {template.description && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{template.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                      {workflows.length > 0 && (
                        <span className="inline-flex items-center gap-0.5">
                          <Workflow className="h-3 w-3" />
                          {workflows.length}
                        </span>
                      )}
                      {integrations.length > 0 && (
                        <span className="inline-flex items-center gap-0.5">
                          <Plug className="h-3 w-3" />
                          {integrations.length}
                        </span>
                      )}
                      {skills.length > 0 && (
                        <span className="inline-flex items-center gap-0.5">
                          <Sparkles className="h-3 w-3" />
                          {skills.length}
                        </span>
                      )}
                      {isInstalled && <span>Installed</span>}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
