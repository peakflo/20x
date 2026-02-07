import { useEffect, useState } from 'react'
import { Plus, Settings, Trash2, Edit3, CheckCircle, XCircle, Loader2, Github, Wifi, WifiOff, RefreshCw, Server, Globe } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { AgentForm } from './AgentForm'
import { useAgentStore } from '@/stores/agent-store'
import { useMcpStore } from '@/stores/mcp-store'
import { useUIStore } from '@/stores/ui-store'
import { useSettingsStore } from '@/stores/settings-store'
import { agentConfigApi } from '@/lib/ipc-client'
import type { Agent, CreateAgentDTO, UpdateAgentDTO, McpServer, CreateMcpServerDTO } from '@/types'

interface ConnectionInfo {
  status: 'idle' | 'testing' | 'connected' | 'error'
  providerCount?: number
  modelCount?: number
  error?: string
  testedAt?: Date
}

function AgentCard({
  agent,
  connection,
  onTest,
  onEdit,
  onDelete
}: {
  agent: Agent
  connection: ConnectionInfo
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const statusDot = connection.status === 'connected'
    ? 'bg-green-400'
    : connection.status === 'error'
      ? 'bg-red-400'
      : connection.status === 'testing'
        ? 'bg-yellow-400 animate-pulse'
        : 'bg-muted-foreground/40'

  return (
    <div className="rounded-lg border border-border bg-card/50 overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`h-2 w-2 rounded-full shrink-0 ${statusDot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{agent.name}</span>
            {agent.is_default && (
              <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded">Default</span>
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {agent.server_url}
            {agent.config.model && <span className="text-foreground/60"> · {agent.config.model}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" onClick={onTest} disabled={connection.status === 'testing'} title="Test connection">
            {connection.status === 'testing' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button variant="ghost" size="icon" onClick={onEdit} title="Edit">
            <Edit3 className="h-3.5 w-3.5" />
          </Button>
          {!agent.is_default && (
            <Button variant="ghost" size="icon" onClick={onDelete} className="text-destructive hover:text-destructive" title="Delete">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Connection status bar */}
      {connection.status !== 'idle' && (
        <div className={`flex items-center gap-2 px-4 py-2 text-xs border-t border-border/50 ${
          connection.status === 'connected'
            ? 'bg-green-500/5 text-green-400'
            : connection.status === 'error'
              ? 'bg-red-500/5 text-red-400'
              : 'bg-muted/30 text-muted-foreground'
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
              {connection.providerCount != null && (
                <span className="text-green-400/70">
                  · {connection.providerCount} provider{connection.providerCount !== 1 ? 's' : ''}
                  {connection.modelCount != null && `, ${connection.modelCount} model${connection.modelCount !== 1 ? 's' : ''}`}
                </span>
              )}
              {connection.testedAt && (
                <span className="ml-auto text-muted-foreground">{connection.testedAt.toLocaleTimeString()}</span>
              )}
            </>
          ) : connection.status === 'error' ? (
            <>
              <WifiOff className="h-3 w-3" />
              <span className="truncate">{connection.error || 'Connection failed'}</span>
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}

interface McpConnectionInfo {
  status: 'idle' | 'testing' | 'connected' | 'failed'
  error?: string
  toolCount?: number
}

function McpServerCard({
  server,
  connection,
  onTest,
  onEdit,
  onDelete
}: {
  server: McpServer
  connection: McpConnectionInfo
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const statusDot = connection.status === 'connected'
    ? 'bg-green-400'
    : connection.status === 'failed'
      ? 'bg-red-400'
      : connection.status === 'testing'
        ? 'bg-yellow-400 animate-pulse'
        : 'bg-muted-foreground/40'

  return (
    <div className="rounded-lg border border-border bg-card/50 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`h-2 w-2 rounded-full shrink-0 ${statusDot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{server.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              server.type === 'remote' ? 'bg-blue-500/20 text-blue-400' : 'bg-muted text-muted-foreground'
            }`}>
              {server.type === 'remote' ? 'remote' : 'local'}
            </span>
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {server.type === 'remote' ? server.url : `${server.command} ${server.args.join(' ')}`}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" onClick={onTest} disabled={connection.status === 'testing'} title="Test connection">
            {connection.status === 'testing' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button variant="ghost" size="icon" onClick={onEdit} title="Edit">
            <Edit3 className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete} className="text-destructive hover:text-destructive" title="Delete">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {connection.status !== 'idle' && (
        <div className={`flex items-center gap-2 px-4 py-2 text-xs border-t border-border/50 ${
          connection.status === 'connected'
            ? 'bg-green-500/5 text-green-400'
            : connection.status === 'failed'
              ? 'bg-red-500/5 text-red-400'
              : 'bg-muted/30 text-muted-foreground'
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
                <span className="text-green-400/70">
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
}

function KeyValueEditor({
  label,
  value,
  onChange,
  keyPlaceholder = 'KEY',
  valuePlaceholder = 'value'
}: {
  label: string
  value: Record<string, string>
  onChange: (val: Record<string, string>) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
}) {
  const entries = Object.entries(value)

  const updateEntry = (oldKey: string, newKey: string, newVal: string) => {
    const next = { ...value }
    if (oldKey !== newKey) delete next[oldKey]
    next[newKey] = newVal
    onChange(next)
  }

  const removeEntry = (key: string) => {
    const next = { ...value }
    delete next[key]
    onChange(next)
  }

  const addEntry = () => {
    onChange({ ...value, '': '' })
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button type="button" variant="ghost" size="sm" onClick={addEntry} className="h-6 text-xs px-2">
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>
      {entries.length > 0 && (
        <div className="space-y-1.5">
          {entries.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={k}
                onChange={(e) => updateEntry(k, e.target.value, v)}
                placeholder={keyPlaceholder}
                className="flex-1 text-xs h-8"
              />
              <Input
                value={v}
                onChange={(e) => updateEntry(k, k, e.target.value)}
                placeholder={valuePlaceholder}
                className="flex-1 text-xs h-8"
              />
              <Button type="button" variant="ghost" size="icon" onClick={() => removeEntry(k)} className="h-8 w-8 shrink-0 text-destructive hover:text-destructive">
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Quote an arg for display if it contains spaces */
function shellQuoteArg(arg: string): string {
  return arg.includes(' ') ? `"${arg}"` : arg
}

/** Parse a shell-like args string respecting double/single quotes */
function parseShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inDouble = false
  let inSingle = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === ' ' && !inDouble && !inSingle) {
      if (current) { args.push(current); current = '' }
      continue
    }
    current += ch
  }
  if (current) args.push(current)
  return args
}

function McpServerForm({
  server,
  onSubmit,
  onCancel
}: {
  server?: McpServer
  onSubmit: (data: CreateMcpServerDTO) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(server?.name ?? '')
  const [type, setType] = useState<'local' | 'remote'>(server?.type ?? 'local')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState(server?.args.map(shellQuoteArg).join(' ') ?? '')
  const [environment, setEnvironment] = useState<Record<string, string>>(server?.environment ?? {})
  const [url, setUrl] = useState(server?.url ?? '')
  const [headers, setHeaders] = useState<Record<string, string>>(server?.headers ?? {})

  const isValid = name.trim() && (type === 'local' ? command.trim() : url.trim())

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid) return

    const data: CreateMcpServerDTO = { name: name.trim(), type }
    if (type === 'local') {
      data.command = command.trim()
      data.args = args.trim() ? parseShellArgs(args.trim()) : []
      if (Object.keys(environment).length > 0) data.environment = environment
    } else {
      data.url = url.trim()
      if (Object.keys(headers).length > 0) data.headers = headers
    }
    onSubmit(data)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="mcp-name">Name</Label>
        <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="filesystem" required />
      </div>

      <div className="space-y-1.5">
        <Label>Type</Label>
        <div className="flex gap-1">
          <Button type="button" size="sm" variant={type === 'local' ? 'default' : 'outline'} onClick={() => setType('local')} className="flex-1">
            <Server className="h-3.5 w-3.5 mr-1.5" /> Local
          </Button>
          <Button type="button" size="sm" variant={type === 'remote' ? 'default' : 'outline'} onClick={() => setType('remote')} className="flex-1">
            <Globe className="h-3.5 w-3.5 mr-1.5" /> Remote
          </Button>
        </div>
      </div>

      {type === 'local' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-command">Command</Label>
            <Input id="mcp-command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-args">Arguments (use quotes for values with spaces)</Label>
            <Input id="mcp-args" value={args} onChange={(e) => setArgs(e.target.value)} placeholder={'mcp-remote https://url --header "Authorization: Bearer token"'} />
          </div>
          <KeyValueEditor label="Environment Variables" value={environment} onChange={setEnvironment} keyPlaceholder="VAR_NAME" valuePlaceholder="value" />
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-url">URL</Label>
            <Input id="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" required />
          </div>
          <KeyValueEditor label="Headers" value={headers} onChange={setHeaders} keyPlaceholder="Header-Name" valuePlaceholder="value" />
        </>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!isValid}>
          {server ? 'Save' : 'Add'}
        </Button>
      </div>
    </form>
  )
}

export function AgentSettingsDialog() {
  const { agents, isLoading, fetchAgents, createAgent, updateAgent, deleteAgent } = useAgentStore()
  const { activeModal, closeModal } = useUIStore()
  const isOpen = activeModal === 'agent-settings'

  const { servers: mcpServers, fetchServers: fetchMcpServers, createServer: createMcpServer, updateServer: updateMcpServer, deleteServer: deleteMcpServer, testConnection: testMcpConnection } = useMcpStore()
  const { githubOrg, ghCliStatus, fetchSettings, setGithubOrg, checkGhCli, startGhAuth } = useSettingsStore()
  const [editingAgent, setEditingAgent] = useState<Agent | undefined>()
  const [isCreating, setIsCreating] = useState(false)
  const [connections, setConnections] = useState<Map<string, ConnectionInfo>>(new Map())
  const [mcpConnections, setMcpConnections] = useState<Map<string, McpConnectionInfo>>(new Map())
  const [isCreatingMcp, setIsCreatingMcp] = useState(false)
  const [editingMcp, setEditingMcp] = useState<McpServer | undefined>()
  const [orgInput, setOrgInput] = useState('')
  const [isAuthenticating, setIsAuthenticating] = useState(false)

  useEffect(() => {
    if (isOpen) {
      fetchAgents()
      fetchMcpServers()
      fetchSettings()
      checkGhCli()
    }
  }, [isOpen, fetchAgents])

  useEffect(() => {
    if (isOpen && githubOrg) {
      setOrgInput(githubOrg)
    }
  }, [isOpen, githubOrg])

  // Auto-test all agents when dialog opens
  useEffect(() => {
    if (isOpen && agents.length > 0) {
      agents.forEach((agent) => testConnection(agent))
    }
  }, [isOpen, agents.length])

  // Auto-test all MCP servers when dialog opens
  useEffect(() => {
    if (isOpen && mcpServers.length > 0) {
      mcpServers.forEach((srv) => testMcpServerConnection(srv))
    }
  }, [isOpen, mcpServers.length])

  const handleClose = () => {
    closeModal()
    setEditingAgent(undefined)
    setIsCreating(false)
    setIsCreatingMcp(false)
    setEditingMcp(undefined)
  }

  const handleCreate = async (data: CreateAgentDTO | UpdateAgentDTO) => {
    await createAgent(data as CreateAgentDTO)
    setIsCreating(false)
  }

  const handleUpdate = async (data: CreateAgentDTO | UpdateAgentDTO) => {
    if (editingAgent) {
      await updateAgent(editingAgent.id, data as UpdateAgentDTO)
      setEditingAgent(undefined)
    }
  }

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this agent?')) {
      await deleteAgent(id)
    }
  }

  const handleCreateMcp = async (data: CreateMcpServerDTO) => {
    await createMcpServer(data)
    setIsCreatingMcp(false)
  }

  const handleUpdateMcp = async (data: CreateMcpServerDTO) => {
    if (editingMcp) {
      await updateMcpServer(editingMcp.id, data)
      setEditingMcp(undefined)
    }
  }

  const handleDeleteMcp = async (id: string) => {
    if (confirm('Delete this MCP server? It will be removed from all agents.')) {
      await deleteMcpServer(id)
    }
  }

  const testMcpServerConnection = async (server: McpServer) => {
    setMcpConnections((prev) => new Map(prev).set(server.id, { status: 'testing' }))
    try {
      const testData = server.type === 'remote'
        ? { id: server.id, name: server.name, type: 'remote' as const, url: server.url, headers: server.headers }
        : { id: server.id, name: server.name, type: 'local' as const, command: server.command, args: server.args, environment: server.environment }
      const result = await testMcpConnection(testData)
      setMcpConnections((prev) => new Map(prev).set(server.id, {
        status: result.status,
        error: result.error,
        toolCount: result.toolCount
      }))
    } catch (err: any) {
      setMcpConnections((prev) => new Map(prev).set(server.id, {
        status: 'failed',
        error: err?.message || 'Test failed'
      }))
    }
  }

  const testConnection = async (agent: Agent) => {
    setConnections((prev) => new Map(prev).set(agent.id, { status: 'testing' }))

    try {
      const result = await agentConfigApi.getProviders(agent.server_url)

      if (result && result.providers) {
        let modelCount = 0
        const providers = Array.isArray(result.providers) ? result.providers : []
        for (const p of providers) {
          if (Array.isArray(p.models)) modelCount += p.models.length
          else if (p.models && typeof p.models === 'object') modelCount += Object.keys(p.models).length
        }

        setConnections((prev) => new Map(prev).set(agent.id, {
          status: 'connected',
          providerCount: providers.length,
          modelCount,
          testedAt: new Date()
        }))
      } else {
        setConnections((prev) => new Map(prev).set(agent.id, {
          status: 'error',
          error: 'No response from server'
        }))
      }
    } catch (err: any) {
      setConnections((prev) => new Map(prev).set(agent.id, {
        status: 'error',
        error: err?.message || 'Connection failed'
      }))
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Agent Settings
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          {isLoading && agents.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : isCreating ? (
            <div className="space-y-4">
              <h3 className="text-sm font-medium">Create New Agent</h3>
              <AgentForm onSubmit={handleCreate} onCancel={() => setIsCreating(false)} />
            </div>
          ) : editingAgent ? (
            <div className="space-y-4">
              <h3 className="text-sm font-medium">Edit Agent</h3>
              <AgentForm agent={editingAgent} onSubmit={handleUpdate} onCancel={() => setEditingAgent(undefined)} />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-muted-foreground">
                  {agents.length} agent{agents.length !== 1 ? 's' : ''} configured
                </h3>
                <Button size="sm" onClick={() => setIsCreating(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  Add Agent
                </Button>
              </div>

              {agents.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Settings className="h-12 w-12 mx-auto mb-3 opacity-20" />
                  <p>No agents configured yet.</p>
                  <p className="text-sm">Add your first agent to get started.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {agents.map((agent) => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      connection={connections.get(agent.id) ?? { status: 'idle' }}
                      onTest={() => testConnection(agent)}
                      onEdit={() => setEditingAgent(agent)}
                      onDelete={() => handleDelete(agent.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MCP Servers Section */}
          {!isCreating && !editingAgent && (
            <div className="space-y-3 pt-4 mt-4 border-t">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Server className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-medium">MCP Servers</h3>
                </div>
                {!isCreatingMcp && !editingMcp && (
                  <Button size="sm" variant="outline" onClick={() => setIsCreatingMcp(true)}>
                    <Plus className="h-3.5 w-3.5" />
                    Add Server
                  </Button>
                )}
              </div>

              {isCreatingMcp ? (
                <McpServerForm onSubmit={handleCreateMcp} onCancel={() => setIsCreatingMcp(false)} />
              ) : editingMcp ? (
                <McpServerForm server={editingMcp} onSubmit={handleUpdateMcp} onCancel={() => setEditingMcp(undefined)} />
              ) : mcpServers.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  No MCP servers configured. Add servers here and attach them to agents.
                </p>
              ) : (
                <div className="space-y-2">
                  {mcpServers.map((server) => (
                    <McpServerCard
                      key={server.id}
                      server={server}
                      connection={mcpConnections.get(server.id) ?? { status: 'idle' }}
                      onTest={() => testMcpServerConnection(server)}
                      onEdit={() => setEditingMcp(server)}
                      onDelete={() => handleDeleteMcp(server.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* GitHub Section */}
          {!isCreating && !editingAgent && (
            <div className="space-y-3 pt-4 mt-4 border-t">
              <div className="flex items-center gap-2">
                <Github className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">GitHub Integration</h3>
              </div>

              {/* gh CLI status */}
              <div className="flex items-center gap-2 text-xs">
                {ghCliStatus?.authenticated ? (
                  <span className="flex items-center gap-1.5 text-green-400">
                    <CheckCircle className="h-3.5 w-3.5" />
                    Authenticated{ghCliStatus.username ? ` as ${ghCliStatus.username}` : ''}
                  </span>
                ) : ghCliStatus?.installed ? (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">gh CLI installed but not authenticated</span>
                    <Button size="sm" variant="outline" onClick={async () => {
                      setIsAuthenticating(true)
                      try { await startGhAuth() } catch {} finally { setIsAuthenticating(false) }
                    }} disabled={isAuthenticating}>
                      {isAuthenticating ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                      Authenticate
                    </Button>
                  </div>
                ) : (
                  <span className="text-muted-foreground">gh CLI not installed</span>
                )}
              </div>

              {/* GitHub org */}
              <div className="flex items-center gap-2">
                <input
                  value={orgInput}
                  onChange={(e) => setOrgInput(e.target.value)}
                  placeholder="GitHub org name"
                  className="flex-1 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/30"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!orgInput.trim() || orgInput.trim() === githubOrg}
                  onClick={() => setGithubOrg(orgInput.trim())}
                >
                  Save
                </Button>
              </div>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
