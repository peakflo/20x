import { useEffect, useRef, useCallback } from 'react'
import { useAgentSchedulerStore } from '@/stores/agent-scheduler-store'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useAgentSession } from './use-agent-session'
import { onAgentStatus, onTaskUpdated, onTaskCreated, taskApi } from '@/lib/ipc-client'
import { TaskStatus } from '@/types'
import type { WorkfloTask, Agent, TaskPriority } from '@/types'
import type { AgentStatusEvent } from '@/types/electron.d'
import type { TaskSession } from '@/stores/agent-store'

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0
}

const MAX_TRIAGE_ATTEMPTS = 2

interface UseAgentAutoStartProps {
  tasks: WorkfloTask[]
  agents: Agent[]
  /** @deprecated sessions are now read via getState() to avoid reactive re-renders in AppLayout */
  sessions?: Map<string, TaskSession>
  showToast: (message: string, isError?: boolean) => void
}

export function useAgentAutoStart({ tasks, agents, showToast }: UseAgentAutoStartProps) {
  // Read sessions non-reactively to avoid re-rendering the entire AppLayout on every agent message.
  // Effects that need current session state call getSessionsSnapshot() at execution time.
  const getSessionsSnapshot = useCallback(() => useAgentStore.getState().sessions, [])
  const {
    isEnabled,
    incrementRunningCount,
    decrementRunningCount,
    getRunningCount,
    addToQueue,
    removeFromQueue,
    getNextQueuedTask,
    clearQueues
  } = useAgentSchedulerStore()

  // ── Refs for stable callback references ──────────────────────────
  // Store tasks/agents/showToast in refs so callbacks and IPC listeners
  // don't need them as useCallback dependencies. This prevents the O(N)
  // callback recreation and IPC listener un-/re-subscription that
  // previously occurred on every task:updated event — the primary cause
  // of the renderer's 100% CPU usage when multiple agents are active.
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const showToastRef = useRef(showToast)
  showToastRef.current = showToast

  const { start } = useAgentSession(undefined)

  // Track processed task updates to avoid duplicates
  const processedUpdatesRef = useRef<Set<string>>(new Set())

  // Track tasks currently being triaged
  const triagingRef = useRef<Set<string>>(new Set())

  // Track triage attempts per task to prevent infinite retry
  const triageAttemptsRef = useRef<Map<string, number>>(new Map())

  // Track parent tasks currently launching a subtask to prevent duplicate launches
  const launchingSubtaskForRef = useRef<Set<string>>(new Set())

  // Helper: Check if task is snoozed
  const isSnoozed = useCallback((snoozedUntil: string | null): boolean => {
    if (!snoozedUntil) return false
    return new Date(snoozedUntil) > new Date()
  }, [])

  // Helper: Check if task is a recurring parent template (should never be triaged or auto-started)
  const isRecurringTemplate = useCallback((task: WorkfloTask): boolean => {
    return task.is_recurring && !task.recurrence_parent_id
  }, [])

  // Helper: Start the next eligible subtask for a parent task.
  // Fetches fresh subtask data from DB, enforces sequential execution,
  // and marks parent as ReadyForReview when all subtasks are completed.
  const startNextSubtask = useCallback(
    async (parentId: string) => {
      // Prevent concurrent launches for the same parent
      if (launchingSubtaskForRef.current.has(parentId)) {
        console.log(`[AutoStart] Already launching subtask for parent ${parentId}, skipping`)
        return
      }
      launchingSubtaskForRef.current.add(parentId)

      try {
        // Check parent task status — only start subtasks if parent is NotStarted
        const parentTask = await taskApi.getById(parentId)
        if (!parentTask || parentTask.status !== TaskStatus.NotStarted) {
          console.log(`[AutoStart] Parent ${parentId} status is ${parentTask?.status ?? 'unknown'}, not starting subtasks`)
          return
        }

        const subtasks = await taskApi.getSubtasks(parentId)
        const sorted = subtasks.sort(
          (a: WorkfloTask, b: WorkfloTask) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
        )

        if (sorted.length === 0) return

        // Check if all subtasks are completed → mark parent as ready for review
        if (sorted.every((s: WorkfloTask) => s.status === TaskStatus.Completed)) {
          console.log(`[AutoStart] All subtasks completed for parent ${parentId}, marking parent as ready for review`)
          await taskApi.update(parentId, { status: TaskStatus.ReadyForReview })
          return
        }

        // If any subtask is currently active (working/review/triaging/learning), wait
        const hasActive = sorted.some(
          (s: WorkfloTask) =>
            s.status === TaskStatus.AgentWorking ||
            s.status === TaskStatus.ReadyForReview ||
            s.status === TaskStatus.Triaging ||
            s.status === TaskStatus.AgentLearning
        )
        if (hasActive) {
          console.log(`[AutoStart] A subtask is still active for parent ${parentId}, waiting`)
          return
        }

        // Find next not_started subtask with an assigned agent
        const nextSubtask = sorted.find(
          (s: WorkfloTask) => s.status === TaskStatus.NotStarted && !!s.agent_id
        )
        if (!nextSubtask || !nextSubtask.agent_id) {
          console.log(`[AutoStart] No eligible next subtask for parent ${parentId}`)
          return
        }

        const subtaskAgent = agentsRef.current.find((a) => a.id === nextSubtask.agent_id)
        if (!subtaskAgent) {
          console.log(`[AutoStart] Agent ${nextSubtask.agent_id} not found for subtask ${nextSubtask.id}`)
          return
        }

        console.log(`[AutoStart] Starting next subtask "${nextSubtask.title}" (${nextSubtask.id}) for parent ${parentId}`)
        const maxParallel = subtaskAgent.config.max_parallel_sessions || 1
        const currentRunning = getRunningCount(nextSubtask.agent_id)
        if (currentRunning < maxParallel) {
          incrementRunningCount(nextSubtask.agent_id)
          try {
            await start(nextSubtask.agent_id, nextSubtask.id)
            showToastRef.current(`Started subtask "${nextSubtask.title}" with ${subtaskAgent.name}`)
          } catch (error) {
            console.error(`[AutoStart] Failed to start subtask ${nextSubtask.id}:`, error)
            decrementRunningCount(nextSubtask.agent_id)
          }
        } else {
          addToQueue(nextSubtask.agent_id, nextSubtask.id)
        }
      } catch (error) {
        console.error(`[AutoStart] startNextSubtask error for parent ${parentId}:`, error)
      } finally {
        // Remove lock after a delay to allow status propagation
        setTimeout(() => launchingSubtaskForRef.current.delete(parentId), 2000)
      }
    },
    [getRunningCount, incrementRunningCount, start, decrementRunningCount, addToQueue]
  )

  // Helper: Select triage candidates (tasks with no agent_id that need triage)
  const selectTriageCandidates = useCallback(
    (allTasks: WorkfloTask[], allSessions: Map<string, TaskSession>): string[] => {
      return allTasks
        .filter((task) => {
          // Skip recurring parent template tasks — they are templates, not actionable tasks
          if (isRecurringTemplate(task)) return false

          // Skip subtasks — they are managed by sequential subtask orchestration
          if (task.parent_task_id) return false

          const isNotStarted = task.status === TaskStatus.NotStarted
          const hasNoAgent = !task.agent_id
          const notSnoozed = !isSnoozed(task.snoozed_until)
          const noSession = !allSessions.has(task.id)
          const notAlreadyTriaging = !triagingRef.current.has(task.id)
          const attempts = triageAttemptsRef.current.get(task.id) || 0
          const withinRetryLimit = attempts < MAX_TRIAGE_ATTEMPTS

          return isNotStarted && hasNoAgent && notSnoozed && noSession && notAlreadyTriaging && withinRetryLimit
        })
        .map((task) => task.id)
    },
    [isSnoozed, isRecurringTemplate]
  )

  // Helper: Start triage for a task
  const startTriage = useCallback(
    async (taskId: string) => {
      // Find default agent (read from ref for stability)
      const currentAgents = agentsRef.current
      const defaultAgent = currentAgents.find((a) => a.is_default) || currentAgents[0]
      if (!defaultAgent) {
        console.log('[AutoStart] No agents available for triage')
        return
      }

      const task = tasksRef.current.find((t) => t.id === taskId)
      if (!task) return

      console.log(`[AutoStart] Starting triage for task "${task.title}" with default agent ${defaultAgent.name}`)

      // Mark as triaging
      triagingRef.current.add(taskId)

      try {
        // Update task status to Triaging
        await taskApi.update(taskId, { status: TaskStatus.Triaging })

        // Start the default agent session for this task
        incrementRunningCount(defaultAgent.id)
        await start(defaultAgent.id, taskId)
      } catch (error) {
        console.error(`[AutoStart] Failed to start triage for task ${taskId}:`, error)
        triagingRef.current.delete(taskId)

        // Revert status to NotStarted
        try {
          await taskApi.update(taskId, { status: TaskStatus.NotStarted })
        } catch {
          // ignore revert error
        }

        decrementRunningCount(defaultAgent.id)
      }
    },
    [incrementRunningCount, start, decrementRunningCount]
  )

  // Helper: Select eligible tasks grouped by agent
  const selectEligibleTasks = useCallback(
    (
      allTasks: WorkfloTask[],
      allSessions: Map<string, TaskSession>
    ): Map<string, string[]> => {
      const tasksByAgent = new Map<string, string[]>()

      allTasks.forEach((task) => {
        // Skip recurring parent template tasks — they are templates, not actionable tasks
        if (isRecurringTemplate(task)) return

        // Skip parent tasks that have subtasks — subtasks will run sequentially instead
        const hasChildren = allTasks.some((t) => t.parent_task_id === task.id)
        if (hasChildren) {
          console.log(`[AutoStart] Task "${task.title}" skipped: has subtasks (will run sequentially)`)
          return
        }

        // For subtasks, enforce sequential execution within parent
        if (task.parent_task_id) {
          // Check parent task status — only start subtasks if parent is NotStarted
          const parentTask = allTasks.find((t) => t.id === task.parent_task_id)
          if (!parentTask || parentTask.status !== TaskStatus.NotStarted) {
            console.log(`[AutoStart] Subtask "${task.title}" skipped: parent status is ${parentTask?.status ?? 'unknown'}`)
            return
          }

          const siblings = allTasks
            .filter((t) => t.parent_task_id === task.parent_task_id)
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

          // Don't start if any sibling is actively being worked on or awaiting review
          const hasActiveSibling = siblings.some(
            (s) =>
              s.id !== task.id &&
              (s.status === TaskStatus.AgentWorking ||
                s.status === TaskStatus.ReadyForReview ||
                s.status === TaskStatus.Triaging ||
                s.status === TaskStatus.AgentLearning)
          )
          if (hasActiveSibling) {
            console.log(`[AutoStart] Subtask "${task.title}" skipped: sibling is still active`)
            return
          }

          // Only start if this is the first not-started subtask (by sort_order)
          const firstNotStarted = siblings.find((s) => s.status === TaskStatus.NotStarted)
          if (firstNotStarted && firstNotStarted.id !== task.id) {
            console.log(`[AutoStart] Subtask "${task.title}" skipped: not next in sequence`)
            return
          }
        }

        // Log why tasks are excluded
        const isNotStarted = task.status === TaskStatus.NotStarted
        const hasAgent = !!task.agent_id
        const notSnoozed = !isSnoozed(task.snoozed_until)
        const noSession = !allSessions.has(task.id)

        if (!isNotStarted || !hasAgent || !notSnoozed || !noSession) {
          console.log(`[AutoStart] Task "${task.title}" not eligible:`, {
            status: task.status,
            isNotStarted,
            hasAgent,
            agentId: task.agent_id,
            notSnoozed,
            noSession
          })
        }

        // Eligibility criteria
        if (isNotStarted && hasAgent && notSnoozed && noSession && task.agent_id) {
          const agentTasks = tasksByAgent.get(task.agent_id) || []
          agentTasks.push(task.id)
          tasksByAgent.set(task.agent_id, agentTasks)
          console.log(`[AutoStart] Task "${task.title}" is eligible for agent ${task.agent_id}`)
        }
      })

      // Sort each agent's tasks by priority
      tasksByAgent.forEach((taskIds, agentId) => {
        const sortedIds = taskIds.sort((aId, bId) => {
          const taskA = allTasks.find((t) => t.id === aId)
          const taskB = allTasks.find((t) => t.id === bId)
          if (!taskA || !taskB) return 0
          return PRIORITY_ORDER[taskB.priority] - PRIORITY_ORDER[taskA.priority]
        })
        tasksByAgent.set(agentId, sortedIds)
      })

      return tasksByAgent
    },
    [isSnoozed, isRecurringTemplate]
  )

  // Helper: Start tasks for an agent (respecting max parallel limit)
  const startTasksForAgent = useCallback(
    async (agentId: string, taskIds: string[], agent: Agent) => {
      const maxParallel = agent.config.max_parallel_sessions || 1
      const currentRunning = getRunningCount(agentId)
      const availableSlots = maxParallel - currentRunning

      if (availableSlots <= 0) {
        // No capacity, queue all tasks
        taskIds.forEach((taskId) => addToQueue(agentId, taskId))
        return
      }

      // Start as many tasks as we have slots for
      const tasksToStart = taskIds.slice(0, availableSlots)
      const tasksToQueue = taskIds.slice(availableSlots)

      // Queue remaining tasks
      tasksToQueue.forEach((taskId) => addToQueue(agentId, taskId))

      // Start tasks
      for (const taskId of tasksToStart) {
        try {
          const task = tasksRef.current.find((t) => t.id === taskId)
          if (!task) continue

          incrementRunningCount(agentId)
          await start(agentId, taskId)

          showToastRef.current(`Started "${task.title}" with ${agent.name}`)
        } catch (error) {
          console.error(`Failed to start task ${taskId}:`, error)
          decrementRunningCount(agentId)
          showToastRef.current(`Failed to start task: ${error}`, true)
        }
      }
    },
    [getRunningCount, addToQueue, incrementRunningCount, start, decrementRunningCount]
  )

  // Helper: Process next task in queue for an agent
  const processNextTask = useCallback(
    async (agentId: string) => {
      const agent = agentsRef.current.find((a) => a.id === agentId)
      if (!agent) return

      const maxParallel = agent.config.max_parallel_sessions || 1
      const currentRunning = getRunningCount(agentId)

      if (currentRunning >= maxParallel) return

      const nextTaskId = getNextQueuedTask(agentId)
      if (!nextTaskId) return

      const task = tasksRef.current.find((t) => t.id === nextTaskId)
      if (!task) {
        removeFromQueue(agentId, nextTaskId)
        return
      }

      // Verify task is still eligible
      if (
        isRecurringTemplate(task) ||
        task.status !== TaskStatus.NotStarted ||
        task.agent_id !== agentId ||
        isSnoozed(task.snoozed_until) ||
        getSessionsSnapshot().has(task.id)
      ) {
        removeFromQueue(agentId, nextTaskId)
        return
      }

      // For subtasks, enforce sequential execution within parent
      if (task.parent_task_id) {
        // Check parent task status — only start subtasks if parent is NotStarted
        const currentTasks = tasksRef.current
        const parentTask = currentTasks.find((t) => t.id === task.parent_task_id)
        if (!parentTask || parentTask.status !== TaskStatus.NotStarted) {
          removeFromQueue(agentId, nextTaskId)
          return
        }

        const siblings = currentTasks.filter((t) => t.parent_task_id === task.parent_task_id)
        const hasActiveSibling = siblings.some(
          (s) =>
            s.id !== task.id &&
            (s.status === TaskStatus.AgentWorking ||
              s.status === TaskStatus.ReadyForReview ||
              s.status === TaskStatus.Triaging ||
              s.status === TaskStatus.AgentLearning)
        )
        if (hasActiveSibling) {
          // Keep in queue — will be started when sibling completes
          console.log(`[AutoStart] Subtask "${task.title}" deferred: sibling still active`)
          return
        }

        const sortedSiblings = siblings.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        const firstNotStarted = sortedSiblings.find((s) => s.status === TaskStatus.NotStarted)
        if (firstNotStarted && firstNotStarted.id !== task.id) {
          removeFromQueue(agentId, nextTaskId)
          return
        }
      }

      // Start the task
      try {
        removeFromQueue(agentId, nextTaskId)
        incrementRunningCount(agentId)
        await start(agentId, nextTaskId)

        showToastRef.current(`Started "${task.title}" with ${agent.name}`)
      } catch (error) {
        console.error(`Failed to start task ${nextTaskId}:`, error)
        decrementRunningCount(agentId)
        showToastRef.current(`Failed to start task: ${error}`, true)
      }
    },
    [
      getSessionsSnapshot,
      getRunningCount,
      getNextQueuedTask,
      removeFromQueue,
      incrementRunningCount,
      isSnoozed,
      isRecurringTemplate,
      start,
      decrementRunningCount
    ]
  )

  // Auto-start eligible tasks when scheduler is enabled or when tasks/agents change.
  // Uses a debounced trigger via a counter ref to avoid reinstalling the effect on
  // every task mutation (the heavy computation runs inside a setTimeout anyway).
  const autoStartTriggerRef = useRef(0)
  useEffect(() => {
    // Bump trigger counter whenever tasks or agents change
    autoStartTriggerRef.current += 1
  }, [tasks, agents])

  useEffect(() => {
    if (!isEnabled) return

    const currentSessions = getSessionsSnapshot()
    const currentTasks = tasksRef.current
    const currentAgents = agentsRef.current
    console.log('[AutoStart] Checking for eligible tasks...', {
      totalTasks: currentTasks.length,
      totalAgents: currentAgents.length,
      activeSessions: currentSessions.size
    })

    // Debounce to avoid rapid-fire starts when multiple tasks/agents change
    const timeoutId = setTimeout(() => {
      const sessions = getSessionsSnapshot()
      const latestTasks = tasksRef.current
      const latestAgents = agentsRef.current

      // Check for triage candidates (tasks with no agent_id)
      const triageCandidates = selectTriageCandidates(latestTasks, sessions)
      if (triageCandidates.length > 0) {
        console.log(`[AutoStart] Found ${triageCandidates.length} triage candidate(s)`)
        triageCandidates.forEach((taskId) => startTriage(taskId))
      }

      // Check for regular auto-start eligible tasks (with agent_id)
      const tasksByAgent = selectEligibleTasks(latestTasks, sessions)

      console.log('[AutoStart] Eligible tasks by agent:',
        Array.from(tasksByAgent.entries()).map(([agentId, taskIds]) => ({
          agentId,
          taskCount: taskIds.length,
          taskIds
        }))
      )

      if (tasksByAgent.size === 0) {
        console.log('[AutoStart] No eligible tasks found')
      }

      tasksByAgent.forEach((taskIds, agentId) => {
        const agent = latestAgents.find((a) => a.id === agentId)
        if (agent && taskIds.length > 0) {
          console.log(`[AutoStart] Starting tasks for agent ${agent.name}:`, taskIds)
          startTasksForAgent(agentId, taskIds, agent)
        }
      })
    }, 300) // 300ms debounce

    return () => clearTimeout(timeoutId)
  }, [isEnabled, tasks, agents, getSessionsSnapshot, selectEligibleTasks, selectTriageCandidates, startTasksForAgent, startTriage])

  // Listen to agent status changes (task completions).
  // IPC listener is installed ONCE (deps are stable thanks to ref pattern).
  useEffect(() => {
    if (!isEnabled) return

    const unsubscribe = onAgentStatus((event: AgentStatusEvent) => {
      // Only process when agent goes idle (task completed)
      if (event.status !== SessionStatus.IDLE) return

      const agentId = event.agentId
      const taskId = event.taskId

      // Handle triage session completion
      if (triagingRef.current.has(taskId)) {
        console.log(`[AutoStart] Triage completed for task ${taskId}`)
        triagingRef.current.delete(taskId)
        decrementRunningCount(agentId)

        // Remove the triage session from the agent store so the task
        // becomes eligible for auto-start (sessions.has(taskId) must be false)
        useAgentStore.getState().removeSession(taskId)

        // Check if the task now has an agent_id assigned
        // Use a slight delay to let the DB update propagate
        setTimeout(async () => {
          const updatedTask = await taskApi.getById(taskId)
          if (updatedTask && !updatedTask.agent_id) {
            const attempts = (triageAttemptsRef.current.get(taskId) || 0) + 1
            triageAttemptsRef.current.set(taskId, attempts)
            if (attempts >= MAX_TRIAGE_ATTEMPTS) {
              showToastRef.current(`Triage failed for "${updatedTask.title}" — please assign an agent manually`, true)
            } else {
              console.log(`[AutoStart] Triage attempt ${attempts} did not assign agent for task ${taskId}, will retry`)
            }
          } else if (updatedTask?.agent_id) {
            // Clean up attempts on success
            triageAttemptsRef.current.delete(taskId)

            // Check if triage created subtasks — if so, start first subtask instead of parent
            const subtasks = await taskApi.getSubtasks(taskId)
            if (subtasks.length > 0) {
              console.log(`[AutoStart] Triage created ${subtasks.length} subtask(s) for "${updatedTask.title}", starting first subtask`)
              await startNextSubtask(taskId)
              return
            }

            const assignedAgentId = updatedTask.agent_id
            const assignedAgent = agentsRef.current.find((a) => a.id === assignedAgentId)
            if (!assignedAgent) {
              showToastRef.current(`Triage assigned an unavailable agent for "${updatedTask.title}"`, true)
              return
            }

            const maxParallel = assignedAgent.config.max_parallel_sessions || 1
            const currentRunning = getRunningCount(assignedAgentId)
            if (currentRunning < maxParallel) {
              void startTasksForAgent(assignedAgentId, [taskId], assignedAgent)
            } else {
              addToQueue(assignedAgentId, taskId)
            }
          }
        }, 500)

        // Try to start next task from queue for this agent
        setTimeout(() => processNextTask(agentId), 100)
        return
      }

      // Decrement running count
      decrementRunningCount(agentId)

      // Check if task was completed
      const task = tasksRef.current.find((t) => t.id === event.taskId)
      if (task?.status === TaskStatus.Completed) {
        const agent = agentsRef.current.find((a) => a.id === agentId)
        if (agent) {
          showToastRef.current(`"${task.title}" completed by ${agent.name}`)
        }
      }

      // Try to start next task from queue
      setTimeout(() => {
        processNextTask(agentId)
      }, 100)
    })

    return unsubscribe
  }, [isEnabled, decrementRunningCount, processNextTask, getRunningCount, addToQueue, startTasksForAgent, startNextSubtask])

  // Listen to new task creation — trigger triage for tasks with no agent_id
  useEffect(() => {
    if (!isEnabled) return

    const unsubscribe = onTaskCreated((event) => {
      const task = event.task as WorkfloTask
      // Skip recurring parent template tasks
      if (task.is_recurring && !task.recurrence_parent_id) return
      // Skip subtasks — they are managed by sequential subtask orchestration
      if (task.parent_task_id) return
      if (
        task.status === TaskStatus.NotStarted &&
        !task.agent_id &&
        !isSnoozed(task.snoozed_until) &&
        !triagingRef.current.has(task.id)
      ) {
        console.log(`[AutoStart] New task created without agent: "${task.title}", triggering triage`)
        setTimeout(() => startTriage(task.id), 200)
      }
    })

    return unsubscribe
  }, [isEnabled, isSnoozed, startTriage])

  // Auto-start recurring instances with auto_start_agent flag
  // Runs regardless of global scheduler state — the session check prevents double-starts
  useEffect(() => {
    const unsubscribe = onTaskCreated((event) => {
      const task = event.task as WorkfloTask

      // Log all recurring instances for debugging
      if (task.recurrence_parent_id) {
        console.log(`[AutoStart] Received task:created for recurring instance "${task.title}"`, {
          auto_start_agent: task.auto_start_agent,
          agent_id: task.agent_id,
          status: task.status,
          recurrence_parent_id: task.recurrence_parent_id
        })
      }

      // Only handle recurring instances (not templates) with auto_start_agent enabled
      if (!task.auto_start_agent || !task.recurrence_parent_id) return
      if (task.status !== TaskStatus.NotStarted || !task.agent_id) return
      if (isSnoozed(task.snoozed_until)) return
      if (getSessionsSnapshot().has(task.id)) return

      const agentId = task.agent_id
      const agent = agentsRef.current.find((a) => a.id === agentId)
      if (!agent) return

      console.log(`[AutoStart] Recurring instance "${task.title}" passed all checks, starting agent ${agent.name}`)
      const maxParallel = agent.config.max_parallel_sessions || 1
      const currentRunning = getRunningCount(agentId)
      if (currentRunning < maxParallel) {
        // Start directly — don't use startTasksForAgent because it looks up the
        // task in the (stale) tasks array which doesn't include this new instance yet.
        setTimeout(async () => {
          try {
            incrementRunningCount(agentId)
            await start(agentId, task.id)
            showToastRef.current(`Auto-started "${task.title}" with ${agent.name}`)
          } catch (error) {
            console.error(`[AutoStart] Failed to auto-start recurring instance ${task.id}:`, error)
            decrementRunningCount(agentId)
          }
        }, 500)
      } else {
        addToQueue(agentId, task.id)
      }
    })

    return unsubscribe
  }, [isSnoozed, getSessionsSnapshot, getRunningCount, incrementRunningCount, decrementRunningCount, start, addToQueue])

  // Auto-complete tasks with auto_complete_without_review flag when they reach ReadyForReview
  useEffect(() => {
    const unsubscribe = onTaskUpdated((event) => {
      if (event.updates?.status !== TaskStatus.ReadyForReview) return

      // Try local tasks first, fall back to DB fetch for recently-created recurring instances
      const localTask = tasksRef.current.find((t) => t.id === event.taskId)

      const doAutoComplete = async (baseTask: WorkfloTask) => {
        const merged = { ...baseTask, ...event.updates } as WorkfloTask
        if (!merged.auto_complete_without_review) return

        console.log(`[AutoStart] Task "${merged.title}" has auto_complete_without_review, auto-completing`)
        try {
          await taskApi.update(event.taskId, { status: TaskStatus.Completed })
          showToastRef.current(`Auto-completed "${merged.title}"`)
        } catch (error) {
          console.error(`[AutoStart] Failed to auto-complete task ${event.taskId}:`, error)
        }
      }

      if (localTask) {
        setTimeout(() => doAutoComplete(localTask), 500)
      } else {
        // Task not in renderer yet — fetch from DB
        setTimeout(async () => {
          const freshTask = await taskApi.getById(event.taskId)
          if (freshTask) doAutoComplete(freshTask)
        }, 500)
      }
    })

    return unsubscribe
  }, [])

  // Listen to task updates (new tasks or reassignments).
  // IPC listener is installed ONCE (deps are stable thanks to ref pattern).
  useEffect(() => {
    if (!isEnabled) return

    const unsubscribe = onTaskUpdated((event) => {
      const updateKey = `${event.taskId}-${JSON.stringify(event.updates)}`

      // Debounce duplicate updates
      if (processedUpdatesRef.current.has(updateKey)) return
      processedUpdatesRef.current.add(updateKey)
      setTimeout(() => processedUpdatesRef.current.delete(updateKey), 1000)

      const staleTask = tasksRef.current.find((t) => t.id === event.taskId)
      if (!staleTask) return

      // Merge event updates with stale task to get current state
      const task = { ...staleTask, ...event.updates } as WorkfloTask

      // Skip recurring parent template tasks
      if (task.is_recurring && !task.recurrence_parent_id) return

      // Handle subtask completion — trigger next subtask or mark parent as done
      if (task.parent_task_id && task.status === TaskStatus.Completed) {
        console.log(`[AutoStart] Subtask "${task.title}" completed, checking for next subtask`)
        setTimeout(() => startNextSubtask(task.parent_task_id!), 300)
        return
      }

      // Check if task is eligible for auto-start (has agent_id)
      if (
        task.status === TaskStatus.NotStarted &&
        task.agent_id &&
        !isSnoozed(task.snoozed_until) &&
        !getSessionsSnapshot().has(task.id)
      ) {
        // Skip if task is being handled by triage completion (avoids race condition)
        if (triagingRef.current.has(task.id)) return

        const agentId = task.agent_id
        const agent = agentsRef.current.find((a) => a.id === agentId)
        if (!agent) return

        // Check if this parent task has subtasks — start first subtask instead
        setTimeout(async () => {
          try {
            const subtasks = await taskApi.getSubtasks(task.id)
            if (subtasks.length > 0) {
              console.log(`[AutoStart] Task "${task.title}" has ${subtasks.length} subtask(s), starting first subtask instead`)
              await startNextSubtask(task.id)
              return
            }
          } catch {
            // If subtask check fails, proceed with normal start
          }

          const maxParallel = agent.config.max_parallel_sessions || 1
          const currentRunning = getRunningCount(agentId)

          if (currentRunning < maxParallel) {
            startTasksForAgent(agentId, [task.id], agent)
          } else {
            addToQueue(agentId, task.id)
          }
        }, 100)
      }

      // Check if task needs triage (no agent_id, not_started)
      if (
        task.status === TaskStatus.NotStarted &&
        !task.agent_id &&
        !isSnoozed(task.snoozed_until) &&
        !getSessionsSnapshot().has(task.id) &&
        !triagingRef.current.has(task.id) &&
        (triageAttemptsRef.current.get(task.id) || 0) < MAX_TRIAGE_ATTEMPTS
      ) {
        // Skip subtasks — they don't need independent triage
        if (task.parent_task_id) return
        setTimeout(() => startTriage(task.id), 200)
      }
    })

    return unsubscribe
  }, [
    isEnabled,
    getSessionsSnapshot,
    isSnoozed,
    getRunningCount,
    addToQueue,
    startTasksForAgent,
    startTriage,
    startNextSubtask
  ])

  // Clear queues when disabled
  useEffect(() => {
    if (!isEnabled) {
      clearQueues()
    }
  }, [isEnabled, clearQueues])

  // Periodic check every minute to ensure no tasks are stuck.
  // Reads tasks/agents from refs so the interval is never cleared/recreated
  // due to task updates — it runs for the full 60s as intended.
  useEffect(() => {
    if (!isEnabled) return

    console.log('[AutoStart] Starting periodic check (every 60s)')

    const intervalId = setInterval(() => {
      console.log('[AutoStart] Periodic check: scanning for eligible tasks...')

      // Read latest from refs
      const latestTasks = tasksRef.current
      const latestAgents = agentsRef.current

      // Check triage candidates
      const sessions = getSessionsSnapshot()
      const triageCandidates = selectTriageCandidates(latestTasks, sessions)
      if (triageCandidates.length > 0) {
        console.log(`[AutoStart] Periodic check: found ${triageCandidates.length} triage candidate(s)`)
        triageCandidates.forEach((taskId) => startTriage(taskId))
      }

      const tasksByAgent = selectEligibleTasks(latestTasks, sessions)

      if (tasksByAgent.size === 0) {
        console.log('[AutoStart] Periodic check: no eligible tasks found')
        return
      }

      console.log('[AutoStart] Periodic check: found eligible tasks for',
        tasksByAgent.size, 'agent(s)')

      tasksByAgent.forEach((taskIds, agentId) => {
        const agent = latestAgents.find((a) => a.id === agentId)
        if (!agent) return

        const maxParallel = agent.config.max_parallel_sessions || 1
        const currentRunning = getRunningCount(agentId)
        const availableSlots = maxParallel - currentRunning

        console.log(`[AutoStart] Periodic check: Agent ${agent.name}:`,
          `${currentRunning}/${maxParallel} running, ${availableSlots} slots available,`,
          `${taskIds.length} eligible tasks`)

        if (availableSlots > 0 && taskIds.length > 0) {
          console.log(`[AutoStart] Periodic check: Starting tasks for ${agent.name}`)
          startTasksForAgent(agentId, taskIds, agent)
        }
      })
    }, 60000) // Check every 60 seconds

    return () => {
      console.log('[AutoStart] Stopping periodic check')
      clearInterval(intervalId)
    }
  }, [isEnabled, getSessionsSnapshot, selectEligibleTasks, selectTriageCandidates, getRunningCount, startTasksForAgent, startTriage])
}
