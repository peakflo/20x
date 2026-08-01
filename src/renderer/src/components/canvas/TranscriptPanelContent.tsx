import { useCallback } from 'react'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { useAgentSession } from '@/hooks/use-agent-session'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useTaskStore } from '@/stores/task-store'
import { Bot } from 'lucide-react'

interface TranscriptPanelContentProps {
  taskId: string
}

/**
 * Embeds the real AgentTranscriptPanel inside a canvas panel.
 * Connects to the agent session for the given task and provides
 * full stop/restart/send capabilities.
 */
export function TranscriptPanelContent({ taskId }: TranscriptPanelContentProps) {
  const { session, stop, start, sendMessage, approve } = useAgentSession(taskId)
  // Select the single action instead of subscribing to the whole store — a
  // selector-less useAgentStore() re-renders this panel on every streamed
  // delta of every task's session.
  const removeSession = useAgentStore((s) => s.removeSession)
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))

  const messages = session?.messages ?? []
  const status = session?.status ?? SessionStatus.IDLE
  const systemStatus = session?.systemStatus ?? null

  const handleStop = useCallback(() => {
    stop().catch(console.error)
  }, [stop])

  const handleRestart = useCallback(async () => {
    const agentId = task?.agent_id
    if (!agentId) return
    try {
      if (session?.sessionId) {
        await stop()
      }
      await removeSession(taskId)
      await start(agentId, taskId)
    } catch (err) {
      console.error('Failed to restart session:', err)
    }
  }, [task?.agent_id, session?.sessionId, stop, removeSession, taskId, start])

  const handleSend = useCallback(
    async (message: string) => {
      // Read messages from the store at call time instead of closing over the
      // render-time array: depending on `messages` gives this callback a new
      // identity on every streamed delta, which defeats React.memo on every
      // transcript row receiving it as a prop.
      const currentMessages = useAgentStore.getState().sessions.get(taskId)?.messages ?? []
      // Route question responses through approve
      let questionIndex = -1
      for (let i = currentMessages.length - 1; i >= 0; i--) {
        if (currentMessages[i].partType === 'question' && currentMessages[i].tool?.questions) {
          questionIndex = i
          break
        }
      }
      const hasActiveQuestion =
        questionIndex >= 0 &&
        !currentMessages.slice(questionIndex + 1).some((m) => m.role === 'user')
      if (hasActiveQuestion) {
        await approve(true, message)
        return
      }

      await sendMessage(message)
    },
    [taskId, approve, sendMessage]
  )

  if (!session || (status === SessionStatus.IDLE && messages.length === 0)) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">
        <div className="text-center space-y-1">
          <Bot className="h-5 w-5 mx-auto opacity-40" />
          <div>No active session</div>
          <div className="text-[10px] text-muted-foreground/30">
            Start an agent on the linked task to see transcript
          </div>
        </div>
      </div>
    )
  }

  return (
    <AgentTranscriptPanel
      messages={messages}
      status={status}
      systemStatus={systemStatus}
      onStop={handleStop}
      onRestart={handleRestart}
      onSend={handleSend}
      className="h-full select-text"
      sessionId={session?.sessionId ?? undefined}
      taskId={taskId}
      agentId={task?.agent_id ?? undefined}
      pendingApproval={session?.pendingApproval ?? undefined}
      pendingSend={session?.pendingSend}
    />
  )
}
