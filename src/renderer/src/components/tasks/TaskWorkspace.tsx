import { LayoutList } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { TaskDetailView } from './TaskDetailView'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { AgentApprovalBanner } from '@/components/agents/AgentApprovalBanner'
import { useAgentSession } from '@/hooks/use-agent-session'
import { useAgentStore } from '@/stores/agent-store'
import { useEffect, useCallback } from 'react'
import type { WorkfloTask, ChecklistItem, FileAttachment, Agent } from '@/types'

interface TaskWorkspaceProps {
  task?: WorkfloTask
  agents: Agent[]
  onEdit: () => void
  onDelete: () => void
  onUpdateChecklist: (checklist: ChecklistItem[]) => void
  onUpdateAttachments: (attachments: FileAttachment[]) => void
  onAssignAgent: (taskId: string, agentId: string | null) => void
}

export function TaskWorkspace({ 
  task, 
  agents, 
  onEdit, 
  onDelete, 
  onUpdateChecklist, 
  onUpdateAttachments,
  onAssignAgent 
}: TaskWorkspaceProps) {
  const { session, start, stop, approve } = useAgentSession()
  const { getSessionForTask, addActiveSession, removeActiveSession } = useAgentStore()

  // Start session when agent is assigned
  useEffect(() => {
    if (task?.agent_id && !session.sessionId && task.status !== 'completed' && task.status !== 'cancelled') {
      // Check if there's already an active session for this task
      const existingSession = getSessionForTask(task.id)
      if (!existingSession) {
        // Auto-start session when agent is assigned
        start(task.agent_id, task.id).then((sessionId) => {
          addActiveSession({
            sessionId,
            agentId: task.agent_id!,
            taskId: task.id,
            status: 'working'
          })
        }).catch(console.error)
      }
    }
  }, [task?.agent_id, task?.id, task?.status, session.sessionId])

  // Stop session when task is completed/cancelled
  useEffect(() => {
    if (session.sessionId && (task?.status === 'completed' || task?.status === 'cancelled')) {
      stop().then(() => {
        removeActiveSession(session.sessionId!)
      }).catch(console.error)
    }
  }, [task?.status, session.sessionId])

  const handleAssignAgent = useCallback((agentId: string | null) => {
    if (task) {
      onAssignAgent(task.id, agentId)
    }
  }, [task, onAssignAgent])

  const handleStopSession = useCallback(() => {
    if (session.sessionId) {
      stop().then(() => {
        removeActiveSession(session.sessionId!)
      }).catch(console.error)
    }
  }, [session.sessionId, stop])

  const handleApprove = useCallback((message?: string) => {
    approve(true, message).catch(console.error)
  }, [approve])

  const handleReject = useCallback((message?: string) => {
    approve(false, message).catch(console.error)
  }, [approve])

  if (!task) {
    return (
      <div className="flex items-center justify-center h-full">
        <EmptyState
          icon={LayoutList}
          title="No task selected"
          description="Select a task from the sidebar to view its details, or create a new one"
        />
      </div>
    )
  }

  const hasActiveSession = session.sessionId && session.status !== 'idle'

  return (
    <>
      {/* Approval Banner */}
      <AgentApprovalBanner 
        request={session.pendingApproval} 
        onApprove={handleApprove}
        onReject={handleReject}
      />

      {/* Split Layout */}
      <div className={`grid h-full ${hasActiveSession ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <div className="overflow-hidden">
          <TaskDetailView
            task={task}
            agents={agents}
            onEdit={onEdit}
            onDelete={onDelete}
            onUpdateChecklist={onUpdateChecklist}
            onUpdateAttachments={onUpdateAttachments}
            onAssignAgent={handleAssignAgent}
          />
        </div>

        {hasActiveSession && (
          <AgentTranscriptPanel
            messages={session.messages}
            status={session.status}
            onStop={handleStopSession}
          />
        )}
      </div>
    </>
  )
}
