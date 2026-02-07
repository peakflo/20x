import { useState, useEffect } from 'react'
import { Plus, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Label } from '@/components/ui/Label'
import { agentConfigApi } from '@/lib/ipc-client'
import type { Agent, CreateAgentDTO, UpdateAgentDTO, McpServerConfig, CodingAgentType } from '@/types'
import { CODING_AGENTS } from '@/types'

interface AgentFormProps {
  agent?: Agent
  onSubmit: (data: CreateAgentDTO | UpdateAgentDTO) => void
  onCancel: () => void
}

interface Model {
  id: string
  name: string
}

export function AgentForm({ agent, onSubmit, onCancel }: AgentFormProps) {
  const [name, setName] = useState(agent?.name ?? '')
  const [serverUrl, setServerUrl] = useState(agent?.server_url ?? 'http://localhost:4096')
  const [codingAgent, setCodingAgent] = useState<CodingAgentType | ''>(agent?.config.coding_agent ?? '')
  const [model, setModel] = useState(agent?.config.model ?? '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.config.system_prompt ?? '')
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(
    agent?.config.mcp_servers ?? []
  )
  
  // Model fetching state
  const [availableModels, setAvailableModels] = useState<Model[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)

  // Fetch models when coding agent is selected
  useEffect(() => {
    if (codingAgent === 'opencode') {
      fetchModels()
    } else {
      setAvailableModels([])
      setModel('')
    }
  }, [codingAgent, serverUrl])

  const fetchModels = async () => {
    setIsLoadingModels(true)
    setModelError(null)
    
    try {
      // Check if agentConfigApi is available (requires app restart after preload changes)
      if (!agentConfigApi || typeof agentConfigApi.getProviders !== 'function') {
        setModelError('API not available. Please restart the application.')
        setIsLoadingModels(false)
        return
      }
      
      const result = await agentConfigApi.getProviders()
      
      if (result && result.providers) {
        // Flatten all models from all providers
        const models: Model[] = []
        result.providers.forEach((provider: any) => {
          if (provider.models && Array.isArray(provider.models)) {
            provider.models.forEach((m: any) => {
              models.push({
                id: `${provider.id}/${m.id}`,
                name: `${provider.name} - ${m.name || m.id}`
              })
            })
          }
        })
        setAvailableModels(models)
      } else {
        setModelError('Failed to load models from server')
      }
    } catch (error) {
      console.error('Error fetching models:', error)
      setModelError('Failed to load models. Is the OpenCode server running?')
    } finally {
      setIsLoadingModels(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    onSubmit({
      name: name.trim(),
      server_url: serverUrl.trim(),
      config: {
        coding_agent: codingAgent || undefined,
        model: model.trim() || undefined,
        system_prompt: systemPrompt.trim() || undefined,
        mcp_servers: mcpServers.length > 0 ? mcpServers : undefined
      }
    })
  }

  const addMcpServer = () => {
    setMcpServers([...mcpServers, { name: '', command: '', args: [] }])
  }

  const removeMcpServer = (index: number) => {
    setMcpServers(mcpServers.filter((_, i) => i !== index))
  }

  const updateMcpServer = (index: number, field: keyof McpServerConfig, value: string | string[]) => {
    setMcpServers(mcpServers.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="agent-name">Name</Label>
        <Input
          id="agent-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Agent"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="agent-url">Server URL</Label>
        <Input
          id="agent-url"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="http://localhost:4096"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="coding-agent">Coding Agent</Label>
        <select
          id="coding-agent"
          value={codingAgent}
          onChange={(e) => setCodingAgent(e.target.value as CodingAgentType | '')}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
        >
          <option value="">Select a coding agent...</option>
          {CODING_AGENTS.map((ca) => (
            <option key={ca.value} value={ca.value}>{ca.label}</option>
          ))}
        </select>
      </div>

      {codingAgent === 'opencode' && (
        <div className="space-y-1.5">
          <Label htmlFor="agent-model">Model</Label>
          <div className="relative">
            {isLoadingModels ? (
              <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground border border-input rounded-md">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading models...
              </div>
            ) : modelError ? (
              <div className="space-y-2">
                <Input
                  id="agent-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="provider/model-id"
                />
                <p className="text-xs text-destructive">{modelError}</p>
                {modelError.includes('restart') && (
                  <p className="text-xs text-muted-foreground">
                    The application needs to be restarted to load the latest changes.
                  </p>
                )}
                <Button 
                  type="button" 
                  variant="ghost" 
                  size="sm" 
                  onClick={fetchModels}
                  className="text-xs"
                >
                  Retry
                </Button>
              </div>
            ) : availableModels.length > 0 ? (
              <select
                id="agent-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
              >
                <option value="">Select a model...</option>
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            ) : (
              <div className="space-y-2">
                <Input
                  id="agent-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="provider/model-id"
                />
                <p className="text-xs text-muted-foreground">
                  No models fetched. You can manually enter a model ID (e.g., anthropic/claude-3-5-sonnet-20241022)
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="agent-prompt">System Prompt</Label>
        <Textarea
          id="agent-prompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="Optional system prompt for the agent..."
          rows={3}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>MCP Servers</Label>
          <Button type="button" variant="ghost" size="sm" onClick={addMcpServer}>
            <Plus className="h-3 w-3" /> Add
          </Button>
        </div>
        {mcpServers.map((server, i) => (
          <div key={i} className="flex items-start gap-2 rounded-md border border-border p-3">
            <div className="flex-1 space-y-2">
              <Input
                value={server.name}
                onChange={(e) => updateMcpServer(i, 'name', e.target.value)}
                placeholder="Server name"
              />
              <Input
                value={server.command}
                onChange={(e) => updateMcpServer(i, 'command', e.target.value)}
                placeholder="Command (e.g. npx)"
              />
              <Input
                value={server.args.join(' ')}
                onChange={(e) => updateMcpServer(i, 'args', e.target.value.split(' ').filter(Boolean))}
                placeholder="Args (space-separated)"
              />
            </div>
            <Button type="button" variant="ghost" size="icon" onClick={() => removeMcpServer(i)}>
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={!name.trim()}>
          {agent ? 'Save' : 'Create'}
        </Button>
      </div>
    </form>
  )
}
