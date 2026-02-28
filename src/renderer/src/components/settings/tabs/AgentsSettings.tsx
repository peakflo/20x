import { useState, useEffect } from 'react'
import { Plus, Loader2, Wifi, WifiOff, RefreshCw, Edit3, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SettingsSection } from '../SettingsSection'
import { AgentFormDialog } from '../forms/AgentFormDialog'
import { OpenCodeLogo, AnthropicLogo, OpenAILogo } from '@/components/icons/AgentLogos'
import { useAgentStore } from '@/stores/agent-store'
import { agentConfigApi } from '@/lib/ipc-client'
import { CodingAgentType } from '@/types'
import type { Agent, CreateAgentDTO, UpdateAgentDTO } from '@/types'

interface ConnectionInfo {
  status: 'idle' | 'testing' | 'connected' | 'error'
  providerCount?: number
  modelCount?: number
  error?: string
  testedAt?: Date
}

interface AgentDialogState {
  open: boolean
  agent?: Agent
}

export function AgentsSettings() {
  const { agents, fetchAgents, createAgent, updateAgent, deleteAgent } = useAgentStore()
  const [connections, setConnections] = useState<Map<string, ConnectionInfo>>(new Map())
  const [agentDialog, setAgentDialog] = useState<AgentDialogState>({ open: false })

  useEffect(() => {
    fetchAgents()
  }, [])

  useEffect(() => {
    if (agents.length > 0) {
      agents.forEach((a) => testConnection(a))
    }
  }, [agents.length])

  const testConnection = async (agent: Agent) => {
    setConnections((prev) => new Map(prev).set(agent.id, { status: 'testing' }))

    // CLI-based agents (Claude Code, Codex) run locally and don't need server connection test
    if (agent.config.coding_agent === CodingAgentType.CLAUDE_CODE) {
      setConnections((prev) => new Map(prev).set(agent.id, {
        status: 'connected',
        providerCount: 1,
        modelCount: 6,
        testedAt: new Date()
      }))
      return
    }

    if (agent.config.coding_agent === CodingAgentType.CODEX) {
      setConnections((prev) => new Map(prev).set(agent.id, {
        status: 'connected',
        providerCount: 1,
        modelCount: 4,
        testedAt: new Date()
      }))
      return
    }

    // Test OpenCode server connection
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
        setConnections((prev) => new Map(prev).set(agent.id, { status: 'error', error: 'No response from server' }))
      }
    } catch (err: unknown) {
      setConnections((prev) => new Map(prev).set(agent.id, { status: 'error', error: err instanceof Error ? err.message : 'Connection failed' }))
    }
  }

  const handleCreateAgent = async (data: CreateAgentDTO | UpdateAgentDTO) => {
    await createAgent(data as CreateAgentDTO)
    setAgentDialog({ open: false })
  }

  const handleUpdateAgent = async (data: CreateAgentDTO | UpdateAgentDTO) => {
    if (agentDialog.agent) {
      await updateAgent(agentDialog.agent.id, data as UpdateAgentDTO)
      setAgentDialog({ open: false })
    }
  }

  const handleDeleteAgent = async (id: string) => {
    if (confirm('Are you sure you want to delete this agent?')) {
      await deleteAgent(id)
    }
  }

  return (
    <>
      <SettingsSection
        title="Coding Agents"
        description="Manage AI coding agents for task execution"
      >
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {agents.length} agent{agents.length !== 1 ? 's' : ''} configured
          </p>
          <Button size="sm" onClick={() => setAgentDialog({ open: true })}>
            <Plus className="h-3.5 w-3.5" />
            Add Agent
          </Button>
        </div>

        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border rounded-lg">
            <p className="text-sm text-muted-foreground mb-3">No agents configured yet</p>
            <Button size="sm" onClick={() => setAgentDialog({ open: true })}>
              <Plus className="h-3.5 w-3.5" />
              Add Your First Agent
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {agents.map((agent) => {
              const connection = connections.get(agent.id) || { status: 'idle' }
              const isOpenCode = agent.config.coding_agent === CodingAgentType.OPENCODE || !agent.config.coding_agent
              const isClaudeCode = agent.config.coding_agent === CodingAgentType.CLAUDE_CODE
              const isCodex = agent.config.coding_agent === CodingAgentType.CODEX
              const isCliAgent = isClaudeCode || isCodex

              return (
                <div key={agent.id} className="rounded-lg border border-border bg-card overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${
                      connection.status === 'connected' ? 'bg-primary'
                      : connection.status === 'error' ? 'bg-destructive'
                      : connection.status === 'testing' ? 'bg-muted animate-pulse'
                      : 'bg-muted/50'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{agent.name}</span>
                        {agent.is_default && (
                          <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded">Default</span>
                        )}
                        {isOpenCode && (
                          <span title="OpenCode">
                            <OpenCodeLogo className="h-3.5 w-3.5 text-blue-300/80" />
                          </span>
                        )}
                        {isClaudeCode && (
                          <span title="Claude Code">
                            <AnthropicLogo className="h-3.5 w-3.5 text-orange-300/80" />
                          </span>
                        )}
                        {isCodex && (
                          <span title="Codex">
                            <OpenAILogo className="h-3.5 w-3.5 text-emerald-300/80" />
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {isCliAgent ? 'Local CLI' : agent.server_url}
                        {agent.config.model && <span className="text-foreground/60"> · {agent.config.model}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => testConnection(agent)}
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
                        onClick={() => setAgentDialog({ open: true, agent })}
                        title="Edit"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                      {!agent.is_default && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteAgent(agent.id)}
                          className="text-destructive hover:text-destructive"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {connection.status !== 'idle' && (
                    <div className={`flex items-center gap-2 px-4 py-2 text-xs border-t ${
                      connection.status === 'connected' ? 'bg-accent/50 text-foreground border-l-2 border-primary'
                      : connection.status === 'error' ? 'bg-destructive/10 text-destructive-foreground border-l-2 border-destructive'
                      : 'bg-muted text-muted-foreground border-border'
                    }`}>
                      {connection.status === 'testing' ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {isCliAgent ? 'Checking CLI...' : 'Testing connection...'}
                        </>
                      ) : connection.status === 'connected' ? (
                        <>
                          <Wifi className="h-3 w-3" />
                          {isCliAgent ? 'Ready' : 'Connected'}
                          {connection.providerCount != null && !isCliAgent && (
                            <span className="text-muted-foreground">
                              · {connection.providerCount} provider{connection.providerCount !== 1 ? 's' : ''}
                              {connection.modelCount != null && `, ${connection.modelCount} model${connection.modelCount !== 1 ? 's' : ''}`}
                            </span>
                          )}
                          {isCliAgent && connection.modelCount != null && (
                            <span className="text-muted-foreground">
                              · {connection.modelCount} models available
                            </span>
                          )}
                          {connection.testedAt && (
                            <span className="ml-auto text-muted-foreground">
                              {connection.testedAt.toLocaleTimeString()}
                            </span>
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
            })}
          </div>
        )}
      </SettingsSection>

      <AgentFormDialog
        agent={agentDialog.agent}
        open={agentDialog.open}
        onClose={() => setAgentDialog({ open: false })}
        onSubmit={agentDialog.agent ? handleUpdateAgent : handleCreateAgent}
      />
    </>
  )
}
