import { useState, useEffect, useCallback } from 'react'
import { Plus, Loader2, Wifi, WifiOff, RefreshCw, Edit3, Trash2, KeyRound, Copy } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { SettingsSection } from '../SettingsSection'
import { McpServerFormDialog } from '../forms/McpServerFormDialog'
import { useMcpStore } from '@/stores/mcp-store'
import type { McpServer, CreateMcpServerDTO } from '@/types'
import type { MastermindMcpClient, MastermindMcpStatus } from '@shared/mastermind-mcp'

interface McpConnectionInfo {
  status: 'idle' | 'testing' | 'connected' | 'failed'
  error?: string
  errorDetail?: string
  toolCount?: number
}

interface McpDialogState {
  open: boolean
  server?: McpServer
}

export function ToolsMcpSettings() {
  const {
    servers, fetchServers, createServer, updateServer, deleteServer,
    testConnection: testMcpConnection,
    oauthStatuses, startOAuthFlow, submitManualClientId, revokeOAuthToken,
    fetchAllOAuthStatuses, authRequired, probeForAuth, probeAllForAuth
  } = useMcpStore()
  const [connections, setConnections] = useState<Map<string, McpConnectionInfo>>(new Map())
  const [mcpDialog, setMcpDialog] = useState<McpDialogState>({ open: false })
  const [mastermind, setMastermind] = useState<MastermindMcpStatus>()
  const [mastermindBusy, setMastermindBusy] = useState<string>()
  const [mastermindMessage, setMastermindMessage] = useState<string>()

  const loadMastermind = useCallback(async () => {
    try { setMastermind(await window.electronAPI.mastermindMcp.status()) }
    catch (error) { setMastermindMessage(error instanceof Error ? error.message : 'Could not read 20x MCP status.') }
  }, [])

  useEffect(() => {
    fetchServers()
    void loadMastermind()
  }, [])

  const toggleMastermind = async (enabled: boolean) => {
    setMastermindBusy('toggle'); setMastermindMessage(undefined)
    try { setMastermind(await window.electronAPI.mastermindMcp.setEnabled(enabled)) }
    catch (error) { setMastermindMessage(error instanceof Error ? error.message : 'Could not update 20x MCP.'); await loadMastermind() }
    finally { setMastermindBusy(undefined) }
  }

  const installMastermind = async (client: MastermindMcpClient) => {
    setMastermindBusy(client); setMastermindMessage(undefined)
    try {
      const result = await window.electronAPI.mastermindMcp.install(client)
      setMastermind(result.status)
      setMastermindMessage(result.changedPaths.length ? `Changed ${result.changedPaths.join(', ')}. Restart existing ${client} sessions.${result.backupPaths.length ? ` Backups: ${result.backupPaths.join(', ')}.` : ''}` : `${client} is already current.`)
    } catch (error) { setMastermindMessage(error instanceof Error ? error.message : `Could not install for ${client}.`) }
    finally { setMastermindBusy(undefined) }
  }

  const checkMastermind = async () => {
    setMastermindBusy('check'); setMastermindMessage(undefined)
    try { setMastermind(await window.electronAPI.mastermindMcp.checkSkillVersions()) }
    catch (error) { setMastermindMessage(error instanceof Error ? error.message : 'Could not check skill versions.') }
    finally { setMastermindBusy(undefined) }
  }

  useEffect(() => {
    if (servers.length > 0) {
      servers.forEach((s) => testServerConnection(s))
      fetchAllOAuthStatuses()
      probeAllForAuth()
    }
  }, [servers.length])

  const testServerConnection = async (server: McpServer) => {
    setConnections((prev) => new Map(prev).set(server.id, { status: 'testing' }))

    try {
      const testData = server.type === 'remote'
        ? { id: server.id, name: server.name, type: 'remote' as const, url: server.url, headers: server.headers }
        : { id: server.id, name: server.name, type: 'local' as const, command: server.command, args: server.args, environment: server.environment }

      const result = await testMcpConnection(testData)
      setConnections((prev) => new Map(prev).set(server.id, {
        status: result.status,
        error: result.error,
        errorDetail: result.errorDetail,
        toolCount: result.toolCount
      }))
    } catch (err: unknown) {
      setConnections((prev) => new Map(prev).set(server.id, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Test failed'
      }))
    }
  }

  const handleCreateServer = async (data: CreateMcpServerDTO) => {
    const server = await createServer(data)
    setMcpDialog({ open: false })
    if (server && data.type === 'remote' && data.url) {
      // Probe and auto-start OAuth if needed
      const needed = await probeForAuth(server.id, data.url)
      if (needed) {
        startOAuthFlow(server.id)
      }
    }
  }

  const handleUpdateServer = async (data: CreateMcpServerDTO) => {
    if (mcpDialog.server) {
      await updateServer(mcpDialog.server.id, data)
      setMcpDialog({ open: false })
    }
  }

  const handleDeleteServer = async (id: string) => {
    if (confirm('Delete this MCP server? It will be removed from all agents.')) {
      await deleteServer(id)
    }
  }

  // OAuth callbacks passed to the dialog
  const handleProbeForAuth = useCallback(async (url: string): Promise<boolean> => {
    try {
      const { requiresAuth } = await useMcpStore.getState().servers.length
        ? await (await import('@/lib/ipc-client')).mcpServerApi.probeForAuth(url)
        : { requiresAuth: false }
      return requiresAuth
    } catch {
      return false
    }
  }, [])

  const handleStartOAuthFlow = useCallback(async (serverId: string) => {
    return await startOAuthFlow(serverId)
  }, [startOAuthFlow])

  const handleSubmitManualClientId = useCallback(async (serverId: string, clientId: string) => {
    return await submitManualClientId(serverId, clientId)
  }, [submitManualClientId])

  const handleRevokeOAuthToken = useCallback(async (serverId: string) => {
    await revokeOAuthToken(serverId)
  }, [revokeOAuthToken])

  const oauthCallbacks = {
    probeForAuth: handleProbeForAuth,
    startOAuthFlow: handleStartOAuthFlow,
    submitManualClientId: handleSubmitManualClientId,
    revokeOAuthToken: handleRevokeOAuthToken
  }

  // Is server OAuth-related? (has registration or probe says auth required)
  const isOAuthServer = (server: McpServer): boolean => {
    if (server.type !== 'remote') return false
    const hasRegistration = server.oauth_metadata && 'resource_url' in server.oauth_metadata
    return !!(hasRegistration || authRequired[server.id])
  }

  // Should the connection error row be hidden?
  // For OAuth servers, the connection test doesn't inject the token so it always gets 401.
  // Hide the error for all OAuth servers — the OAuth status row replaces it.
  const shouldHideConnectionRow = (server: McpServer, connection: McpConnectionInfo): boolean => {
    if (connection.status !== 'failed') return false
    return isOAuthServer(server)
  }

  return (
    <>
      <SettingsSection
        title="20x Mastermind MCP"
        description="Let Codex, Pi, and Claude communicate with the Mastermind that owns each workspace"
      >
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">Enable local MCP endpoint</div>
              <div className="text-xs text-muted-foreground mt-1">
                {mastermind?.running ? 'Running on this computer' : mastermind?.error ? 'Could not start' : mastermind?.enabled ? 'Stopped' : 'Disabled'}
                {mastermind?.error ? ` · ${mastermind.error}` : ''}
              </div>
            </div>
            <Switch checked={mastermind?.enabled ?? false} disabled={!mastermind || mastermindBusy === 'toggle'} onCheckedChange={(enabled) => void toggleMastermind(enabled)} />
          </div>
          <div className="flex items-center gap-2 rounded bg-muted px-3 py-2">
            <code className="text-xs flex-1 truncate">{mastermind?.url ?? 'http://127.0.0.1:20621/mcp'}</code>
            <Button variant="ghost" size="icon" title="Copy endpoint" onClick={() => void navigator.clipboard.writeText(mastermind?.url ?? 'http://127.0.0.1:20621/mcp')}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="space-y-2">
            {(['codex', 'pi', 'claude'] as const).map(client => {
              const clientStatus = mastermind?.clients[client]
              const ready = clientStatus?.configured && clientStatus.skillState === 'current'
              return (
                <div key={client} className="flex items-center gap-3 rounded border border-border px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium capitalize">{client === 'claude' ? 'Claude Code' : client}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {!clientStatus?.available ? 'Client not found' : ready ? `Current · skill v${mastermind?.skillVersion}` : clientStatus.skillState.replace('_', ' ')}
                    </div>
                  </div>
                  <Button size="sm" variant={ready ? 'ghost' : 'secondary'} disabled={!clientStatus?.available || !!mastermindBusy || ready} onClick={() => void installMastermind(client)}>
                    {mastermindBusy === client ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : ready ? 'Installed' : clientStatus?.skillState === 'not_installed' ? 'Install' : 'Update'}
                  </Button>
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">Bundled skill v{mastermind?.skillVersion ?? '…'} · configuration changes preserve unrelated settings.</p>
            <Button size="sm" variant="ghost" disabled={!!mastermindBusy} onClick={() => void checkMastermind()}>
              <RefreshCw className="h-3.5 w-3.5" /> Check versions
            </Button>
          </div>
          {mastermindMessage && <p className="text-xs text-muted-foreground">{mastermindMessage}</p>}
        </div>
      </SettingsSection>

      <SettingsSection
        title="MCP Servers"
        description="Manage Model Context Protocol servers for tools and integrations"
      >
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {servers.length} server{servers.length !== 1 ? 's' : ''} configured
          </p>
          <Button size="sm" onClick={() => setMcpDialog({ open: true })}>
            <Plus className="h-3.5 w-3.5" />
            Add Server
          </Button>
        </div>

        {servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border rounded-lg">
            <p className="text-sm text-muted-foreground mb-3">No MCP servers configured yet</p>
            <Button size="sm" onClick={() => setMcpDialog({ open: true })}>
              <Plus className="h-3.5 w-3.5" />
              Add Your First Server
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => {
              const connection = connections.get(server.id) || { status: 'idle' }
              const hideConnectionRow = shouldHideConnectionRow(server, connection)
              const oauthStatus = oauthStatuses[server.id]
              const hasOAuth = isOAuthServer(server)

              return (
                <div key={server.id} className="rounded-lg border border-border bg-card overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${
                      connection.status === 'connected' ? 'bg-primary'
                      : connection.status === 'failed' && !hideConnectionRow ? 'bg-destructive'
                      : connection.status === 'testing' ? 'bg-muted animate-pulse'
                      : hasOAuth && oauthStatus?.connected ? 'bg-emerald-500'
                      : hasOAuth ? 'bg-amber-500'
                      : 'bg-muted/50'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{server.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          server.type === 'remote'
                            ? 'bg-blue-500/10 text-blue-300'
                            : 'bg-muted text-muted-foreground'
                        }`}>
                          {server.type === 'remote' ? 'remote' : 'local'}
                        </span>
                        {hasOAuth && oauthStatus?.connected === false && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 flex items-center gap-1">
                            <KeyRound className="h-2.5 w-2.5" />
                            Auth needed
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {server.type === 'remote'
                          ? server.url
                          : `${server.command} ${server.args.join(' ')}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => testServerConnection(server)}
                        disabled={connection.status === 'testing'}
                        title="Test connection"
                      >
                        {connection.status === 'testing' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setMcpDialog({ open: true, server })}
                        title="Edit"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteServer(server.id)}
                        className="text-destructive hover:text-destructive"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {/* Connection status row */}
                  {connection.status !== 'idle' && !hideConnectionRow && (
                    <div className={`flex items-center gap-2 px-4 py-2 text-xs border-t ${
                      connection.status === 'connected' ? 'bg-accent/50 text-foreground border-l-2 border-primary'
                      : connection.status === 'failed' ? 'bg-destructive/10 text-destructive-foreground border-l-2 border-destructive'
                      : 'bg-muted text-muted-foreground border-border'
                    }`}>
                      {connection.status === 'testing' ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Testing connection...
                        </>
                      ) : connection.status === 'connected' ? (
                        <>
                          <Wifi className="h-3 w-3" />
                          Connected
                          {connection.toolCount != null && (
                            <span className="text-muted-foreground">
                              · {connection.toolCount} tool{connection.toolCount !== 1 ? 's' : ''}
                            </span>
                          )}
                        </>
                      ) : connection.status === 'failed' ? (
                        <>
                          <WifiOff className="h-3 w-3" />
                          <span className="truncate" title={connection.errorDetail || connection.error}>{connection.error || 'Connection failed'}</span>
                        </>
                      ) : null}
                    </div>
                  )}
                  {/* OAuth Connected status row — shown when 401 error is hidden */}
                  {hideConnectionRow && hasOAuth && oauthStatus?.connected && (
                    <div className="flex items-center gap-2 px-4 py-2 text-xs border-t bg-accent/50 text-foreground border-l-2 border-primary">
                      <Wifi className="h-3 w-3" />
                      Connected
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>

      <McpServerFormDialog
        server={mcpDialog.server}
        open={mcpDialog.open}
        onClose={() => setMcpDialog({ open: false })}
        onSubmit={mcpDialog.server ? handleUpdateServer : handleCreateServer}
        oauthConnected={mcpDialog.server ? oauthStatuses[mcpDialog.server.id]?.connected : undefined}
        oauth={oauthCallbacks}
      />
    </>
  )
}
