import { LayoutList } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { TaskDetailView } from './TaskDetailView'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { AgentApprovalBanner } from '@/components/agents/AgentApprovalBanner'
import { GhCliSetupDialog } from '@/components/github/GhCliSetupDialog'
import { RepoSelectorDialog } from '@/components/github/RepoSelectorDialog'
import { WorktreeProgressOverlay } from '@/components/github/WorktreeProgressOverlay'
import { useAgentSession } from '@/hooks/use-agent-session'
import { useAgentStore } from '@/stores/agent-store'
import { useSettingsStore } from '@/stores/settings-store'
import { taskApi, worktreeApi } from '@/lib/ipc-client'
import { useEffect, useCallback, useRef, useState } from 'react'
import type { WorkfloTask, ChecklistItem, FileAttachment, Agent } from '@/types'
import type { GitHubRepo } from '@/types/electron'

interface TaskWorkspaceProps {
  task?: WorkfloTask
  agents: Agent[]
  onEdit: () => void
  onDelete: () => void
  onUpdateChecklist: (checklist: ChecklistItem[]) => void
  onUpdateAttachments: (attachments: FileAttachment[]) => void
  onAssignAgent: (taskId: string, agentId: string | null) => void
  onUpdateTask?: (taskId: string, data: Partial<WorkfloTask>) => Promise<void>
}

export function TaskWorkspace({
  task,
  agents,
  onEdit,
  onDelete,
  onUpdateChecklist,
  onUpdateAttachments,
  onAssignAgent,
  onUpdateTask
}: TaskWorkspaceProps) {
  const { session, start, abort, stop, sendMessage, approve } = useAgentSession()
  const { addActiveSession, removeActiveSession } = useAgentStore()
  const { githubOrg, ghCliStatus, checkGhCli, fetchSettings } = useSettingsStore()

  const startingRef = useRef(false)
  const [showGhSetup, setShowGhSetup] = useState(false)
  const [showRepoSelector, setShowRepoSelector] = useState(false)
  const [isSettingUpWorktree, setIsSettingUpWorktree] = useState(false)

  // Fetch settings on mount
  useEffect(() => { fetchSettings() }, [])

  // Fully destroy session when task is completed/cancelled
  useEffect(() => {
    if (session.sessionId && (task?.status === 'completed' || task?.status === 'cancelled')) {
      stop()
        .then(() => {
          removeActiveSession(session.sessionId!)
          // Cleanup worktrees
          if (task && task.repos.length > 0 && githubOrg) {
            worktreeApi.cleanup(task.id, task.repos.map((r) => ({ fullName: r })), githubOrg).catch(console.error)
          }
        })
        .catch(console.error)
    }
  }, [task?.status, session.sessionId])

  const startSessionDirectly = useCallback(async () => {
    if (!task?.agent_id) return
    startingRef.current = true
    try {
      const sessionId = await start(task.agent_id, task.id)
      addActiveSession({
        sessionId,
        agentId: task.agent_id,
        taskId: task.id,
        status: 'working'
      })
    } catch (err) {
      console.error('Failed to start session:', err)
    } finally {
      startingRef.current = false
    }
  }, [task?.agent_id, task?.id, start, addActiveSession])

  const handleStartSession = useCallback(async () => {
    if (!task?.agent_id || startingRef.current || session.sessionId) return

    // Check if gh CLI is configured — if not, start without repos
    const cliStatus = await checkGhCli()
    if (!cliStatus.installed || !cliStatus.authenticated || !githubOrg) {
      await startSessionDirectly()
      return
    }

    // gh is configured — open repo selector (user can skip by confirming with no repos)
    setShowRepoSelector(true)
  }, [task?.agent_id, task?.id, session.sessionId, githubOrg, checkGhCli, startSessionDirectly])

  const handleGhSetupComplete = useCallback(() => {
    setShowGhSetup(false)
    if (!githubOrg) return
    // After setup, open repo selector
    setShowRepoSelector(true)
  }, [githubOrg])

  const handleReposConfirmed = useCallback(async (selectedRepos: GitHubRepo[]) => {
    if (!task?.agent_id || !task) return
    setShowRepoSelector(false)

    // No repos selected — start without worktree
    if (selectedRepos.length === 0) {
      await startSessionDirectly()
      return
    }

    if (!githubOrg) return

    // Save repos to task
    const repoNames = selectedRepos.map((r) => r.fullName)
    if (onUpdateTask) {
      await onUpdateTask(task.id, { repos: repoNames })
    } else {
      await taskApi.update(task.id, { repos: repoNames })
    }

    // Setup worktrees
    setIsSettingUpWorktree(true)
    try {
      const workspaceDir = await worktreeApi.setup(
        task.id,
        selectedRepos.map((r) => ({ fullName: r.fullName, defaultBranch: r.defaultBranch })),
        githubOrg
      )

      // Start agent session with workspace directory
      startingRef.current = true
      const sessionId = await start(task.agent_id, task.id, workspaceDir)
      addActiveSession({
        sessionId,
        agentId: task.agent_id!,
        taskId: task.id,
        status: 'working'
      })
    } catch (err) {
      console.error('Failed to setup workspace:', err)
    } finally {
      setIsSettingUpWorktree(false)
      startingRef.current = false
    }
  }, [task, githubOrg, start, addActiveSession, onUpdateTask, startSessionDirectly])

  const handleAssignAgent = useCallback(
    (agentId: string | null) => {
      if (!task) return

      // If unassigning, fully destroy the session
      if (!agentId && session.sessionId) {
        stop()
          .then(() => removeActiveSession(session.sessionId!))
          .catch(console.error)
      }

      onAssignAgent(task.id, agentId)
    },
    [task, session.sessionId, stop, onAssignAgent, removeActiveSession]
  )

  // Abort = interrupt current generation, keep panel open
  const handleAbort = useCallback(() => {
    if (session.sessionId) {
      abort().catch(console.error)
    }
  }, [session.sessionId, abort])

  const handleApprove = useCallback(
    (message?: string) => approve(true, message).catch(console.error),
    [approve]
  )

  const handleReject = useCallback(
    (message?: string) => approve(false, message).catch(console.error),
    [approve]
  )

  const handleSend = useCallback(
    (message: string) => sendMessage(message).catch(console.error),
    [sendMessage]
  )

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

  // Show panel if we have a session (even if idle/interrupted)
  const hasSession = !!session.sessionId
  const canStart = task.agent_id && !session.sessionId && !startingRef.current
    && task.status !== 'completed' && task.status !== 'cancelled'

  return (
    <>
      <div className={`grid ${hasSession ? 'grid-cols-2' : 'grid-cols-1'} relative`} style={{ height: '100%' }}>
        <div className="min-h-0 min-w-0 flex flex-col">
          <AgentApprovalBanner
            request={session.pendingApproval}
            onApprove={handleApprove}
            onReject={handleReject}
          />
          <TaskDetailView
            task={task}
            agents={agents}
            onEdit={onEdit}
            onDelete={onDelete}
            onUpdateChecklist={onUpdateChecklist}
            onUpdateAttachments={onUpdateAttachments}
            onAssignAgent={handleAssignAgent}
            onStartAgent={handleStartSession}
            canStartAgent={!!canStart}
          />
        </div>

        {hasSession && (
          <div className="min-h-0 min-w-0">
            <AgentTranscriptPanel
              messages={session.messages}
              status={session.status}
              onStop={handleAbort}
              onSend={handleSend}
            />
          </div>
        )}

        <WorktreeProgressOverlay taskId={task.id} visible={isSettingUpWorktree} />
      </div>

      <GhCliSetupDialog
        open={showGhSetup}
        onOpenChange={setShowGhSetup}
        onComplete={handleGhSetupComplete}
      />

      {githubOrg && (
        <RepoSelectorDialog
          open={showRepoSelector}
          onOpenChange={setShowRepoSelector}
          org={githubOrg}
          initialRepos={task.repos}
          onConfirm={handleReposConfirmed}
        />
      )}
    </>
  )
}
