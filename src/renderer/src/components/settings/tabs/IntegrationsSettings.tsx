import { useState, useEffect } from 'react'
import { Plus, Loader2, RefreshCw, Edit3, Trash2, CheckCircle, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SettingsSection } from '../SettingsSection'
import { TaskSourceFormDialog } from '../forms/TaskSourceFormDialog'
import { useMcpStore } from '@/stores/mcp-store'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { useTaskStore } from '@/stores/task-store'
import { pluginApi } from '@/lib/ipc-client'
import type { CreateTaskSourceDTO, PluginMeta, TaskSource } from '@/types'

export function IntegrationsSettings() {
  const { servers: mcpServers } = useMcpStore()
  const { sources, syncingIds, createSource, updateSource, deleteSource, syncSource } = useTaskSourceStore()
  const { fetchTasks } = useTaskStore()
  const [plugins, setPlugins] = useState<PluginMeta[]>([])
  const [tsDialog, setTsDialog] = useState<{ open: boolean; source?: TaskSource }>({ open: false })
  const [oauthStatus, setOauthStatus] = useState<Map<string, boolean>>(new Map())

  // Check if there are any plugins that don't require MCP servers (like Linear, HubSpot)
  const hasStandalonePlugins = plugins.some((p) => !p.requiresMcpServer)
  const canAddSource = mcpServers.length > 0 || hasStandalonePlugins

  useEffect(() => {
    const loadPlugins = async () => {
      const p = await pluginApi.list()
      setPlugins(p)
    }
    loadPlugins()
  }, [])

  useEffect(() => {
    checkOAuthStatus()
  }, [sources.length, plugins.length])

  const checkOAuthStatus = async () => {
    if (sources.length > 0 && window.electronAPI?.oauth) {
      const statusMap = new Map<string, boolean>()
      for (const source of sources) {
        const plugin = plugins.find((p) => p.id === source.plugin_id)
        // Check OAuth status for plugins that support OAuth (Linear, HubSpot with OAuth)
        if (plugin?.id === 'linear' || (plugin?.id === 'hubspot' && source.config.auth_type === 'oauth')) {
          try {
            const token = await window.electronAPI.oauth.getValidToken(source.id)
            statusMap.set(source.id, !!token)
          } catch {
            statusMap.set(source.id, false)
          }
        }
      }
      setOauthStatus(statusMap)
    }
  }

  const handleCreateSource = async (data: CreateTaskSourceDTO) => {
    await createSource(data)
    setTsDialog({ open: false })
    await checkOAuthStatus()
  }

  const handleUpdateSource = async (data: CreateTaskSourceDTO) => {
    if (tsDialog.source) {
      await updateSource(tsDialog.source.id, {
        name: data.name,
        plugin_id: data.plugin_id,
        config: data.config,
        mcp_server_id: data.mcp_server_id || undefined
      })
      setTsDialog({ open: false })
      await checkOAuthStatus()
    }
  }

  const handleDeleteSource = async (id: string) => {
    if (confirm('Delete this task source? Imported tasks will remain but lose their source link.')) {
      await deleteSource(id)
    }
  }

  const handleSyncSource = async (sourceId: string) => {
    await syncSource(sourceId)
    await fetchTasks()
  }

  return (
    <>
      <SettingsSection
        title="Task Sources"
        description="Connect external task management systems to import and sync tasks"
      >
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {sources.length} source{sources.length !== 1 ? 's' : ''} configured
          </p>
          {canAddSource && (
            <Button size="sm" onClick={() => setTsDialog({ open: true })}>
              <Plus className="h-3.5 w-3.5" />
              Add Source
            </Button>
          )}
        </div>

        {sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border rounded-lg">
            <p className="text-sm text-muted-foreground mb-3">
              {!canAddSource
                ? 'No plugins available. This is unusual - please restart the app.'
                : 'No task sources configured yet'}
            </p>
            {canAddSource && (
              <Button size="sm" onClick={() => setTsDialog({ open: true })}>
                <Plus className="h-3.5 w-3.5" />
                Add Your First Source
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {sources.map((source) => {
              const plugin = plugins.find((p) => p.id === source.plugin_id)
              const requiresOAuth = plugin?.id === 'linear' || (plugin?.id === 'hubspot' && source.config.auth_type === 'oauth')
              const oauthConnected = requiresOAuth ? (oauthStatus.get(source.id) ?? false) : true
              const isConnected = source.enabled && (!requiresOAuth || oauthConnected)

              return (
                <div key={source.id} className="rounded-lg border border-border bg-card overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${
                      isConnected ? 'bg-primary' : 'bg-muted/50'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{source.name}</span>
                        <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                          {plugin?.displayName ?? source.plugin_id}
                        </span>
                        {requiresOAuth && (
                          <span className="flex items-center gap-1 text-[10px]">
                            {oauthConnected ? (
                              <>
                                <CheckCircle className="h-3 w-3 text-primary" />
                                <span className="text-primary">OAuth Connected</span>
                              </>
                            ) : (
                              <>
                                <XCircle className="h-3 w-3 text-destructive" />
                                <span className="text-destructive">OAuth Required</span>
                              </>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {plugin?.requiresMcpServer &&
                          (mcpServers.find((s) => s.id === source.mcp_server_id)?.name ?? 'Unknown')}
                        {source.last_synced_at && (
                          <span className="text-foreground/60">
                            {plugin?.requiresMcpServer && ' · '}
                            Synced {new Date(source.last_synced_at).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleSyncSource(source.id)}
                        disabled={syncingIds.has(source.id)}
                        title="Sync now"
                      >
                        {syncingIds.has(source.id) ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setTsDialog({ open: true, source })}
                        title="Edit"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteSource(source.id)}
                        className="text-destructive hover:text-destructive"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>

      <TaskSourceFormDialog
        source={tsDialog.source}
        mcpServers={mcpServers}
        plugins={plugins}
        open={tsDialog.open}
        onClose={() => setTsDialog({ open: false })}
        onSubmit={tsDialog.source ? handleUpdateSource : handleCreateSource}
      />
    </>
  )
}
