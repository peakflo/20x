import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { AgentForm } from '@/components/agents/AgentForm'
import type { Agent, CreateAgentDTO, UpdateAgentDTO } from '@/types'

interface AgentFormDialogProps {
  agent?: Agent
  open: boolean
  onClose: () => void
  onSubmit: (data: CreateAgentDTO | UpdateAgentDTO) => void
}

export function AgentFormDialog({ agent, open, onClose, onSubmit }: AgentFormDialogProps) {
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
