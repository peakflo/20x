import { useEffect, useState } from 'react'
import { Plus, Settings, Trash2, Edit3, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { AgentForm } from './AgentForm'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'
import type { Agent, CreateAgentDTO, UpdateAgentDTO } from '@/types'

export function AgentSettingsDialog() {
  const { agents, isLoading, fetchAgents, createAgent, updateAgent, deleteAgent } = useAgentStore()
  const { activeModal, closeModal } = useUIStore()
  const isOpen = activeModal === 'agent-settings'
  
  const [editingAgent, setEditingAgent] = useState<Agent | undefined>()
  const [isCreating, setIsCreating] = useState(false)
  const [testingConnection, setTestingConnection] = useState<string | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<Map<string, 'success' | 'error'>>(new Map())

  useEffect(() => {
    if (isOpen) {
      fetchAgents()
    }
  }, [isOpen, fetchAgents])

  const handleClose = () => {
    closeModal()
    setEditingAgent(undefined)
    setIsCreating(false)
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

  const testConnection = async (agent: Agent) => {
    setTestingConnection(agent.id)
    try {
      const response = await fetch(`${agent.server_url}/health`, { 
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      })
      setConnectionStatus(prev => new Map(prev).set(agent.id, response.ok ? 'success' : 'error'))
    } catch {
      setConnectionStatus(prev => new Map(prev).set(agent.id, 'error'))
    } finally {
      setTestingConnection(null)
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
            <div className="space-y-4">
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
                    <div
                      key={agent.id}
                      className="flex items-center justify-between p-3 rounded-md border border-border bg-card/50 hover:bg-card transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm truncate">{agent.name}</span>
                          {agent.is_default && (
                            <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded">
                              Default
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground truncate mt-0.5">
                          {agent.server_url}
                          {agent.config.model && ` • ${agent.config.model}`}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 ml-3">
                        {connectionStatus.get(agent.id) === 'success' && (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        )}
                        {connectionStatus.get(agent.id) === 'error' && (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                        
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => testConnection(agent)}
                          disabled={testingConnection === agent.id}
                          title="Test Connection"
                        >
                          {testingConnection === agent.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CheckCircle className="h-3.5 w-3.5" />
                          )}
                        </Button>

                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditingAgent(agent)}
                          title="Edit"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </Button>

                        {!agent.is_default && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(agent.id)}
                            className="text-destructive hover:text-destructive"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
