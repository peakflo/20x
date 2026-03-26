import { useState, useEffect, useCallback } from 'react'
import { api } from '../api/client'
import type { Route } from '../App'

interface TaskSource {
  id: string
  name: string
  plugin_id: string
  config: Record<string, unknown>
  enabled: boolean
  last_synced_at: string | null
}

interface PluginMeta {
  id: string
  displayName: string
  description: string
  icon: string
  requiresMcpServer: boolean
}

interface SettingsPageProps {
  onNavigate: (route: Route) => void
}

export function SettingsPage({ onNavigate }: SettingsPageProps) {
  const [sources, setSources] = useState<TaskSource[]>([])
  const [plugins, setPlugins] = useState<PluginMeta[]>([])
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      const [sourcesData, pluginsData] = await Promise.all([
        api.taskSources.list(),
        api.plugins.list()
      ])
      setSources(sourcesData as TaskSource[])
      setPlugins(pluginsData)
    } catch (err) {
      console.error('Failed to load settings data:', err)
    }
  }

  const handleSync = useCallback(async (sourceId: string) => {
    setSyncingIds((prev) => new Set(prev).add(sourceId))
    try {
      await api.taskSources.sync(sourceId)
      await loadData()
    } catch (err) {
      console.error('Sync failed:', err)
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev)
        next.delete(sourceId)
        return next
      })
    }
  }, [])

  const handleSyncAll = useCallback(async () => {
    setSyncingIds(new Set(sources.map((s) => s.id)))
    try {
      await api.taskSources.syncAll()
      await loadData()
    } catch (err) {
      console.error('Sync all failed:', err)
    } finally {
      setSyncingIds(new Set())
    }
  }, [sources])

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/30 shrink-0">
        <button
          onClick={() => onNavigate({ page: 'list' })}
          className="flex items-center gap-1 text-sm text-muted-foreground"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <h1 className="text-sm font-semibold">Settings</h1>
        <div className="w-12" />
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Task Sources Section */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground">Task Sources</h2>
            <div className="flex items-center gap-2">
              {sources.length > 0 && (
                <button
                  onClick={handleSyncAll}
                  disabled={syncingIds.size > 0}
                  className="text-xs text-primary hover:text-primary/80 disabled:opacity-50"
                >
                  Sync All
                </button>
              )}
            </div>
          </div>

          {sources.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border/50 rounded-lg">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground mb-2">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
              <p className="text-sm text-muted-foreground mb-1">No task sources configured</p>
              <p className="text-xs text-muted-foreground/60">
                Add task sources from the desktop app
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {sources.map((source) => {
                const plugin = plugins.find((p) => p.id === source.plugin_id)
                const isSyncing = syncingIds.has(source.id)

                return (
                  <div key={source.id} className="rounded-lg border border-border/50 bg-card overflow-hidden">
                    <div className="flex items-center gap-3 px-3 py-3">
                      {/* Status dot */}
                      <span className={`h-2 w-2 rounded-full shrink-0 ${source.enabled ? 'bg-green-500' : 'bg-muted/50'}`} />

                      {/* Source info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm truncate">{source.name}</span>
                          <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded shrink-0">
                            {plugin?.displayName ?? source.plugin_id}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {source.last_synced_at
                            ? `Synced ${new Date(source.last_synced_at).toLocaleString()}`
                            : 'Never synced'}
                        </div>
                      </div>

                      {/* Sync button */}
                      <button
                        onClick={() => handleSync(source.id)}
                        disabled={isSyncing}
                        className="shrink-0 p-2 rounded-md hover:bg-accent disabled:opacity-50"
                        title="Sync now"
                      >
                        <svg
                          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                          className={isSyncing ? 'animate-spin' : ''}
                        >
                          <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Available Plugins */}
        {plugins.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-3">Available Integrations</h2>
            <div className="space-y-1.5">
              {plugins.map((plugin) => {
                const isConfigured = sources.some((s) => s.plugin_id === plugin.id)
                return (
                  <div key={plugin.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border/30">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{plugin.displayName}</span>
                        {isConfigured && (
                          <span className="text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">
                            Active
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{plugin.description}</p>
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground/60 mt-2 text-center">
              Configure new sources from the desktop app
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
