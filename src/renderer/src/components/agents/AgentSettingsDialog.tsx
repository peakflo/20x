import { useEffect, useState } from 'react'
import { Plus, Settings, Trash2, Edit3, CheckCircle, Loader2, Github, Wifi, WifiOff, RefreshCw, Server, Globe, Database } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { AgentForm } from './AgentForm'
import { PluginConfigForm } from './PluginConfigForm'
import { useAgentStore } from '@/stores/agent-store'
import { useMcpStore } from '@/stores/mcp-store'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { useSettingsStore } from '@/stores/settings-store'
import { agentConfigApi, pluginApi } from '@/lib/ipc-client'
import type { Agent, CreateAgentDTO, UpdateAgentDTO, McpServer, CreateMcpServerDTO, TaskSource, CreateTaskSourceDTO, PluginMeta } from '@/types'

// ── Shared types ────────────────────────────────────────────

interface ConnectionInfo {
  status: 'idle' | 'testing' | 'connected' | 'error'
  providerCount?: number
  modelCount?: number
  error?: string
  testedAt?: Date
}

interface McpConnectionInfo {
  status: 'idle' | 'testing' | 'connected' | 'failed'
  error?: string
  toolCount?: number
}

// ── Agent Card ──────────────────────────────────────────────

function AgentCard({ agent, connection, onTest, onEdit, onDelete }: {
  agent: Agent; connection: ConnectionInfo; onTest: () => void; onEdit: () => void; onDelete: () => void
}) {
  const statusDot = connection.status === 'connected' ? 'bg-green-400'
    : connection.status === 'error' ? 'bg-red-400'
    : connection.status === 'testing' ? 'bg-yellow-400 animate-pulse'
    : 'bg-muted-foreground/40'

  return (
    <div className="rounded-lg border border-border bg-card/50 overflow-hidden">
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
            {connection.status === 'testing' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={onEdit} title="Edit"><Edit3 className="h-3.5 w-3.5" /></Button>
          {!agent.is_default && (
            <Button variant="ghost" size="icon" onClick={onDelete} className="text-destructive hover:text-destructive" title="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
          )}
        </div>
      </div>
      {connection.status !== 'idle' && (
        <div className={`flex items-center gap-2 px-4 py-2 text-xs border-t border-border/50 ${
          connection.status === 'connected' ? 'bg-green-500/5 text-green-400'
          : connection.status === 'error' ? 'bg-red-500/5 text-red-400'
          : 'bg-muted/30 text-muted-foreground'
        }`}>
          {connection.status === 'testing' ? (
            <><Loader2 className="h-3 w-3 animate-spin" />Testing connection...</>
          ) : connection.status === 'connected' ? (
            <>
              <Wifi className="h-3 w-3" />Connected
              {connection.providerCount != null && (
                <span className="text-green-400/70">
                  · {connection.providerCount} provider{connection.providerCount !== 1 ? 's' : ''}
                  {connection.modelCount != null && `, ${connection.modelCount} model${connection.modelCount !== 1 ? 's' : ''}`}
                </span>
              )}
              {connection.testedAt && <span className="ml-auto text-muted-foreground">{connection.testedAt.toLocaleTimeString()}</span>}
            </>
          ) : connection.status === 'error' ? (
            <><WifiOff className="h-3 w-3" /><span className="truncate">{connection.error || 'Connection failed'}</span></>
          ) : null}
        </div>
      )}
    </div>
  )
}

// ── MCP Server Card ─────────────────────────────────────────

function McpServerCard({ server, connection, onTest, onEdit, onDelete }: {
  server: McpServer; connection: McpConnectionInfo; onTest: () => void; onEdit: () => void; onDelete: () => void
}) {
  const statusDot = connection.status === 'connected' ? 'bg-green-400'
    : connection.status === 'failed' ? 'bg-red-400'
    : connection.status === 'testing' ? 'bg-yellow-400 animate-pulse'
    : 'bg-muted-foreground/40'

  return (
    <div className="rounded-lg border border-border bg-card/50 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`h-2 w-2 rounded-full shrink-0 ${statusDot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{server.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${server.type === 'remote' ? 'bg-blue-500/20 text-blue-400' : 'bg-muted text-muted-foreground'}`}>
              {server.type === 'remote' ? 'remote' : 'local'}
            </span>
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {server.type === 'remote' ? server.url : `${server.command} ${server.args.join(' ')}`}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" onClick={onTest} disabled={connection.status === 'testing'} title="Test connection">
            {connection.status === 'testing' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={onEdit} title="Edit"><Edit3 className="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" onClick={onDelete} className="text-destructive hover:text-destructive" title="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      {connection.status !== 'idle' && (
        <div className={`flex items-center gap-2 px-4 py-2 text-xs border-t border-border/50 ${
          connection.status === 'connected' ? 'bg-green-500/5 text-green-400'
          : connection.status === 'failed' ? 'bg-red-500/5 text-red-400'
          : 'bg-muted/30 text-muted-foreground'
        }`}>
          {connection.status === 'testing' ? (
            <><Loader2 className="h-3 w-3 animate-spin" />Testing connection...</>
          ) : connection.status === 'connected' ? (
            <>
              <Wifi className="h-3 w-3" />Connected
              {connection.toolCount != null && (
                <span className="text-green-400/70">· {connection.toolCount} tool{connection.toolCount !== 1 ? 's' : ''}</span>
              )}
            </>
          ) : connection.status === 'failed' ? (
            <><WifiOff className="h-3 w-3" /><span className="truncate">{connection.error || 'Connection failed'}</span></>
          ) : null}
        </div>
      )}
    </div>
  )
}

// ── Task Source Card ─────────────────────────────────────────

function TaskSourceCard({ source, mcpServerName, pluginName, isSyncing, onSync, onEdit, onDelete }: {
  source: TaskSource; mcpServerName: string; pluginName: string; isSyncing: boolean; onSync: () => void; onEdit: () => void; onDelete: () => void
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`h-2 w-2 rounded-full shrink-0 ${source.enabled ? 'bg-green-400' : 'bg-muted-foreground/40'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{source.name}</span>
            <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded">{pluginName}</span>
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {mcpServerName}
            {source.last_synced_at && <span className="text-foreground/60"> · Synced {new Date(source.last_synced_at).toLocaleString()}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" onClick={onSync} disabled={isSyncing} title="Sync now">
            {isSyncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={onEdit} title="Edit"><Edit3 className="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" onClick={onDelete} className="text-destructive hover:text-destructive" title="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
    </div>
  )
}

// ── KeyValueEditor ──────────────────────────────────────────

function KeyValueEditor({ label, value, onChange, keyPlaceholder = 'KEY', valuePlaceholder = 'value' }: {
  label: string; value: Record<string, string>; onChange: (val: Record<string, string>) => void; keyPlaceholder?: string; valuePlaceholder?: string
}) {
  const entries = Object.entries(value)
  const updateEntry = (oldKey: string, newKey: string, newVal: string) => {
    const next = { ...value }; if (oldKey !== newKey) delete next[oldKey]; next[newKey] = newVal; onChange(next)
  }
  const removeEntry = (key: string) => { const next = { ...value }; delete next[key]; onChange(next) }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ ...value, '': '' })} className="h-6 text-xs px-2">
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>
      {entries.length > 0 && (
        <div className="space-y-1.5">
          {entries.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input value={k} onChange={(e) => updateEntry(k, e.target.value, v)} placeholder={keyPlaceholder} className="flex-1 text-xs h-8" />
              <Input value={v} onChange={(e) => updateEntry(k, k, e.target.value)} placeholder={valuePlaceholder} className="flex-1 text-xs h-8" />
              <Button type="button" variant="ghost" size="icon" onClick={() => removeEntry(k)} className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"><Trash2 className="h-3 w-3" /></Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Shell arg helpers ───────────────────────────────────────

function shellQuoteArg(arg: string): string {
  return arg.includes(' ') ? `"${arg}"` : arg
}

function parseShellArgs(input: string): string[] {
  const args: string[] = []; let current = ''; let inDouble = false; let inSingle = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === ' ' && !inDouble && !inSingle) { if (current) { args.push(current); current = '' }; continue }
    current += ch
  }
  if (current) args.push(current)
  return args
}

// ── Agent Form Dialog ───────────────────────────────────────

function AgentFormDialog({ agent, open, onClose, onSubmit }: {
  agent?: Agent; open: boolean; onClose: () => void; onSubmit: (data: CreateAgentDTO | UpdateAgentDTO) => void
}) {
  const handleSubmit = (data: CreateAgentDTO | UpdateAgentDTO) => {
    onSubmit(data)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{agent ? 'Edit Agent' : 'New Agent'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <AgentForm agent={agent} onSubmit={handleSubmit} onCancel={onClose} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

// ── MCP Server Form Dialog ──────────────────────────────────

function McpServerFormDialog({ server, open, onClose, onSubmit }: {
  server?: McpServer; open: boolean; onClose: () => void; onSubmit: (data: CreateMcpServerDTO) => void
}) {
  const [name, setName] = useState(server?.name ?? '')
  const [type, setType] = useState<'local' | 'remote'>(server?.type ?? 'local')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState(server?.args.map(shellQuoteArg).join(' ') ?? '')
  const [environment, setEnvironment] = useState<Record<string, string>>(server?.environment ?? {})
  const [url, setUrl] = useState(server?.url ?? '')
  const [headers, setHeaders] = useState<Record<string, string>>(server?.headers ?? {})

  // Reset form when dialog opens with different data
  useEffect(() => {
    if (open) {
      setName(server?.name ?? '')
      setType(server?.type ?? 'local')
      setCommand(server?.command ?? '')
      setArgs(server?.args.map(shellQuoteArg).join(' ') ?? '')
      setEnvironment(server?.environment ?? {})
      setUrl(server?.url ?? '')
      setHeaders(server?.headers ?? {})
    }
  }, [open, server?.id])

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
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{server ? 'Edit MCP Server' : 'New MCP Server'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
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
                  <Label htmlFor="mcp-args">Arguments</Label>
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
              <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button type="submit" size="sm" disabled={!isValid}>{server ? 'Save' : 'Add'}</Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

// ── Task Source Form Dialog ──────────────────────────────────

function TaskSourceFormDialog({ source, mcpServers, plugins, open, onClose, onSubmit }: {
  source?: TaskSource; mcpServers: McpServer[]; plugins: PluginMeta[]; open: boolean; onClose: () => void; onSubmit: (data: CreateTaskSourceDTO) => void
}) {
  const [name, setName] = useState(source?.name ?? '')
  const [pluginId, setPluginId] = useState(source?.plugin_id ?? (plugins[0]?.id ?? 'peakflo'))
  const [mcpServerId, setMcpServerId] = useState(source?.mcp_server_id ?? (mcpServers[0]?.id ?? ''))
  const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>(source?.config ?? {})

  useEffect(() => {
    if (open) {
      setName(source?.name ?? '')
      setPluginId(source?.plugin_id ?? (plugins[0]?.id ?? 'peakflo'))
      setMcpServerId(source?.mcp_server_id ?? (mcpServers[0]?.id ?? ''))
      setPluginConfig(source?.config ?? {})
    }
  }, [open, source?.id])

  const selectedPlugin = plugins.find((p) => p.id === pluginId)
  const isValid = name.trim() && pluginId && (!selectedPlugin?.requiresMcpServer || mcpServerId)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid) return
    onSubmit({ mcp_server_id: mcpServerId, name: name.trim(), plugin_id: pluginId, config: pluginConfig })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{source ? 'Edit Task Source' : 'New Task Source'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ts-plugin">Plugin</Label>
              <select id="ts-plugin" value={pluginId} onChange={(e) => { setPluginId(e.target.value); setPluginConfig({}) }}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer">
                {plugins.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </select>
              {selectedPlugin?.description && <p className="text-xs text-muted-foreground">{selectedPlugin.description}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ts-name">Source Name</Label>
              <Input id="ts-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Peakflo Tasks" required />
            </div>
            {selectedPlugin?.requiresMcpServer && (
              <div className="space-y-1.5">
                <Label htmlFor="ts-server">MCP Server</Label>
                <select id="ts-server" value={mcpServerId} onChange={(e) => setMcpServerId(e.target.value)}
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer">
                  {mcpServers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}
            <PluginConfigForm pluginId={pluginId} mcpServerId={mcpServerId} value={pluginConfig} onChange={setPluginConfig} />
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button type="submit" size="sm" disabled={!isValid}>{source ? 'Save' : 'Add'}</Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

// ── Main Settings Dialog ────────────────────────────────────

export function AgentSettingsDialog() {
  const { agents, isLoading, fetchAgents, createAgent, updateAgent, deleteAgent } = useAgentStore()
  const { activeModal, closeModal } = useUIStore()
  const isOpen = activeModal === 'agent-settings'

  const { servers: mcpServers, fetchServers: fetchMcpServers, createServer: createMcpServer, updateServer: updateMcpServer, deleteServer: deleteMcpServer, testConnection: testMcpConnection } = useMcpStore()
  const { sources: taskSources, syncingIds, fetchSources: fetchTaskSources, createSource: createTaskSource, updateSource: updateTaskSource, deleteSource: deleteTaskSource, syncSource } = useTaskSourceStore()
  const { fetchTasks } = useTaskStore()
  const { githubOrg, ghCliStatus, fetchSettings, setGithubOrg, checkGhCli, startGhAuth } = useSettingsStore()

  const [connections, setConnections] = useState<Map<string, ConnectionInfo>>(new Map())
  const [mcpConnections, setMcpConnections] = useState<Map<string, McpConnectionInfo>>(new Map())
  const [orgInput, setOrgInput] = useState('')
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [plugins, setPlugins] = useState<PluginMeta[]>([])

  // Sub-dialog state
  const [agentDialog, setAgentDialog] = useState<{ open: boolean; agent?: Agent }>({ open: false })
  const [mcpDialog, setMcpDialog] = useState<{ open: boolean; server?: McpServer }>({ open: false })
  const [tsDialog, setTsDialog] = useState<{ open: boolean; source?: TaskSource }>({ open: false })

  useEffect(() => {
    if (isOpen) {
      fetchAgents(); fetchMcpServers(); fetchTaskSources(); fetchSettings(); checkGhCli()
      pluginApi.list().then(setPlugins)
    }
  }, [isOpen])

  useEffect(() => { if (isOpen && githubOrg) setOrgInput(githubOrg) }, [isOpen, githubOrg])
  useEffect(() => { if (isOpen && agents.length > 0) agents.forEach((a) => testConnection(a)) }, [isOpen, agents.length])
  useEffect(() => { if (isOpen && mcpServers.length > 0) mcpServers.forEach((s) => testMcpServerConnection(s)) }, [isOpen, mcpServers.length])

  // ── Agent handlers ──────────────────────────────────────

  const handleCreateAgent = async (data: CreateAgentDTO | UpdateAgentDTO) => {
    await createAgent(data as CreateAgentDTO)
  }
  const handleUpdateAgent = async (data: CreateAgentDTO | UpdateAgentDTO) => {
    if (agentDialog.agent) await updateAgent(agentDialog.agent.id, data as UpdateAgentDTO)
  }
  const handleDeleteAgent = async (id: string) => {
    if (confirm('Are you sure you want to delete this agent?')) await deleteAgent(id)
  }

  // ── MCP Server handlers ─────────────────────────────────

  const handleCreateMcp = async (data: CreateMcpServerDTO) => { await createMcpServer(data) }
  const handleUpdateMcp = async (data: CreateMcpServerDTO) => {
    if (mcpDialog.server) await updateMcpServer(mcpDialog.server.id, data)
  }
  const handleDeleteMcp = async (id: string) => {
    if (confirm('Delete this MCP server? It will be removed from all agents.')) await deleteMcpServer(id)
  }

  // ── Task Source handlers ────────────────────────────────

  const handleCreateTaskSource = async (data: CreateTaskSourceDTO) => { await createTaskSource(data) }
  const handleUpdateTaskSource = async (data: CreateTaskSourceDTO) => {
    if (tsDialog.source) {
      await updateTaskSource(tsDialog.source.id, { name: data.name, plugin_id: data.plugin_id, config: data.config, mcp_server_id: data.mcp_server_id })
    }
  }
  const handleDeleteTaskSource = async (id: string) => {
    if (confirm('Delete this task source? Imported tasks will remain but lose their source link.')) await deleteTaskSource(id)
  }
  const handleSyncTaskSource = async (sourceId: string) => { await syncSource(sourceId); await fetchTasks() }

  // ── Connection testers ──────────────────────────────────

  const testMcpServerConnection = async (server: McpServer) => {
    setMcpConnections((prev) => new Map(prev).set(server.id, { status: 'testing' }))
    try {
      const testData = server.type === 'remote'
        ? { id: server.id, name: server.name, type: 'remote' as const, url: server.url, headers: server.headers }
        : { id: server.id, name: server.name, type: 'local' as const, command: server.command, args: server.args, environment: server.environment }
      const result = await testMcpConnection(testData)
      setMcpConnections((prev) => new Map(prev).set(server.id, { status: result.status, error: result.error, toolCount: result.toolCount }))
    } catch (err: any) {
      setMcpConnections((prev) => new Map(prev).set(server.id, { status: 'failed', error: err?.message || 'Test failed' }))
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
        setConnections((prev) => new Map(prev).set(agent.id, { status: 'connected', providerCount: providers.length, modelCount, testedAt: new Date() }))
      } else {
        setConnections((prev) => new Map(prev).set(agent.id, { status: 'error', error: 'No response from server' }))
      }
    } catch (err: any) {
      setConnections((prev) => new Map(prev).set(agent.id, { status: 'error', error: err?.message || 'Connection failed' }))
    }
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" /> Settings
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            {isLoading && agents.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {/* ── Agents ─────────────────────────────── */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-muted-foreground">
                      {agents.length} agent{agents.length !== 1 ? 's' : ''} configured
                    </h3>
                    <Button size="sm" onClick={() => setAgentDialog({ open: true })}>
                      <Plus className="h-3.5 w-3.5" /> Add Agent
                    </Button>
                  </div>
                  {agents.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">No agents configured yet.</div>
                  ) : (
                    <div className="space-y-2">
                      {agents.map((agent) => (
                        <AgentCard key={agent.id} agent={agent}
                          connection={connections.get(agent.id) ?? { status: 'idle' }}
                          onTest={() => testConnection(agent)}
                          onEdit={() => setAgentDialog({ open: true, agent })}
                          onDelete={() => handleDeleteAgent(agent.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* ── MCP Servers ─────────────────────────── */}
                <div className="space-y-3 pt-4 mt-4 border-t">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Server className="h-4 w-4 text-muted-foreground" />
                      <h3 className="text-sm font-medium">MCP Servers</h3>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setMcpDialog({ open: true })}>
                      <Plus className="h-3.5 w-3.5" /> Add Server
                    </Button>
                  </div>
                  {mcpServers.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2">No MCP servers configured.</p>
                  ) : (
                    <div className="space-y-2">
                      {mcpServers.map((server) => (
                        <McpServerCard key={server.id} server={server}
                          connection={mcpConnections.get(server.id) ?? { status: 'idle' }}
                          onTest={() => testMcpServerConnection(server)}
                          onEdit={() => setMcpDialog({ open: true, server })}
                          onDelete={() => handleDeleteMcp(server.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* ── Task Sources ────────────────────────── */}
                <div className="space-y-3 pt-4 mt-4 border-t">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Database className="h-4 w-4 text-muted-foreground" />
                      <h3 className="text-sm font-medium">Task Sources</h3>
                    </div>
                    {mcpServers.length > 0 && (
                      <Button size="sm" variant="outline" onClick={() => setTsDialog({ open: true })}>
                        <Plus className="h-3.5 w-3.5" /> Add Source
                      </Button>
                    )}
                  </div>
                  {taskSources.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2">
                      {mcpServers.length === 0 ? 'Add an MCP server first, then create a task source.' : 'No task sources configured.'}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {taskSources.map((source) => (
                        <TaskSourceCard key={source.id} source={source}
                          mcpServerName={mcpServers.find((s) => s.id === source.mcp_server_id)?.name ?? 'Unknown'}
                          pluginName={plugins.find((p) => p.id === source.plugin_id)?.displayName ?? source.plugin_id}
                          isSyncing={syncingIds.has(source.id)}
                          onSync={() => handleSyncTaskSource(source.id)}
                          onEdit={() => setTsDialog({ open: true, source })}
                          onDelete={() => handleDeleteTaskSource(source.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* ── GitHub ──────────────────────────────── */}
                <div className="space-y-3 pt-4 mt-4 border-t">
                  <div className="flex items-center gap-2">
                    <Github className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-medium">GitHub Integration</h3>
                  </div>
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
                          setIsAuthenticating(true); try { await startGhAuth() } catch {} finally { setIsAuthenticating(false) }
                        }} disabled={isAuthenticating}>
                          {isAuthenticating ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                          Authenticate
                        </Button>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">gh CLI not installed</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <input value={orgInput} onChange={(e) => setOrgInput(e.target.value)} placeholder="GitHub org name"
                      className="flex-1 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/30" />
                    <Button size="sm" variant="outline" disabled={!orgInput.trim() || orgInput.trim() === githubOrg} onClick={() => setGithubOrg(orgInput.trim())}>
                      Save
                    </Button>
                  </div>
                </div>
              </>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* ── Sub-dialogs for create/edit ──────────────────── */}
      <AgentFormDialog
        open={agentDialog.open}
        agent={agentDialog.agent}
        onClose={() => setAgentDialog({ open: false })}
        onSubmit={agentDialog.agent ? handleUpdateAgent : handleCreateAgent}
      />
      <McpServerFormDialog
        open={mcpDialog.open}
        server={mcpDialog.server}
        onClose={() => setMcpDialog({ open: false })}
        onSubmit={mcpDialog.server ? handleUpdateMcp : handleCreateMcp}
      />
      <TaskSourceFormDialog
        open={tsDialog.open}
        source={tsDialog.source}
        mcpServers={mcpServers}
        plugins={plugins}
        onClose={() => setTsDialog({ open: false })}
        onSubmit={tsDialog.source ? handleUpdateTaskSource : handleCreateTaskSource}
      />
    </>
  )
}
