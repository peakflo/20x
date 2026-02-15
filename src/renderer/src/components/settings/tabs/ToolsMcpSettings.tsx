import { useState, useEffect } from 'react'
import { Plus, Loader2, Wifi, WifiOff, RefreshCw, Edit3, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SettingsSection } from '../SettingsSection'
import { McpServerFormDialog } from '../forms/McpServerFormDialog'
import { useMcpStore } from '@/stores/mcp-store'
import type { McpServer, CreateMcpServerDTO } from '@/types'

interface McpConnectionInfo {
  status: 'idle' | 'testing' | 'connected' | 'failed'
  error?: string
  toolCount?: number
}

interface McpDialogState {
  open: boolean
  server?: McpServer
}

export function ToolsMcpSettings() {
  const { servers, fetchServers, createServer, updateServer, deleteServer, testConnection: testMcpConnection } = useMcpStore()
  const [connections, setConnections] = useState<Map<string, McpConnectionInfo>>(new Map())
  const [mcpDialog, setMcpDialog] = useState<McpDialogState>({ open: false })

  useEffect(() => {
    fetchServers()
  }, [])

  useEffect(() => {
    if (servers.length > 0) {
      servers.forEach((s) => testServerConnection(s))
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
        toolCount: result.toolCount
      }))
    } catch (err: any) {
      setConnections((prev) => new Map(prev).set(server.id, {
        status: 'failed',
        error: err?.message || 'Test failed'
      }))
    }
  }

  const handleCreateServer = async (data: CreateMcpServerDTO) => {
    await createServer(data)
    setMcpDialog({ open: false })
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

  return (
    <>
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

              return (
                <div key={server.id} className="rounded-lg border border-border bg-card overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${
                      connection.status === 'connected' ? 'bg-primary'
                      : connection.status === 'failed' ? 'bg-destructive'
                      : connection.status === 'testing' ? 'bg-muted animate-pulse'
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
                  {connection.status !== 'idle' && (
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
                          <span className="truncate">{connection.error || 'Connection failed'}</span>
                        </>
                      ) : null}
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
      />
    </>
  )
}
