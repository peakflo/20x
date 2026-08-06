import { LayoutList, Send, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { FeedbackDialog } from './FeedbackDialog'
import { SnoozeDialog } from './SnoozeDialog'
import { IncompatibleSessionDialog } from './IncompatibleSessionDialog'
import { TaskDetailView } from './TaskDetailView'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { ChangesPanel } from './ChangesPanel'
import { OutputFieldsDisplay } from './OutputFieldsDisplay'
import { TaskHeaderBar, TaskPrimaryAction } from './TaskHeaderBar'
import { AgentApprovalBanner } from '@/components/agents/AgentApprovalBanner'
import { GhCliSetupDialog } from '@/components/github/GhCliSetupDialog'
import { OrgPickerDialog } from '@/components/github/OrgPickerDialog'
import { RepoSelectorDialog } from '@/components/github/RepoSelectorDialog'
import { SkillSelectorDialog } from '@/components/skills/SkillSelectorDialog'
import { AgentFormDialog } from '@/components/settings/forms/AgentFormDialog'
import { WorktreeProgressOverlay } from '@/components/github/WorktreeProgressOverlay'
import { useAgentSession } from '@/hooks/use-agent-session'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useSettingsStore, type GitProvider } from '@/stores/settings-store'
import { useTaskStore } from '@/stores/task-store'
import { taskApi, worktreeApi, taskSourceApi, onAgentIncompatibleSession, onWorktreeProgress, attachmentApi } from '@/lib/ipc-client'
import { subscribe } from '@/lib/shared-ipc-listeners'
import { memo, useEffect, useCallback, useRef, useState, useMemo, type PointerEvent as ReactPointerEvent } from 'react'
import { TaskStatus } from '@/types'
import type { WorkfloTask, FileAttachment, OutputField, Agent, UpdateAgentDTO, CreateAgentDTO } from '@/types'
import type { GitHubRepo } from '@/types/electron'
import { isAgentConfigured } from '@shared/agent-utils'
import { useUIStore } from '@/stores/ui-store'
import { useArtifactStore, PinnedArtifactTabId } from '@/stores/artifact-store'
import { artifactApi } from '@/lib/ipc-client'
import { ArtifactType } from '@shared/artifacts'
import { ArtifactsPanel } from '@/components/artifacts/ArtifactsPanel'
import { ArtifactRail } from '@/components/artifacts/ArtifactRail'
import type { Artifact, ArtifactUIState } from '@shared/artifacts'

const EMPTY_ARTIFACTS: Artifact[] = []
const DEFAULT_ARTIFACT_UI: ArtifactUIState = { open: false, activeTabId: null, railExpanded: false }

/** Controls which columns are visible in the TaskWorkspace grid */
export type TaskWorkspaceLayout = 'both' | 'task-only' | 'transcript-only'

interface TaskWorkspaceProps {
  task?: WorkfloTask
  agents: Agent[]
  onEdit: () => void
  onDelete: () => void
  onUpdateAttachments: (attachments: FileAttachment[]) => void
  onUpdateOutputFields: (fields: OutputField[]) => void
  onCompleteTask: () => void
  onAssignAgent: (taskId: string, agentId: string | null) => void
  onUpdateTask?: (taskId: string, data: Record<string, unknown>) => Promise<void>
  onNavigateToTask?: (taskId: string) => void
  /** When provided, each subtask shows an action to open it as a separate canvas window/panel. */
  onOpenSubtaskInWindow?: (taskId: string) => void
  onBack?: () => void
  /** Override the layout — which panels to show. Default: 'both' */
  panelLayout?: TaskWorkspaceLayout
}

function TaskWorkspaceComponent({
  task,
  agents,
  onEdit,
  onDelete,
  onUpdateAttachments,
  onUpdateOutputFields,
  onCompleteTask,
  onAssignAgent,
  onUpdateTask,
  onNavigateToTask,
  onOpenSubtaskInWindow,
  onBack,
  panelLayout = 'both'
}: TaskWorkspaceProps) {
  const { session, start, resume, abort, stop, sendMessage, approve } = useAgentSession(task?.id)
  // Per-field selectors: a selector-less useStore() subscribes to the whole
  // store, re-rendering this entire workspace on every streamed delta of every
  // task's session (agent store) or any settings change. Action identities are
  // stable, so these selectors never trigger re-renders themselves.
  const removeSession = useAgentStore((s) => s.removeSession)
  const updateAgent = useAgentStore((s) => s.updateAgent)
  const githubOrg = useSettingsStore((s) => s.githubOrg)
  const checkGhCli = useSettingsStore((s) => s.checkGhCli)
  const checkGlabCli = useSettingsStore((s) => s.checkGlabCli)
  const setGithubOrg = useSettingsStore((s) => s.setGithubOrg)
  const fetchSettings = useSettingsStore((s) => s.fetchSettings)

  const [changesSummary, setChangesSummary] = useState<{ files: number; additions: number; deletions: number } | null>(null)
  const [kickoffMessage, setKickoffMessage] = useState('')
  const [showGhSetup, setShowGhSetup] = useState(false)
  const [showOrgPicker, setShowOrgPicker] = useState(false)
  const [showRepoSelector, setShowRepoSelector] = useState(false)
  const [showSkillSelector, setShowSkillSelector] = useState(false)
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [orgProvider, setOrgProvider] = useState<GitProvider>('github')
  const [isSettingUpWorktree, setIsSettingUpWorktree] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const [showSnooze, setShowSnooze] = useState(false)
  const [showIncompatibleSession, setShowIncompatibleSession] = useState(false)
  const [incompatibleSessionError, setIncompatibleSessionError] = useState<string>()
  const [parentTask, setParentTask] = useState<WorkfloTask | null>(null)
  const startingRef = useRef(false)
  const workspaceBodyRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef(false)
  const [transcriptWidth, setTranscriptWidth] = useState(() => {
    const stored = Number(localStorage.getItem('20x:task:transcriptWidth'))
    return Number.isFinite(stored) && stored >= 320 ? stored : Math.max(320, Math.round(window.innerWidth * 0.44))
  })
  const openTaskOnCanvas = useUIStore((s) => s.openTaskOnCanvas)
  const artifacts = useArtifactStore((s) => task?.id ? (s.artifactsByTask[task.id] || EMPTY_ARTIFACTS) : EMPTY_ARTIFACTS)
  const artifactUI = useArtifactStore((s) => task?.id ? (s.uiByTask[task.id] || DEFAULT_ARTIFACT_UI) : DEFAULT_ARTIFACT_UI)
  const hydrateArtifacts = useArtifactStore((s) => s.hydrate)
  const selectArtifactTab = useArtifactStore((s) => s.selectTab)
  const removeArtifact = useArtifactStore((s) => s.removeArtifact)
  const setArtifactsOpen = useArtifactStore((s) => s.setOpen)
  const setRailExpanded = useArtifactStore((s) => s.setRailExpanded)
  const upsertArtifact = useArtifactStore((s) => s.upsertArtifact)

  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const updateTaskInStore = useTaskStore((s) => s.updateTask)

  // Derive subtasks reactively from the task store so status changes (e.g., from
  // mobile-initiated sessions) update immediately without needing a re-fetch.
  const allTasks = useTaskStore((s) => s.tasks)
  const subtasks = useMemo(() => {
    if (!task) return []
    return allTasks
      .filter((t) => t.parent_task_id === task.id)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.created_at.localeCompare(b.created_at))
  }, [allTasks, task?.id])

  useEffect(() => {
    if (!task?.id) return
    void hydrateArtifacts(task.id, artifactApi).catch((error) => {
      console.error('[TaskWorkspace] Failed to hydrate artifacts:', error)
    })
  }, [hydrateArtifacts, task?.id])

  const handleResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current || !workspaceBodyRef.current) return
    const rect = workspaceBodyRef.current.getBoundingClientRect()
    const next = Math.max(320, Math.min(event.clientX - rect.left, Math.max(320, rect.width - 320)))
    setTranscriptWidth(next)
  }, [])

  const handleResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current) return
    resizingRef.current = false
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    localStorage.setItem('20x:task:transcriptWidth', String(transcriptWidth))
  }, [transcriptWidth])

  // Fetch settings on mount
  useEffect(() => { fetchSettings() }, [])

  // Fetch parent task when task changes
  useEffect(() => {
    if (!task) {
      setParentTask(null)
      return
    }
    if (task.parent_task_id) {
      taskApi.getById(task.parent_task_id).then(p => setParentTask(p ?? null)).catch(() => setParentTask(null))
    } else {
      setParentTask(null)
    }
  }, [task?.id, task?.parent_task_id])

  // Create a subtask under the current task
  const handleAddSubtask = useCallback(async (title: string) => {
    if (!task) return
    try {
      const newSubtask = await taskApi.create({
        title,
        parent_task_id: task.id,
        type: task.type as 'general' | 'coding' | 'manual' | 'review' | 'approval',
        priority: task.priority as 'critical' | 'high' | 'medium' | 'low',
        repos: task.repos,
      })
      if (newSubtask) {
        fetchTasks() // Refresh store — subtasks are derived reactively
      }
    } catch (err) {
      console.error('[TaskWorkspace] Failed to create subtask:', err)
    }
  }, [task, fetchTasks])

  // Reorder subtasks via drag-and-drop
  const handleReorderSubtasks = useCallback(async (orderedIds: string[]) => {
    if (!task) return
    try {
      await taskApi.reorderSubtasks(task.id, orderedIds)
      fetchTasks() // Refresh store — subtasks are derived reactively
    } catch (err) {
      console.error('[TaskWorkspace] Failed to reorder subtasks:', err)
      fetchTasks() // Re-fetch to restore actual order
    }
  }, [task, fetchTasks])

  // Listen for incompatible session events (shared listener to avoid MaxListeners warning)
  useEffect(() => {
    if (!task?.id) return

    return subscribe<{ taskId: string; agentId: string; error: string }>(
      'agent:incompatible-session',
      (cb) => onAgentIncompatibleSession(cb),
      (data) => {
        if (data.taskId === task.id) {
          setIncompatibleSessionError(data.error)
          setShowIncompatibleSession(true)
        }
      }
    )
  }, [task?.id])

  // Drive worktree progress overlay from IPC events (shared listener)
  useEffect(() => {
    if (!task?.id) return

    return subscribe(
      'worktree:progress',
      (cb) => onWorktreeProgress(cb),
      (event: { taskId?: string; done?: boolean }) => {
        if (event.taskId !== task.id) return
        setIsSettingUpWorktree(!event.done)
      }
    )
  }, [task?.id])

  // Re-fetch tasks when agent status changes (status is updated in DB by agent-manager).
  // Debounced to 500ms to prevent cascading re-fetches when multiple canvas panels
  // observe simultaneous status transitions — each would otherwise trigger an
  // independent fetchTasks() call that replaces the entire tasks array and causes
  // a cascade of re-renders through AppLayout → all child components.
  const prevStatusRef = useRef(session.status)
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = session.status
    if (prev !== session.status) {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current)
      fetchDebounceRef.current = setTimeout(() => {
        fetchDebounceRef.current = null
        fetchTasks()
      }, 500)
    }
    return () => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current)
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

  // Clean up stale triage session when returning to a task that was triaged while unmounted.
  // If the task is no longer Triaging, has no persisted session_id, but the in-memory session
  // still has a sessionId (leftover from the triage agent), remove it so the Start button shows.
  useEffect(() => {
    if (
      task &&
      task.status !== TaskStatus.Triaging &&
      !task.session_id &&
      session.sessionId &&
      session.status === SessionStatus.IDLE
    ) {
      removeSession(task.id)
    }
  }, [task?.id]) // intentionally run only on mount/task switch

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

  const handleOrgSelected = useCallback(async (org: string, provider: GitProvider) => {
    await setGithubOrg(org)
    setOrgProvider(provider)
    setShowOrgPicker(false)
    setShowRepoSelector(true)
  }, [setGithubOrg])

  const handleAddRepos = useCallback(async () => {
    // Check if at least one git provider is authenticated
    const [ghStatus, glabStatus] = await Promise.all([
      checkGhCli().catch(() => ({ installed: false, authenticated: false })),
      checkGlabCli().catch(() => ({ installed: false, authenticated: false }))
    ])
    const anyAuthed = (ghStatus.installed && ghStatus.authenticated) ||
                      (glabStatus.installed && glabStatus.authenticated)
    if (!anyAuthed) {
      setShowGhSetup(true)
      return
    }
    if (!githubOrg) {
      setShowOrgPicker(true)
      return
    }
    setShowRepoSelector(true)
  }, [githubOrg, checkGhCli, checkGlabCli])

  const handleReposConfirmed = useCallback(async (selectedRepos: GitHubRepo[], selectedOrg: string, selectedProvider: GitProvider) => {
    if (!task) return
    setShowRepoSelector(false)

    if (selectedOrg && selectedOrg !== githubOrg) {
      await setGithubOrg(selectedOrg)
    }
    setOrgProvider(selectedProvider)

    const repoNames = selectedRepos.map((r) => r.fullName)
    const merged = [...new Set([...task.repos, ...repoNames])]

    // If the task already has a live or persisted coding session, provision the
    // new repo worktrees immediately so the agent can use them without restart.
    const newRepos = selectedRepos.filter((r) => !task.repos.includes(r.fullName))
    const hasActiveOrPersistedSession = !!(session.sessionId || task.session_id)
    if (hasActiveOrPersistedSession && newRepos.length > 0 && selectedOrg) {
      try {
        setIsSettingUpWorktree(true)
        await worktreeApi.setup(
          task.id,
          newRepos.map((r) => ({ fullName: r.fullName, defaultBranch: r.defaultBranch })),
          selectedOrg,
          selectedProvider
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
  }, [task, onUpdateTask, fetchTasks, session.sessionId, githubOrg, setGithubOrg])

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

  const ensureChatSession = useCallback(async (): Promise<string | null> => {
    if (!task?.agent_id) return null

    const latestSession = useAgentStore.getState().sessions.get(task.id)
    if (latestSession?.sessionId) return latestSession.sessionId

    if (task.session_id) {
      const resumedSessionId = await resume(task.agent_id, task.id, task.session_id)
      if (!resumedSessionId) {
        fetchTasks()
        return null
      }
      return resumedSessionId
    }

    return start(task.agent_id, task.id)
  }, [fetchTasks, resume, start, task?.agent_id, task?.id, task?.session_id])

  const handleSend = useCallback(
    async (message: string, options?: { attachments?: Array<{ id: string; filename: string; size: number; mime_type: string }> }) => {
      // Read messages from the store at call time instead of closing over the
      // render-time array: depending on `session.messages` gives this callback
      // a new identity on every streamed delta, which defeats React.memo on
      // every transcript row receiving it as a prop.
      const messages = (task?.id && useAgentStore.getState().sessions.get(task.id)?.messages) || []
      // Route unresolved question responses through approve(), even if status lags.
      let questionIndex = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].partType === 'question' && messages[i].tool?.questions) {
          questionIndex = i
          break
        }
      }
      const hasActiveQuestion = questionIndex >= 0
        && !messages.slice(questionIndex + 1).some((m) => m.role === 'user')
      if (hasActiveQuestion) {
        await approve(true, message)
        return
      }

      const readySessionId = await ensureChatSession()
      if (!readySessionId) return
      await sendMessage(message, options)
    },
    [approve, ensureChatSession, sendMessage, task?.id]
  )

  const handleAddAttachmentPaths = useCallback(async (filePaths: string[]) => {
    if (!task?.id || filePaths.length === 0) return []
    const saved = await Promise.all(filePaths.map((fp) => attachmentApi.save(task.id, fp)))
    const merged = [...task.attachments]
    const seen = new Set(merged.map((a) => a.id))
    for (const attachment of saved) {
      if (seen.has(attachment.id)) continue
      seen.add(attachment.id)
      merged.push(attachment)
    }
    onUpdateAttachments(merged)
    return saved
  }, [onUpdateAttachments, task?.attachments, task?.id])

  const handlePickAttachments = useCallback(async () => {
    if (!task?.id) return []
    const filePaths = await attachmentApi.pick()
    if (!filePaths.length) return []
    return handleAddAttachmentPaths(filePaths)
  }, [handleAddAttachmentPaths, task?.id])

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
      if (!session.sessionId) {
        const readySessionId = await ensureChatSession()
        if (!readySessionId) return

        // Wait for messages to load (poll for session to be ready)
        await new Promise<void>((resolve) => {
          const checkReady = () => {
            const latestSession = useAgentStore.getState().sessions.get(task.id)
            if (latestSession?.messages && latestSession.messages.length > 0) {
              resolve()
            } else {
              setTimeout(checkReady, 500)
            }
          }
          setTimeout(checkReady, 500)
          // Timeout after 10 seconds
          setTimeout(() => {
            resolve()
          }, 10000)
        })
      }

      // Send feedback message through normal flow so it shows in UI
      await sendMessage(prompt)

      // Backend will handle skill sync and task completion when session goes idle
    } catch (error) {
      console.error('Failed to send feedback:', error)
      await taskApi.update(task.id, { status: TaskStatus.ReadyForReview })
    }
  }, [ensureChatSession, sendMessage, session.sessionId, task?.id])

  const handleFeedbackSkip = useCallback(async () => {
    if (!task?.id) return
    setShowFeedback(false)
    // Use the main completion path which calls executeAction for
    // enterprise tasks (notifying the Workflo backend) before setting
    // the local status to Completed.
    await onCompleteTask()
  }, [task?.id, onCompleteTask])

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

  const handleEditAgent = useCallback((agentId: string) => setEditingAgentId(agentId), [])
  const handleSaveAgent = useCallback(async (data: CreateAgentDTO | UpdateAgentDTO) => {
    if (!editingAgentId) return
    await updateAgent(editingAgentId, data as UpdateAgentDTO)
    setEditingAgentId(null)
  }, [editingAgentId, updateAgent])

  const handleUpdateSkillIds = useCallback(async (skillIds: string[] | null) => {
    if (task?.id && onUpdateTask) await onUpdateTask(task.id, { skill_ids: skillIds })
  }, [onUpdateTask, task?.id])
  const handleUpdateDescription = useCallback(async (description: string) => {
    if (!task?.id) return
    if (onUpdateTask) {
      await onUpdateTask(task.id, { description })
    } else {
      await taskApi.update(task.id, { description })
      updateTaskInStore(task.id, { description })
    }
  }, [onUpdateTask, task?.id, updateTaskInStore])
  const handleShowSkillSelector = useCallback(() => setShowSkillSelector(true), [])
  const handleShowSnooze = useCallback(() => setShowSnooze(true), [])
  const handleUpdateAutoFlags = useCallback(async (updates: Record<string, unknown>) => {
    if (!task?.id) return
    if (onUpdateTask) {
      await onUpdateTask(task.id, updates)
    } else {
      await taskApi.update(task.id, updates)
      updateTaskInStore(task.id, updates)
    }
  }, [onUpdateTask, task?.id, updateTaskInStore])

  const handleRename = useCallback(async (title: string) => {
    if (!task?.id) return
    if (onUpdateTask) await onUpdateTask(task.id, { title })
    else {
      await taskApi.update(task.id, { title })
      updateTaskInStore(task.id, { title })
    }
  }, [onUpdateTask, task?.id, updateTaskInStore])

  const handleOpenFolder = useCallback(async () => {
    if (!task?.id) return
    const workspaceDir = await window.electronAPI.tasks.getWorkspaceDir(task.id)
    await window.electronAPI.shell.openPath(workspaceDir)
  }, [task?.id])

  const handleKickoff = useCallback(async () => {
    const message = kickoffMessage.trim()
    if (!message) return
    if (!task?.agent_id) {
      await handleTriage()
      return
    }
    setKickoffMessage('')
    await handleSend(message)
  }, [handleSend, handleTriage, kickoffMessage, task?.agent_id])

  const handlePullRequests = useCallback((pullRequests: Array<{ repo: string; prNumber?: number; prUrl?: string; prState?: string; prTitle?: string; ciStatus?: 'passing' | 'failing' | 'pending' | 'none' }>) => {
    if (!task?.id) return
    for (const pullRequest of pullRequests) {
      if (!pullRequest.prUrl) continue
      upsertArtifact({
        taskId: task.id,
        type: ArtifactType.PR,
        title: pullRequest.prTitle || `Pull request #${pullRequest.prNumber || ''}`.trim(),
        url: pullRequest.prUrl,
        updatedAt: Date.now()
      }, false)
    }
  }, [task?.id, upsertArtifact])

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

  // Persisted sessions count as started even before their transcript is hydrated.
  const hasSession = !!task.session_id || !!session.sessionId || session.status !== SessionStatus.IDLE || session.messages.length > 0
  const assignedAgent = task.agent_id ? agents.find((a) => a.id === task.agent_id) : null
  const assignedAgentConfigured = isAgentConfigured(assignedAgent)
  // Triage uses the default agent (or the first agent in the list as a fallback).
  const triageAgent = !task.agent_id ? (agents.find((a) => a.is_default) || agents[0] || null) : null
  const triageAgentConfigured = isAgentConfigured(triageAgent)
  const canResume = task.agent_id && task.session_id && !session.sessionId && session.status === SessionStatus.IDLE && session.messages.length === 0
  const canRestart = task.agent_id && task.session_id && !session.sessionId && session.status === SessionStatus.IDLE && session.messages.length > 0
  const canStart = task.agent_id && assignedAgentConfigured && !task.session_id && !session.sessionId && session.status === SessionStatus.IDLE
    && task.status !== TaskStatus.Completed
  const canTriage = !task.agent_id && agents.length > 0 && triageAgentConfigured && session.status === SessionStatus.IDLE
    && task.status !== TaskStatus.Completed && task.status !== TaskStatus.Triaging

  let primaryAction: TaskPrimaryAction | null = null
  let handlePrimaryAction: (() => void) | undefined
  if (task.status === TaskStatus.ReadyForReview || task.status === TaskStatus.Completed) {
    if (task.status !== TaskStatus.Completed) {
      primaryAction = TaskPrimaryAction.COMPLETE
      handlePrimaryAction = () => void handleCompleteTask()
    }
  } else if (canStart) {
    primaryAction = TaskPrimaryAction.START
    handlePrimaryAction = () => void handleStartSession()
  } else if (canResume) {
    primaryAction = TaskPrimaryAction.RESUME
    handlePrimaryAction = () => void handleResumeSession()
  } else if (canRestart) {
    primaryAction = TaskPrimaryAction.RESTART
    handlePrimaryAction = () => void handleStartFreshSession()
  } else if (canTriage) {
    primaryAction = TaskPrimaryAction.TRIAGE
    handlePrimaryAction = () => void handleTriage()
  }

  const editingAgent = editingAgentId ? agents.find((a) => a.id === editingAgentId) : undefined

  const detailsView = (
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
      onUpdateSkillIds={handleUpdateSkillIds}
      onUpdateDescription={handleUpdateDescription}
      onAddSkills={handleShowSkillSelector}
      onStartAgent={handleStartSession}
      canStartAgent={!!canStart}
      onResumeAgent={handleResumeSession}
      canResumeAgent={!!canResume}
      onRestartAgent={handleStartFreshSession}
      canRestartAgent={!!canRestart}
      onSnooze={handleShowSnooze}
      onUnsnooze={handleUnsnooze}
      onReassign={handleReassign}
      onTriage={handleTriage}
      canTriage={!!canTriage}
      onEditAgent={handleEditAgent}
      onUpdateAutoFlags={handleUpdateAutoFlags}
      subtasks={subtasks}
      parentTask={parentTask}
      onNavigateToTask={onNavigateToTask}
      onOpenSubtaskInWindow={onOpenSubtaskInWindow}
      onAddSubtask={handleAddSubtask}
      onReorderSubtasks={handleReorderSubtasks}
      displayMode={hasSession ? 'panel' : 'prestart'}
      showOutputFields={!hasSession || panelLayout === 'task-only'}
      showPrimaryActions={!hasSession || panelLayout === 'task-only'}
    />
  )

  const transcriptView = (
    <div className="flex h-full min-h-0 flex-col bg-[#0d1117]">
      <AgentApprovalBanner request={session.pendingApproval} onApprove={handleApprove} onReject={handleReject} />
      <AgentTranscriptPanel
        messages={session.messages}
        status={session.status}
        systemStatus={session.systemStatus}
        onStop={handleAbort}
        onRestart={handleStartFreshSession}
        onSend={handleSend}
        onPickAttachments={handlePickAttachments}
        onAddAttachmentPaths={handleAddAttachmentPaths}
        sessionId={session.sessionId}
        taskId={task.id}
        agentId={task.agent_id ?? undefined}
        pendingApproval={session.pendingApproval ?? undefined}
        pendingSend={session.pendingSend}
        className="h-full min-h-0 border-0 bg-[#0d1117]"
      />
    </div>
  )

  const openDetails = () => {
    if (artifactUI.open && artifactUI.activeTabId === PinnedArtifactTabId.DETAILS) setArtifactsOpen(task.id, false)
    else selectArtifactTab(task.id, PinnedArtifactTabId.DETAILS, true)
  }

  return (
    <>
      <div className="relative flex h-full min-h-0 flex-col bg-[#0d1117]">
        <TaskHeaderBar
          task={task}
          agent={assignedAgent}
          action={primaryAction}
          onAction={handlePrimaryAction}
          onBack={onBack}
          onRename={handleRename}
          detailsOpen={artifactUI.open && artifactUI.activeTabId === PinnedArtifactTabId.DETAILS}
          showDetailsToggle={hasSession && panelLayout === 'both'}
          onToggleDetails={openDetails}
          onEdit={onEdit}
          onSnooze={handleShowSnooze}
          onOpenCanvas={() => openTaskOnCanvas(task.id)}
          onOpenFolder={() => void handleOpenFolder()}
          onDelete={onDelete}
        />
        <div ref={workspaceBodyRef} className="relative flex min-h-0 flex-1 overflow-hidden">
          {panelLayout === 'task-only' || (!hasSession && panelLayout === 'both') ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#0d1117]">
              <div className="min-h-0 flex-1">{detailsView}</div>
              {!hasSession && panelLayout === 'both' && task.status !== TaskStatus.Completed && (
                <div className="sticky bottom-0 mx-auto w-full max-w-[780px] shrink-0 border-t border-border/50 bg-[#0d1117]/95 px-6 py-3 backdrop-blur">
                  <div className="flex items-end gap-2 rounded-xl border border-border/50 bg-[#161b22] p-2 shadow-lg">
                    <textarea
                      value={kickoffMessage}
                      onChange={(event) => setKickoffMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void handleKickoff() }
                      }}
                      placeholder={task.agent_id ? 'Add kickoff instructions…' : 'Add context, then triage this task…'}
                      className="max-h-32 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground"
                      aria-label="Kickoff instructions"
                    />
                    <Button onClick={() => void handleKickoff()} disabled={!kickoffMessage.trim()} className="h-9 gap-1.5">
                      {task.agent_id ? <Send className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                      {task.agent_id ? 'Start' : 'Triage'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : panelLayout === 'transcript-only' ? (
            <div className="min-h-0 min-w-0 flex-1">{transcriptView}</div>
          ) : (
            <>
              <div className="min-h-0 min-w-0 shrink-0" style={{ width: artifactUI.open ? transcriptWidth : 'auto', flex: artifactUI.open ? undefined : 1 }}>
                {transcriptView}
              </div>
              {artifactUI.open ? (
                <>
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize transcript"
                    onPointerDown={(event) => { resizingRef.current = true; event.currentTarget.setPointerCapture(event.pointerId) }}
                    onPointerMove={handleResizeMove}
                    onPointerUp={handleResizeEnd}
                    onPointerCancel={handleResizeEnd}
                    className="group relative w-1 shrink-0 cursor-col-resize bg-border/50 hover:bg-primary/50"
                  />
                  <ArtifactsPanel
                    taskId={task.id}
                    artifacts={artifacts}
                    ui={artifactUI}
                    artifactApi={artifactApi}
                    hasChanges={task.repos.length > 0}
                    hasOutput={task.output_fields.length > 0}
                    changesCount={changesSummary?.files}
                    onSelectTab={(tabId) => selectArtifactTab(task.id, tabId, true)}
                    onCloseTab={(artifactId) => removeArtifact(task.id, artifactId)}
                    onToggleOpen={() => setArtifactsOpen(task.id, false)}
                    onToggleRail={() => setRailExpanded(task.id, !artifactUI.railExpanded)}
                    details={detailsView}
                    changes={<ChangesPanel taskId={task.id} repos={task.repos} className="h-full" onSummary={setChangesSummary} onPullRequests={handlePullRequests} />}
                    output={<OutputFieldsDisplay fields={task.output_fields} onChange={onUpdateOutputFields} isActive={task.status !== TaskStatus.Completed} onComplete={handleCompleteTask} taskUpdatedAt={task.updated_at} />}
                    className="min-w-[320px] flex-1 border-l border-border/50"
                  />
                </>
              ) : (
                <>
                <ArtifactRail
                  artifacts={artifacts}
                  expanded={artifactUI.railExpanded}
                  activeTabId={artifactUI.activeTabId}
                  agentActive={session.status === SessionStatus.WORKING}
                  hasChanges={task.repos.length > 0}
                  hasOutput={task.output_fields.length > 0}
                  changesCount={changesSummary?.files}
                  onSelectTab={(tabId) => selectArtifactTab(task.id, tabId, true)}
                  onToggleExpanded={() => setRailExpanded(task.id, !artifactUI.railExpanded)}
                />
                <div className="hidden">
                  <ChangesPanel taskId={task.id} repos={task.repos} onSummary={setChangesSummary} onPullRequests={handlePullRequests} />
                </div>
                </>
              )}
            </>
          )}
        </div>
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
          orgProvider={orgProvider}
          initialRepos={task.repos}
          onConfirm={handleReposConfirmed}
        />
      )}

      <SkillSelectorDialog
        open={showSkillSelector}
        onOpenChange={setShowSkillSelector}
        initialSkillIds={task.skill_ids ?? []}
        onConfirm={async (skillIds) => {
          if (onUpdateTask) await onUpdateTask(task.id, { skill_ids: skillIds })
        }}
      />

      <FeedbackDialog
        open={showFeedback}
        onSubmit={handleFeedbackSubmit}
        onSkip={handleFeedbackSkip}
        onCancel={() => setShowFeedback(false)}
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

      <AgentFormDialog
        agent={editingAgent}
        open={!!editingAgentId}
        onClose={() => setEditingAgentId(null)}
        onSubmit={handleSaveAgent}
      />
    </>
  )
}

export const TaskWorkspace = memo(TaskWorkspaceComponent)
