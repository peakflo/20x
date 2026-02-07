import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Label } from '@/components/ui/Label'
import type { Agent, CreateAgentDTO, UpdateAgentDTO, McpServerConfig } from '@/types'

interface AgentFormProps {
  agent?: Agent
  onSubmit: (data: CreateAgentDTO | UpdateAgentDTO) => void
  onCancel: () => void
}

export function AgentForm({ agent, onSubmit, onCancel }: AgentFormProps) {
  const [name, setName] = useState(agent?.name ?? '')
  const [serverUrl, setServerUrl] = useState(agent?.server_url ?? 'http://localhost:4096')
  const [model, setModel] = useState(agent?.config.model ?? '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.config.system_prompt ?? '')
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(
    agent?.config.mcp_servers ?? []
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    onSubmit({
      name: name.trim(),
      server_url: serverUrl.trim(),
      config: {
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
        <Label htmlFor="agent-model">Model</Label>
        <Input
          id="agent-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="claude-sonnet-4-5-20250929"
        />
      </div>

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
