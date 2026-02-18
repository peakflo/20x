import { useState, useEffect } from 'react'
import { Loader2, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Label } from '@/components/ui/Label'
import { Checkbox } from '@/components/ui/Checkbox'
import { agentConfigApi } from '@/lib/ipc-client'
import { useMcpStore } from '@/stores/mcp-store'
import { SkillSelector } from '@/components/skills/SkillSelector'
import type { Agent, CreateAgentDTO, UpdateAgentDTO, AgentMcpServerEntry } from '@/types'
import { CodingAgentType, CODING_AGENTS, CLAUDE_MODELS, CODEX_MODELS } from '@/types'

interface AgentFormProps {
  agent?: Agent
  onSubmit: (data: CreateAgentDTO | UpdateAgentDTO) => void
  onCancel: () => void
}

interface Model {
  id: string
  name: string
}

/** Parse agent config mcp_servers into a map of serverId → enabledTools (undefined = all tools) */
function parseMcpSelection(entries?: Array<string | AgentMcpServerEntry>): Map<string, string[] | undefined> {
  const map = new Map<string, string[] | undefined>()
  if (!entries) return map
  for (const entry of entries) {
    if (typeof entry === 'string') {
      map.set(entry, undefined) // all tools
    } else {
      map.set(entry.serverId, entry.enabledTools)
    }
  }
  return map
}

export function AgentForm({ agent, onSubmit, onCancel }: AgentFormProps) {
  const [name, setName] = useState(agent?.name ?? '')
  const [serverUrl, setServerUrl] = useState(agent?.server_url ?? 'http://localhost:4096')
  const [codingAgent, setCodingAgent] = useState<CodingAgentType | ''>(agent?.config.coding_agent ?? '')
  const [model, setModel] = useState(agent?.config.model ?? '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.config.system_prompt ?? '')
  const [maxParallelSessions, setMaxParallelSessions] = useState(agent?.config.max_parallel_sessions ?? 1)
  const [skillIds, setSkillIds] = useState<string[] | undefined>(agent?.config.skill_ids)
  const [mcpSelection, setMcpSelection] = useState<Map<string, string[] | undefined>>(
    () => parseMcpSelection(agent?.config.mcp_servers)
  )
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set())

  // API keys state
  const [openaiApiKey, setOpenaiApiKey] = useState(agent?.config.api_keys?.openai ?? '')
  const [anthropicApiKey, setAnthropicApiKey] = useState(agent?.config.api_keys?.anthropic ?? '')

  // Environment variable detection state
  const [hasOpenaiEnv, setHasOpenaiEnv] = useState(false)
  const [hasAnthropicEnv, setHasAnthropicEnv] = useState(false)

  const { servers: globalMcpServers, fetchServers: fetchMcpServers } = useMcpStore()

  useEffect(() => {
    fetchMcpServers()

    // Check for environment variables
    window.electronAPI.env.get('OPENAI_API_KEY').then(value => {
      setHasOpenaiEnv(!!value)
    })
    window.electronAPI.env.get('ANTHROPIC_API_KEY').then(value => {
      setHasAnthropicEnv(!!value)
    })
  }, [])

  // Model fetching state
  const [availableModels, setAvailableModels] = useState<Model[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)

  // Fetch models when coding agent is selected
  useEffect(() => {
    if (codingAgent === CodingAgentType.OPENCODE) {
      fetchModels()
    } else if (codingAgent === CodingAgentType.CLAUDE_CODE) {
      // For Claude Code, show predefined Claude models
      setAvailableModels(CLAUDE_MODELS)
    } else if (codingAgent === CodingAgentType.CODEX) {
      // For Codex, fetch models dynamically from Codex CLI
      fetchCodexModels()
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

      const result = await agentConfigApi.getProviders(serverUrl)

      if (result && result.providers) {
        // Flatten all models from all providers
        const models: Model[] = []

        if (Array.isArray(result.providers) && result.providers.length > 0) {
          result.providers.forEach((provider: any) => {
            // Models can be either an array or an object with model IDs as keys
            if (provider.models) {
              if (Array.isArray(provider.models)) {
                // Handle array format
                provider.models.forEach((m: any) => {
                  models.push({
                    id: `${provider.id}/${m.id}`,
                    name: `${provider.name} - ${m.name || m.id}`
                  })
                })
              } else if (typeof provider.models === 'object') {
                // Handle object format (model IDs as keys)
                Object.values(provider.models).forEach((m: any) => {
                  if (m && m.id) {
                    models.push({
                      id: `${provider.id}/${m.id}`,
                      name: `${provider.name} - ${m.name || m.id}`
                    })
                  }
                })
              }
            }
          })
        }

        if (models.length > 0) {
          setAvailableModels(models)
        } else {
          setModelError('No models available from server. You can manually enter a model ID.')
        }
      } else {
        console.log('[AgentForm] No providers in result:', result)
        setModelError('Failed to load models from server')
      }
    } catch (error) {
      console.error('[AgentForm] Error fetching models:', error)
      setModelError(`Failed to load models: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setIsLoadingModels(false)
    }
  }

  const fetchCodexModels = () => {
    // Use hardcoded models for Codex
    setAvailableModels(CODEX_MODELS)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    // Serialize mcp_servers selection
    const mcpServersConfig: Array<string | AgentMcpServerEntry> = []
    for (const [serverId, enabledTools] of mcpSelection) {
      if (enabledTools === undefined) {
        mcpServersConfig.push(serverId) // all tools
      } else {
        mcpServersConfig.push({ serverId, enabledTools })
      }
    }

    onSubmit({
      name: name.trim(),
      server_url: serverUrl.trim(),
      config: {
        coding_agent: codingAgent || undefined,
        model: model.trim() || undefined,
        system_prompt: systemPrompt.trim() || undefined,
        max_parallel_sessions: maxParallelSessions,
        mcp_servers: mcpServersConfig.length > 0 ? mcpServersConfig : undefined,
        skill_ids: skillIds,
        api_keys: {
          openai: openaiApiKey.trim() || undefined,
          anthropic: anthropicApiKey.trim() || undefined
        }
      }
    })
  }

  const toggleMcpServer = (serverId: string) => {
    setMcpSelection((prev) => {
      const next = new Map(prev)
      if (next.has(serverId)) {
        next.delete(serverId)
        setExpandedServers((s) => { const n = new Set(s); n.delete(serverId); return n })
      } else {
        next.set(serverId, undefined) // all tools by default
      }
      return next
    })
  }

  const toggleExpand = (serverId: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev)
      if (next.has(serverId)) next.delete(serverId)
      else next.add(serverId)
      return next
    })
  }

  const toggleTool = (serverId: string, toolName: string, allToolNames: string[]) => {
    setMcpSelection((prev) => {
      const next = new Map(prev)
      const current = next.get(serverId)
      // If currently "all tools" (undefined), switch to explicit list minus this tool
      if (current === undefined) {
        next.set(serverId, allToolNames.filter((t) => t !== toolName))
      } else if (current.includes(toolName)) {
        const updated = current.filter((t) => t !== toolName)
        // If we just removed the last tool, uncheck the server entirely
        if (updated.length === 0) {
          next.delete(serverId)
          setExpandedServers((s) => { const n = new Set(s); n.delete(serverId); return n })
        } else {
          next.set(serverId, updated)
        }
      } else {
        const updated = [...current, toolName]
        // If all tools are now selected, switch back to undefined (all)
        next.set(serverId, updated.length === allToolNames.length ? undefined : updated)
      }
      return next
    })
  }

  const isToolEnabled = (serverId: string, toolName: string): boolean => {
    const entry = mcpSelection.get(serverId)
    if (entry === undefined) return true // all tools
    return entry.includes(toolName)
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

      {/* Only show Server URL for OpenCode */}
      {codingAgent !== CodingAgentType.CLAUDE_CODE && codingAgent !== CodingAgentType.CODEX && (
        <div className="space-y-1.5">
          <Label htmlFor="agent-url">Server URL</Label>
          <Input
            id="agent-url"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="http://localhost:4096"
          />
        </div>
      )}

      {/* Show info for CLI-based agents */}
      {codingAgent === CodingAgentType.CLAUDE_CODE && (
        <p className="text-sm text-muted-foreground">
          Claude Code runs locally via CLI and doesn't require a server URL
        </p>
      )}
      {codingAgent === CodingAgentType.CODEX && (
        <p className="text-sm text-muted-foreground">
          Codex runs locally via CLI and doesn't require a server URL
        </p>
      )}

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

      {(codingAgent === CodingAgentType.OPENCODE || codingAgent === CodingAgentType.CLAUDE_CODE || codingAgent === CodingAgentType.CODEX) && (
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

      {/* API Key Configuration for Codex */}
      {codingAgent === CodingAgentType.CODEX && (
        <div className="space-y-1.5">
          <Label htmlFor="openai-api-key">OpenAI API Key</Label>
          <Input
            id="openai-api-key"
            type="password"
            value={openaiApiKey}
            onChange={(e) => setOpenaiApiKey(e.target.value)}
            placeholder={hasOpenaiEnv ? '••••••••' : 'sk-proj-...'}
          />
          {!openaiApiKey && hasOpenaiEnv && (
            <p className="text-xs text-muted-foreground">
              ✓ Using OPENAI_API_KEY from environment
            </p>
          )}
          {!openaiApiKey && !hasOpenaiEnv && (
            <p className="text-xs text-destructive">
              Required: Enter your OpenAI API key or set OPENAI_API_KEY environment variable
            </p>
          )}
        </div>
      )}

      {/* API Key Configuration for Claude Code */}
      {codingAgent === CodingAgentType.CLAUDE_CODE && (
        <div className="space-y-1.5">
          <Label htmlFor="anthropic-api-key">Anthropic API Key (Optional)</Label>
          <Input
            id="anthropic-api-key"
            type="password"
            value={anthropicApiKey}
            onChange={(e) => setAnthropicApiKey(e.target.value)}
            placeholder={hasAnthropicEnv ? '••••••••' : 'sk-ant-...'}
          />
          {anthropicApiKey && (
            <p className="text-xs text-muted-foreground">
              Using provided API key
            </p>
          )}
          {!anthropicApiKey && hasAnthropicEnv && (
            <p className="text-xs text-muted-foreground">
              ✓ Using ANTHROPIC_API_KEY from environment
            </p>
          )}
          {!anthropicApiKey && !hasAnthropicEnv && (
            <p className="text-xs text-muted-foreground">
              Claude Code uses CLI authentication - no API key required
            </p>
          )}
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

      <div className="space-y-1.5">
        <Label htmlFor="max-parallel-sessions">Parallel Task Limit</Label>
        <Input
          id="max-parallel-sessions"
          type="number"
          min={1}
          max={10}
          value={maxParallelSessions}
          onChange={(e) => setMaxParallelSessions(Number(e.target.value))}
          placeholder="1"
        />
        <p className="text-xs text-muted-foreground">
          How many tasks this agent can work on at the same time (1-10)
        </p>
      </div>

      <div className="space-y-2">
        <Label>MCP Servers</Label>
        {globalMcpServers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No MCP servers configured. Add them in Agent Settings.
          </p>
        ) : (
          <div className="space-y-1.5">
            {globalMcpServers.map((server) => {
              const isChecked = mcpSelection.has(server.id)
              const hasTools = server.tools && server.tools.length > 0
              const isExpanded = expandedServers.has(server.id)
              const enabledTools = mcpSelection.get(server.id)
              const enabledCount = enabledTools === undefined
                ? server.tools?.length ?? 0
                : enabledTools.length

              return (
                <div key={server.id} className="rounded-md border border-border overflow-hidden">
                  <label className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-accent/50">
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => toggleMcpServer(server.id)}
                    />
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <span className="text-sm">{server.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                        server.type === 'remote' ? 'bg-blue-500/20 text-blue-400' : 'bg-muted text-muted-foreground'
                      }`}>
                        {server.type === 'remote' ? 'remote' : 'local'}
                      </span>
                      {hasTools && isChecked && (
                        <span className="text-[10px] text-muted-foreground">
                          {enabledCount}/{server.tools.length} tools
                        </span>
                      )}
                    </div>
                    {hasTools && isChecked && (
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); toggleExpand(server.id) }}
                        className="p-0.5 text-muted-foreground hover:text-foreground"
                      >
                        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                      </button>
                    )}
                  </label>
                  {hasTools && isChecked && isExpanded && (
                    <div className="border-t border-border/50 px-3 py-1.5 space-y-0.5 bg-muted/20">
                      {server.tools.map((tool) => (
                        <label key={tool.name} className="flex items-center gap-2 py-0.5 cursor-pointer">
                          <Checkbox
                            className="h-3.5 w-3.5"
                            checked={isToolEnabled(server.id, tool.name)}
                            onCheckedChange={() => toggleTool(server.id, tool.name, server.tools.map((t) => t.name))}
                          />
                          <span className="text-xs">{tool.name}</span>
                          {tool.description && (
                            <span className="text-[10px] text-muted-foreground truncate">{tool.description}</span>
                          )}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label>Skills</Label>
        <SkillSelector selectedIds={skillIds} onChange={setSkillIds} />
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
