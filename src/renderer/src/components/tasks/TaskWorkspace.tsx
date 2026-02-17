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
import { taskApi, worktreeApi, githubApi, taskSourceApi, onAgentIncompatibleSession } from '@/lib/ipc-client'
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
  const { removeSession } = useAgentStore()
  const { githubOrg, checkGhCli, fetchSettings } = useSettingsStore()

  const [showGhSetup, setShowGhSetup] = useState(false)
  const [showRepoSelector, setShowRepoSelector] = useState(false)
  const [isSettingUpWorktree, setIsSettingUpWorktree] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const [showSnooze, setShowSnooze] = useState(false)
  const [showIncompatibleSession, setShowIncompatibleSession] = useState(false)
  const [incompatibleSessionError, setIncompatibleSessionError] = useState<string>()
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
  useEffect(() => {
    if (session.sessionId && task?.status === TaskStatus.Completed) {
      stop()
        .then(() => {
          if (task && task.repos.length > 0 && githubOrg) {
            worktreeApi.cleanup(task.id, task.repos.map((r) => ({ fullName: r })), githubOrg).catch(console.error)
          }
        })
        .catch(console.error)
    }
  }, [task?.status, session.sessionId, stop, task, githubOrg])

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
      if (!agentId && session.sessionId) {
        stop().then(() => removeSession(task.id)).catch(console.error)
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
    // Show feedback if there's an active session OR a resumable session
    const hasActiveSession = session.sessionId && session.messages.length > 0
    const hasResumableSession = !session.sessionId && task?.session_id

    console.log('[TaskWorkspace] Complete check:', {
      hasActiveSession,
      hasResumableSession,
      sessionId: session.sessionId,
      taskSessionId: task?.session_id,
      messagesCount: session.messages.length
    })

    if (hasActiveSession || hasResumableSession) {
      setShowFeedback(true)
    } else {
      await onCompleteTask()
    }
  }, [session.sessionId, session.messages.length, task?.session_id, onCompleteTask])

  const handleFeedbackSubmit = useCallback(async (rating: number, comment: string) => {
    if (!task?.agent_id || !task?.id) return
    setShowFeedback(false)

    // Set task to Learning status - prevents auto-stop useEffect
    console.log('[TaskWorkspace] Setting task status to AgentLearning:', task.id)
    await taskApi.update(task.id, { status: TaskStatus.AgentLearning })
    console.log('[TaskWorkspace] Task status set to AgentLearning')

    // Build feedback prompt
    const commentPart = comment ? ` Comment: "${comment}".` : ''
    const today = new Date().toISOString().split('T')[0]
    const prompt = `User rated this session ${rating}/5.${commentPart}

Review the session and update skills in .agents/skills/:

**For skills you used:**
Update the YAML frontmatter:
- confidence: ${rating >= 4 ? '+0.05 (was helpful)' : rating <= 2 ? '-0.10 (was wrong/outdated)' : 'no change'}
- uses: increment by 1
- lastUsed: ${today}
- tags: add relevant keywords if missing

**If you discovered a new reusable pattern:**
Create a new skill file with:
\`\`\`yaml
---
name: skill-name
description: Brief description of when to use this skill
confidence: 0.5
uses: 1
lastUsed: ${today}
tags:
  - relevant-tag
---
# Skill content here
\`\`\`

Update existing skills that were helpful or create new ones for patterns worth reusing.`

    try {
      // If no active session, resume from task.session_id
      if (!session.sessionId && task.session_id) {
        console.log('[TaskWorkspace] Resuming session for feedback:', task.session_id)
        console.log('[TaskWorkspace] Current session state before resume:', session)

        await resume(task.agent_id, task.id, task.session_id)
        console.log('[TaskWorkspace] Resume completed successfully')

        const afterResumeSession = useAgentStore.getState().sessions.get(task.id)
        console.log('[TaskWorkspace] Session state after resume:', afterResumeSession)

        // Wait for messages to load (poll for session to be ready)
        console.log('[TaskWorkspace] Waiting for messages to load...')
        await new Promise<void>((resolve) => {
          const checkReady = () => {
            const latestSession = useAgentStore.getState().sessions.get(task.id)
            console.log('[TaskWorkspace] Checking session ready:', {
              hasSession: !!latestSession,
              messageCount: latestSession?.messages.length || 0
            })
            if (latestSession?.messages && latestSession.messages.length > 0) {
              console.log('[TaskWorkspace] Messages loaded, proceeding')
              resolve()
            } else {
              setTimeout(checkReady, 500)
            }
          }
          setTimeout(checkReady, 500)
          // Timeout after 10 seconds
          setTimeout(() => {
            console.log('[TaskWorkspace] Timeout waiting for messages, proceeding anyway')
            resolve()
          }, 10000)
        })
      }

      console.log('[TaskWorkspace] About to send feedback message')
      // Send feedback message through normal flow so it shows in UI
      await sendMessage(prompt)
      console.log('[TaskWorkspace] Feedback message sent')

      // Backend will handle skill sync and task completion when session goes idle
    } catch (error) {
      console.error('Failed to send feedback:', error)
      await taskApi.update(task.id, { status: TaskStatus.ReadyForReview })
    }
  }, [task?.agent_id, task?.id, task?.session_id, session.sessionId, resume, sendMessage])

  const handleFeedbackSkip = useCallback(async () => {
    if (!task?.id) return
    setShowFeedback(false)
    // Just keep it in ReadyForReview - user can complete manually
  }, [task?.id])

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
      // Stop current session if it exists
      if (session.sessionId) {
        await stop()
      }
      // Remove session from store and clear task's session_id
      await removeSession(task.id)
      if (onUpdateTask) {
        await onUpdateTask(task.id, { session_id: null })
      }

      console.log('[TaskWorkspace] Starting fresh session, repos:', task.repos, 'githubOrg:', githubOrg)

      // If task has repos and gh is configured, setup worktrees first
      if (task.repos.length > 0 && githubOrg) {
        console.log('[TaskWorkspace] Setting up worktrees for', task.repos.length, 'repos')
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

      // Start fresh session
      await start(task.agent_id, task.id)
    } catch (err) {
      console.error('Failed to start fresh session:', err)
      setIsSettingUpWorktree(false)
    } finally {
      startingRef.current = false
    }
  }, [task?.agent_id, task?.id, task?.repos, session.sessionId, start, stop, removeSession, onUpdateTask, githubOrg])

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
              onRestart={handleStartFreshSession}
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
