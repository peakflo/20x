import { LayoutList } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { FeedbackDialog } from './FeedbackDialog'
import { SnoozeDialog } from './SnoozeDialog'
import { IncompatibleSessionDialog } from './IncompatibleSessionDialog'
import { TaskDetailView } from './TaskDetailView'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { AgentApprovalBanner } from '@/components/agents/AgentApprovalBanner'
import { GhCliSetupDialog } from '@/components/github/GhCliSetupDialog'
import { OrgPickerDialog } from '@/components/github/OrgPickerDialog'
import { RepoSelectorDialog } from '@/components/github/RepoSelectorDialog'
import { WorktreeProgressOverlay } from '@/components/github/WorktreeProgressOverlay'
import { useAgentSession } from '@/hooks/use-agent-session'
import { useAgentStore } from '@/stores/agent-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useTaskStore } from '@/stores/task-store'
import { taskApi, worktreeApi, taskSourceApi, onAgentIncompatibleSession, onWorktreeProgress } from '@/lib/ipc-client'
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
  const { githubOrg, checkGhCli, setGithubOrg, fetchSettings } = useSettingsStore()

  const [showGhSetup, setShowGhSetup] = useState(false)
  const [showOrgPicker, setShowOrgPicker] = useState(false)
  const [showRepoSelector, setShowRepoSelector] = useState(false)
  const [isSettingUpWorktree, setIsSettingUpWorktree] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const [showSnooze, setShowSnooze] = useState(false)
  const [showIncompatibleSession, setShowIncompatibleSession] = useState(false)
  const [incompatibleSessionError, setIncompatibleSessionError] = useState<string>()
  const startingRef = useRef(false)

  const { fetchTasks, updateTask: updateTaskInStore } = useTaskStore()

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

  // Drive worktree progress overlay from IPC events
  useEffect(() => {
    if (!task?.id) return

    const unsubscribe = onWorktreeProgress((event) => {
      if (event.taskId !== task.id) return
      if (event.done) {
        // Check if all repos are done — hide overlay
        setIsSettingUpWorktree(false)
      } else {
        setIsSettingUpWorktree(true)
      }
    })

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

  // Stop session when task transitions to completed, but keep transcript
  // Uses ref to track previous status — prevents auto-stop on resume of already-completed tasks
  const prevTaskStatusRef = useRef(task?.status)
  useEffect(() => {
    const prevStatus = prevTaskStatusRef.current
    prevTaskStatusRef.current = task?.status
    if (session.sessionId && task?.status === TaskStatus.Completed && prevStatus !== TaskStatus.Completed) {
      stop()
        .then(() => {
          if (task && task.repos.length > 0 && githubOrg) {
            worktreeApi.cleanup(task.id, task.repos.map((r) => ({ fullName: r })), githubOrg).catch(console.error)
          }
        })
        .catch(console.error)
    }
    // Clean up triage session when triage completes (Triaging → NotStarted)
    if (prevStatus === TaskStatus.Triaging && task?.status === TaskStatus.NotStarted) {
      removeSession(task.id)
    }
  }, [task?.status, session.sessionId, stop, task, githubOrg, removeSession])

  const handleStartSession = useCallback(async () => {
    if (!task?.agent_id || startingRef.current || session.sessionId) return
    startingRef.current = true

    try {
      await start(task.agent_id, task.id)
    } catch (err) {
      console.error('Failed to start session:', err)
    } finally {
      startingRef.current = false
    }
  }, [task?.agent_id, task?.id, session.sessionId, start])

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
    // After gh auth, check if org is set — if not, show org picker
    if (!githubOrg) {
      setShowOrgPicker(true)
    } else {
      setShowRepoSelector(true)
    }
  }, [githubOrg])

  const handleOrgSelected = useCallback(async (org: string) => {
    await setGithubOrg(org)
    setShowOrgPicker(false)
    setShowRepoSelector(true)
  }, [setGithubOrg])

  const handleAddRepos = useCallback(async () => {
    const cliStatus = await checkGhCli()
    if (!cliStatus.installed || !cliStatus.authenticated) {
      setShowGhSetup(true)
      return
    }
    if (!githubOrg) {
      setShowOrgPicker(true)
      return
    }
    setShowRepoSelector(true)
  }, [githubOrg, checkGhCli])

  const handleReposConfirmed = useCallback(async (selectedRepos: GitHubRepo[]) => {
    if (!task) return
    setShowRepoSelector(false)
    const repoNames = selectedRepos.map((r) => r.fullName)
    const merged = [...new Set([...task.repos, ...repoNames])]

    // If session is running and there are new repos, setup worktrees immediately
    const newRepos = selectedRepos.filter((r) => !task.repos.includes(r.fullName))
    if (session.sessionId && newRepos.length > 0 && githubOrg) {
      try {
        setIsSettingUpWorktree(true)
        await worktreeApi.setup(
          task.id,
          newRepos.map((r) => ({ fullName: r.fullName, defaultBranch: r.defaultBranch })),
          githubOrg
        )
      } catch (err) {
        console.error('Failed to setup worktrees for new repos:', err)
      } finally {
        setIsSettingUpWorktree(false)
      }
    }

    if (onUpdateTask) {
      await onUpdateTask(task.id, { repos: merged })
    } else {
      await taskApi.update(task.id, { repos: merged })
    }
    fetchTasks()
  }, [task, onUpdateTask, fetchTasks, session.sessionId, githubOrg])

  const handleUpdateRepos = useCallback(async (repos: string[]) => {
    if (!task) return

    // If session is running and repos were removed, cleanup their worktrees
    const removedRepos = task.repos.filter((r) => !repos.includes(r))
    if (session.sessionId && removedRepos.length > 0 && githubOrg) {
      worktreeApi
        .cleanup(task.id, removedRepos.map((r) => ({ fullName: r })), githubOrg, false)
        .catch((err) => console.error('Failed to cleanup removed repo worktrees:', err))
    }

    if (onUpdateTask) {
      await onUpdateTask(task.id, { repos })
    } else {
      await taskApi.update(task.id, { repos })
    }
    fetchTasks()
  }, [task, onUpdateTask, fetchTasks, session.sessionId, githubOrg])

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

  const handleTriage = useCallback(async () => {
    if (!task || task.agent_id) return

    // Find the default agent
    const defaultAgent = agents.find((a) => a.is_default) || agents[0]
    if (!defaultAgent) return

    try {
      // Set status to Triaging
      await taskApi.update(task.id, { status: TaskStatus.Triaging })
      updateTaskInStore(task.id, { status: TaskStatus.Triaging })

      // Start the default agent for triage
      await start(defaultAgent.id, task.id)
    } catch (error) {
      console.error('[TaskWorkspace] Triage failed:', error)
      // Revert status
      await taskApi.update(task.id, { status: TaskStatus.NotStarted })
      updateTaskInStore(task.id, { status: TaskStatus.NotStarted })
    }
  }, [task, agents, start, updateTaskInStore])

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

    // Persist feedback + set task to Learning status - prevents auto-stop useEffect
    console.log('[TaskWorkspace] Setting task status to AgentLearning:', task.id)
    const updatedTask = await taskApi.update(task.id, {
      status: TaskStatus.AgentLearning,
      feedback_rating: rating,
      feedback_comment: comment || null
    })
    console.log('[TaskWorkspace] Task status set to AgentLearning, verified:', updatedTask?.status)

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
      // Verify task status is still AgentLearning before sending
      const taskBeforeSend = await taskApi.getById(task.id)
      console.log('[TaskWorkspace] Task status before sending message:', taskBeforeSend?.status)
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
    // Mark task as completed when skipping feedback (updates local state without refetch)
    if (onUpdateTask) {
      await onUpdateTask(task.id, { status: TaskStatus.Completed })
    } else {
      await updateTaskInStore(task.id, { status: TaskStatus.Completed })
    }
  }, [task?.id, onUpdateTask, updateTaskInStore])

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

      await start(task.agent_id, task.id)
    } catch (err) {
      console.error('Failed to start fresh session:', err)
    } finally {
      startingRef.current = false
    }
  }, [task?.agent_id, task?.id, session.sessionId, start, stop, removeSession, onUpdateTask])

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
  const canTriage = !task.agent_id && agents.length > 0 && session.status === 'idle'
    && task.status !== TaskStatus.Completed && task.status !== TaskStatus.Triaging

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
            onTriage={handleTriage}
            canTriage={!!canTriage}
          />
        </div>

        {showPanel && (
          <div className="min-h-0 min-w-0 h-full">
            <AgentTranscriptPanel
              messages={session.messages}
              status={session.status}
              onStop={handleAbort}
              onRestart={handleStartFreshSession}
              onSend={handleSend}
              className="h-full"
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

      <OrgPickerDialog
        open={showOrgPicker}
        onOpenChange={setShowOrgPicker}
        onSelect={handleOrgSelected}
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
