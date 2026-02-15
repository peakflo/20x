import { LayoutList } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { FeedbackDialog } from './FeedbackDialog'
import { SnoozeDialog } from './SnoozeDialog'
import { IncompatibleSessionDialog } from './IncompatibleSessionDialog'
import { TaskDetailView } from './TaskDetailView'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { AgentApprovalBanner } from '@/components/agents/AgentApprovalBanner'
import { GhCliSetupDialog } from '@/components/github/GhCliSetupDialog'
import { RepoSelectorDialog } from '@/components/github/RepoSelectorDialog'
import { WorktreeProgressOverlay } from '@/components/github/WorktreeProgressOverlay'
import { useAgentSession } from '@/hooks/use-agent-session'
import { useAgentStore } from '@/stores/agent-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useTaskStore } from '@/stores/task-store'
import { taskApi, worktreeApi, githubApi, agentSessionApi, taskSourceApi, onAgentIncompatibleSession } from '@/lib/ipc-client'
import { useEffect, useCallback, useRef, useState } from 'react'
import { TaskStatus } from '@/types'
import type { WorkfloTask, FileAttachment, OutputField, Agent } from '@/types'
import type { GitHubRepo } from '@/types/electron'

interface TaskWorkspaceProps {
  task?: WorkfloTask
  agents: Agent[]
  onEdit: () => void
  onDelete: () => void
  onUpdateAttachments: (attachments: FileAttachment[]) => void
  onUpdateOutputFields: (fields: OutputField[]) => void
  onCompleteTask: () => void
  onAssignAgent: (taskId: string, agentId: string | null) => void
  onUpdateTask?: (taskId: string, data: Partial<WorkfloTask>) => Promise<void>
}

export function TaskWorkspace({
  task,
  agents,
  onEdit,
  onDelete,
  onUpdateAttachments,
  onUpdateOutputFields,
  onCompleteTask,
  onAssignAgent,
  onUpdateTask
}: TaskWorkspaceProps) {
  const { session, start, resume, abort, stop, sendMessage, approve } = useAgentSession(task?.id)
  const { removeSession, getSession } = useAgentStore()
  const { githubOrg, checkGhCli, fetchSettings } = useSettingsStore()

  const [showGhSetup, setShowGhSetup] = useState(false)
  const [showRepoSelector, setShowRepoSelector] = useState(false)
  const [isSettingUpWorktree, setIsSettingUpWorktree] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const [showSnooze, setShowSnooze] = useState(false)
  const [showIncompatibleSession, setShowIncompatibleSession] = useState(false)
  const [incompatibleSessionError, setIncompatibleSessionError] = useState<string>()
  const learningRef = useRef(false)
  const startingRef = useRef(false)

  const { fetchTasks } = useTaskStore()

  // Fetch settings on mount
  useEffect(() => { fetchSettings() }, [])

  // Listen for incompatible session events
  useEffect(() => {
    if (!task?.id) return

    const handleIncompatibleSession = (data: { taskId: string; error: string }) => {
      if (data.taskId === task.id) {
        setIncompatibleSessionError(data.error)
        setShowIncompatibleSession(true)
      }
    }

    const unsubscribe = onAgentIncompatibleSession(handleIncompatibleSession)

    return () => {
      unsubscribe()
    }
  }, [task?.id])

  // Re-fetch tasks when agent status changes (status is updated in DB by agent-manager)
  const prevStatusRef = useRef(session.status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = session.status
    if (prev !== session.status) {
      fetchTasks()
    }
  }, [session.status, fetchTasks])

  // Stop session when task is completed, but keep transcript
  // Skip if learning is in progress — learnFromSession cleans up on main process
  useEffect(() => {
    if (session.sessionId && task?.status === TaskStatus.Completed && !learningRef.current) {
      // Pass false for resetTaskStatus - this is automatic cleanup, not manual user action
      stop(false)
        .then(() => {
          if (task && task.repos.length > 0 && githubOrg) {
            worktreeApi.cleanup(task.id, task.repos.map((r) => ({ fullName: r })), githubOrg).catch(console.error)
          }
        })
        .catch(console.error)
    }
  }, [task?.status, session.sessionId])

  const handleStartSession = useCallback(async () => {
    if (!task?.agent_id || startingRef.current || session.sessionId) return
    startingRef.current = true

    try {
      // If task has repos and gh is configured, setup worktrees first
      if (task.repos.length > 0 && githubOrg) {
        setIsSettingUpWorktree(true)
        const repoData = await githubApi.fetchOrgRepos(githubOrg)
        const matched = task.repos
          .map((name) => repoData.find((r) => r.fullName === name))
          .filter(Boolean) as GitHubRepo[]

        if (matched.length > 0) {
          const workspaceDir = await worktreeApi.setup(
            task.id,
            matched.map((r) => ({ fullName: r.fullName, defaultBranch: r.defaultBranch })),
            githubOrg
          )
          setIsSettingUpWorktree(false)
          await start(task.agent_id, task.id, workspaceDir)
          return
        }
        setIsSettingUpWorktree(false)
      }

      await start(task.agent_id, task.id)
    } catch (err) {
      console.error('Failed to start session:', err)
      setIsSettingUpWorktree(false)
    } finally {
      startingRef.current = false
    }
  }, [task?.agent_id, task?.id, task?.repos, session.sessionId, githubOrg, start])

  const handleResumeSession = useCallback(async () => {
    if (!task?.agent_id || !task?.session_id || startingRef.current || session.sessionId) return
    startingRef.current = true
    try {
      await resume(task.agent_id, task.id, task.session_id)
    } catch (err) {
      console.error('Failed to resume session:', err)
      // Session expired — refresh tasks to clear session_id in UI
      fetchTasks()
    } finally {
      startingRef.current = false
    }
  }, [task?.agent_id, task?.id, task?.session_id, session.sessionId, resume, fetchTasks])

  const handleGhSetupComplete = useCallback(() => {
    setShowGhSetup(false)
  }, [])

  const handleAddRepos = useCallback(async () => {
    const cliStatus = await checkGhCli()
    if (!cliStatus.installed || !cliStatus.authenticated || !githubOrg) {
      setShowGhSetup(true)
      return
    }
    setShowRepoSelector(true)
  }, [githubOrg, checkGhCli])

  const handleReposConfirmed = useCallback(async (selectedRepos: GitHubRepo[]) => {
    if (!task) return
    setShowRepoSelector(false)
    const repoNames = selectedRepos.map((r) => r.fullName)
    const merged = [...new Set([...task.repos, ...repoNames])]
    if (onUpdateTask) {
      await onUpdateTask(task.id, { repos: merged })
    } else {
      await taskApi.update(task.id, { repos: merged })
    }
    fetchTasks()
  }, [task, onUpdateTask, fetchTasks])

  const handleUpdateRepos = useCallback(async (repos: string[]) => {
    if (!task) return
    if (onUpdateTask) {
      await onUpdateTask(task.id, { repos })
    } else {
      await taskApi.update(task.id, { repos })
    }
    fetchTasks()
  }, [task, onUpdateTask, fetchTasks])

  const handleAssignAgent = useCallback(
    (agentId: string | null) => {
      if (!task) return

      // If unassigning, stop and remove session entirely
      // Pass true for resetTaskStatus - user is manually stopping the agent
      if (!agentId && session.sessionId) {
        stop(true).then(() => removeSession(task.id)).catch(console.error)
      }

      onAssignAgent(task.id, agentId)
    },
    [task, session.sessionId, stop, onAssignAgent, removeSession]
  )

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
    (message: string) => {
      // Check if this is a question answer (for permission requests)
      // Question answers should use approve() instead of sendMessage()
      const lastMessage = session.messages[session.messages.length - 1]
      if (lastMessage?.partType === 'question' && lastMessage?.tool?.questions) {
        // This is an answer to a question - use approve
        approve(true, message).catch(console.error)
      } else {
        // Regular message
        sendMessage(message).catch(console.error)
      }
    },
    [sendMessage, approve, session.messages]
  )

  // ── Feedback orchestration ──────────────────────────────────

  const handleCompleteTask = useCallback(async () => {
    // Show feedback dialog if there's an active session OR a resumable session
    if (session.sessionId && session.messages.length > 0) {
      // Active session with messages - show feedback
      setShowFeedback(true)
    } else if (task?.session_id && !session.sessionId && task?.agent_id) {
      // Resumable session - show feedback (will resume when user submits)
      setShowFeedback(true)
    } else {
      // No session - just complete
      await onCompleteTask()
    }
  }, [task?.session_id, task?.agent_id, session.sessionId, session.messages.length, onCompleteTask])

  const handleFeedbackSubmit = useCallback(async (rating: number, comment: string) => {
    setShowFeedback(false)

    let sid = session.sessionId

    // If there's a resumable session but not active, resume it first
    if (task?.session_id && !session.sessionId && task?.agent_id && task?.id) {
      console.log('[TaskWorkspace] Resuming session before sending feedback')
      await handleResumeSession()

      // Wait for session to be initialized AND previous messages to load (poll up to 10 seconds)
      // Read from store directly to get latest session state
      const startTime = Date.now()
      const maxWait = 10000
      let messagesLoaded = false

      while (Date.now() - startTime < maxWait) {
        const latestSession = getSession(task.id)
        if (latestSession?.sessionId) {
          sid = latestSession.sessionId
          // Also check if messages have been loaded (wait for at least 1 message or 2 seconds)
          if (latestSession.messages.length > 0 || Date.now() - startTime > 2000) {
            messagesLoaded = true
            console.log('[TaskWorkspace] Session initialized with', latestSession.messages.length, 'messages')
            break
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      if (!sid) {
        console.error('[TaskWorkspace] Session failed to initialize after 10s')
      } else if (!messagesLoaded) {
        console.warn('[TaskWorkspace] Session initialized but no messages loaded yet')
      }
    }

    if (!sid) {
      console.error('[TaskWorkspace] No session ID, cannot send feedback')
      return
    }

    // Send learning prompt - session continues, agent responds in UI
    // Session will become idle when agent finishes, then skills are synced
    console.log('[TaskWorkspace] Sending learning prompt with sessionId:', sid)
    agentSessionApi.learnFromSession(sid, rating, comment || undefined).catch(console.error)

    // Keep session active - user can see the agent's learning response
    // They can complete the task manually after reviewing the agent's work
  }, [task?.session_id, task?.agent_id, task?.id, session.sessionId, handleResumeSession, getSession])

  const handleFeedbackSkip = useCallback(async () => {
    setShowFeedback(false)
    await onCompleteTask()
  }, [onCompleteTask])

  const handleSnooze = useCallback(async (isoString: string) => {
    if (!task) return
    setShowSnooze(false)
    if (onUpdateTask) {
      await onUpdateTask(task.id, { snoozed_until: isoString })
    } else {
      await taskApi.update(task.id, { snoozed_until: isoString })
    }
    fetchTasks()
  }, [task, onUpdateTask, fetchTasks])

  const handleUnsnooze = useCallback(async () => {
    if (!task) return
    if (onUpdateTask) {
      await onUpdateTask(task.id, { snoozed_until: null })
    } else {
      await taskApi.update(task.id, { snoozed_until: null })
    }
    fetchTasks()
  }, [task, onUpdateTask, fetchTasks])

  const handleReassign = useCallback(async (userIds: string[], displayName: string) => {
    if (!task) return
    const result = await taskSourceApi.reassign(task.id, userIds, displayName)
    if (result.success) {
      if (onUpdateTask) await onUpdateTask(task.id, { assignee: displayName })
      fetchTasks()
    } else {
      console.error('[workspace] Reassign failed:', result.error)
    }
  }, [task, onUpdateTask, fetchTasks])

  const handleStartFreshSession = useCallback(async () => {
    if (!task?.agent_id) return
    startingRef.current = true
    try {
      await start(task.agent_id, task.id)
    } catch (err) {
      console.error('Failed to start fresh session:', err)
    } finally {
      startingRef.current = false
    }
  }, [task?.agent_id, task?.id, start])

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

  // Show panel if session exists (active or past transcript with messages)
  const showPanel = session.status !== 'idle' || session.messages.length > 0
  const canResume = task.agent_id && task.session_id && !session.sessionId && session.status === 'idle' && session.messages.length === 0
  const canRestart = task.agent_id && task.session_id && !session.sessionId && session.status === 'idle' && session.messages.length > 0
  const canStart = task.agent_id && !task.session_id && !session.sessionId && session.status === 'idle'
    && task.status !== TaskStatus.Completed

  return (
    <>
      <div className={`grid ${showPanel ? 'grid-cols-2' : 'grid-cols-1'} relative`} style={{ height: '100%' }}>
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

            onUpdateAttachments={onUpdateAttachments}
            onUpdateOutputFields={onUpdateOutputFields}
            onCompleteTask={handleCompleteTask}
            onAssignAgent={handleAssignAgent}
            onUpdateRepos={handleUpdateRepos}
            onAddRepos={handleAddRepos}
            onUpdateSkillIds={async (skillIds) => {
              if (onUpdateTask) await onUpdateTask(task.id, { skill_ids: skillIds })
            }}
            onStartAgent={handleStartSession}
            canStartAgent={!!canStart}
            onResumeAgent={handleResumeSession}
            canResumeAgent={!!canResume}
            onRestartAgent={handleStartFreshSession}
            canRestartAgent={!!canRestart}
            onSnooze={() => setShowSnooze(true)}
            onUnsnooze={handleUnsnooze}
            onReassign={handleReassign}
          />
        </div>

        {showPanel && (
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

      <FeedbackDialog
        open={showFeedback}
        onSubmit={handleFeedbackSubmit}
        onSkip={handleFeedbackSkip}
      />

      <SnoozeDialog
        open={showSnooze}
        onOpenChange={setShowSnooze}
        onSnooze={handleSnooze}
      />

      <IncompatibleSessionDialog
        open={showIncompatibleSession}
        onOpenChange={setShowIncompatibleSession}
        onStartFresh={handleStartFreshSession}
        error={incompatibleSessionError}
      />
    </>
  )
}
