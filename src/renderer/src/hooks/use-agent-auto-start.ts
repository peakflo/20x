import { useEffect, useRef, useCallback } from 'react'
import { useAgentSchedulerStore } from '@/stores/agent-scheduler-store'
import { useAgentStore } from '@/stores/agent-store'
import { useAgentSession } from './use-agent-session'
import { onAgentStatus, onTaskUpdated, onTaskCreated, taskApi } from '@/lib/ipc-client'
import { TaskStatus } from '@/types'
import type { WorkfloTask, Agent, TaskPriority } from '@/types'
import type { AgentStatusEvent } from '@/types/electron.d'
import type { TaskSession } from '@/stores/agent-store'

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
}

const MAX_TRIAGE_ATTEMPTS = 2

interface UseAgentAutoStartProps {
  tasks: WorkfloTask[]
  agents: Agent[]
  sessions: Map<string, TaskSession>
  showToast: (message: string, isError?: boolean) => void
}

export function useAgentAutoStart({ tasks, agents, sessions, showToast }: UseAgentAutoStartProps) {
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

  const { start } = useAgentSession(undefined)

  // Track processed task updates to avoid duplicates
  const processedUpdatesRef = useRef<Set<string>>(new Set())

  // Track tasks currently being triaged
  const triagingRef = useRef<Set<string>>(new Set())

  // Track triage attempts per task to prevent infinite retry
  const triageAttemptsRef = useRef<Map<string, number>>(new Map())

  // Helper: Check if task is snoozed
  const isSnoozed = useCallback((snoozedUntil: string | null): boolean => {
    if (!snoozedUntil) return false
    return new Date(snoozedUntil) > new Date()
  }, [])

  // Helper: Select triage candidates (tasks with no agent_id that need triage)
  const selectTriageCandidates = useCallback(
    (allTasks: WorkfloTask[], allSessions: Map<string, TaskSession>): string[] => {
      return allTasks
        .filter((task) => {
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
    [isSnoozed]
  )

  // Helper: Start triage for a task
  const startTriage = useCallback(
    async (taskId: string) => {
      // Find default agent
      const defaultAgent = agents.find((a) => a.is_default) || agents[0]
      if (!defaultAgent) {
        console.log('[AutoStart] No agents available for triage')
        return
      }

      const task = tasks.find((t) => t.id === taskId)
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
    [agents, tasks, incrementRunningCount, start, decrementRunningCount]
  )

  // Helper: Select eligible tasks grouped by agent
  const selectEligibleTasks = useCallback(
    (
      allTasks: WorkfloTask[],
      allSessions: Map<string, TaskSession>
    ): Map<string, string[]> => {
      const tasksByAgent = new Map<string, string[]>()

      allTasks.forEach((task) => {
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
          return PRIORITY_ORDER[taskA.priority] - PRIORITY_ORDER[taskB.priority]
        })
        tasksByAgent.set(agentId, sortedIds)
      })

      return tasksByAgent
    },
    [isSnoozed]
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
          const task = tasks.find((t) => t.id === taskId)
          if (!task) continue

          incrementRunningCount(agentId)
          await start(agentId, taskId)

          showToast(`Started "${task.title}" with ${agent.name}`)
        } catch (error) {
          console.error(`Failed to start task ${taskId}:`, error)
          decrementRunningCount(agentId)
          showToast(`Failed to start task: ${error}`, true)
        }
      }
    },
    [tasks, getRunningCount, addToQueue, incrementRunningCount, start, showToast, decrementRunningCount]
  )

  // Helper: Process next task in queue for an agent
  const processNextTask = useCallback(
    async (agentId: string) => {
      const agent = agents.find((a) => a.id === agentId)
      if (!agent) return

      const maxParallel = agent.config.max_parallel_sessions || 1
      const currentRunning = getRunningCount(agentId)

      if (currentRunning >= maxParallel) return

      const nextTaskId = getNextQueuedTask(agentId)
      if (!nextTaskId) return

      const task = tasks.find((t) => t.id === nextTaskId)
      if (!task) {
        removeFromQueue(agentId, nextTaskId)
        return
      }

      // Verify task is still eligible
      if (
        task.status !== TaskStatus.NotStarted ||
        task.agent_id !== agentId ||
        isSnoozed(task.snoozed_until) ||
        sessions.has(task.id)
      ) {
        removeFromQueue(agentId, nextTaskId)
        return
      }

      // Start the task
      try {
        removeFromQueue(agentId, nextTaskId)
        incrementRunningCount(agentId)
        await start(agentId, nextTaskId)

        showToast(`Started "${task.title}" with ${agent.name}`)
      } catch (error) {
        console.error(`Failed to start task ${nextTaskId}:`, error)
        decrementRunningCount(agentId)
        showToast(`Failed to start task: ${error}`, true)
      }
    },
    [
      agents,
      tasks,
      sessions,
      getRunningCount,
      getNextQueuedTask,
      removeFromQueue,
      incrementRunningCount,
      isSnoozed,
      start,
      showToast,
      decrementRunningCount
    ]
  )

  // Auto-start eligible tasks when scheduler is enabled or when tasks/agents change
  useEffect(() => {
    if (!isEnabled) return

    console.log('[AutoStart] Checking for eligible tasks...', {
      totalTasks: tasks.length,
      totalAgents: agents.length,
      activeSessions: sessions.size
    })

    // Debounce to avoid rapid-fire starts when multiple tasks/agents change
    const timeoutId = setTimeout(() => {
      // Check for triage candidates (tasks with no agent_id)
      const triageCandidates = selectTriageCandidates(tasks, sessions)
      if (triageCandidates.length > 0) {
        console.log(`[AutoStart] Found ${triageCandidates.length} triage candidate(s)`)
        triageCandidates.forEach((taskId) => startTriage(taskId))
      }

      // Check for regular auto-start eligible tasks (with agent_id)
      const tasksByAgent = selectEligibleTasks(tasks, sessions)

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
        const agent = agents.find((a) => a.id === agentId)
        if (agent && taskIds.length > 0) {
          console.log(`[AutoStart] Starting tasks for agent ${agent.name}:`, taskIds)
          startTasksForAgent(agentId, taskIds, agent)
        }
      })
    }, 300) // 300ms debounce

    return () => clearTimeout(timeoutId)
  }, [isEnabled, tasks, agents, sessions, selectEligibleTasks, selectTriageCandidates, startTasksForAgent, startTriage])

  // Listen to agent status changes (task completions)
  useEffect(() => {
    if (!isEnabled) return

    const unsubscribe = onAgentStatus((event: AgentStatusEvent) => {
      // Only process when agent goes idle (task completed)
      if (event.status !== 'idle') return

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
              showToast(`Triage failed for "${updatedTask.title}" — please assign an agent manually`, true)
            } else {
              console.log(`[AutoStart] Triage attempt ${attempts} did not assign agent for task ${taskId}, will retry`)
            }
          } else if (updatedTask?.agent_id) {
            // Clean up attempts on success
            triageAttemptsRef.current.delete(taskId)
          }
        }, 500)

        // Try to start next task from queue for this agent
        setTimeout(() => processNextTask(agentId), 100)
        return
      }

      // Decrement running count
      decrementRunningCount(agentId)

      // Check if task was completed
      const task = tasks.find((t) => t.id === event.taskId)
      if (task?.status === TaskStatus.Completed) {
        const agent = agents.find((a) => a.id === agentId)
        if (agent) {
          showToast(`"${task.title}" completed by ${agent.name}`)
        }
      }

      // Try to start next task from queue
      setTimeout(() => {
        processNextTask(agentId)
      }, 100)
    })

    return unsubscribe
  }, [isEnabled, tasks, agents, decrementRunningCount, showToast, processNextTask])

  // Listen to new task creation — trigger triage for tasks with no agent_id
  useEffect(() => {
    if (!isEnabled) return

    const unsubscribe = onTaskCreated((event) => {
      const task = event.task
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

  // Listen to task updates (new tasks or reassignments)
  useEffect(() => {
    if (!isEnabled) return

    const unsubscribe = onTaskUpdated((event) => {
      const updateKey = `${event.taskId}-${JSON.stringify(event.updates)}`

      // Debounce duplicate updates
      if (processedUpdatesRef.current.has(updateKey)) return
      processedUpdatesRef.current.add(updateKey)
      setTimeout(() => processedUpdatesRef.current.delete(updateKey), 1000)

      const staleTask = tasks.find((t) => t.id === event.taskId)
      if (!staleTask) return

      // Merge event updates with stale task to get current state
      const task = { ...staleTask, ...event.updates } as WorkfloTask

      // Check if task is eligible for auto-start (has agent_id)
      if (
        task.status === TaskStatus.NotStarted &&
        task.agent_id &&
        !isSnoozed(task.snoozed_until) &&
        !sessions.has(task.id)
      ) {
        const agentId = task.agent_id
        const agent = agents.find((a) => a.id === agentId)
        if (!agent) return

        const maxParallel = agent.config.max_parallel_sessions || 1
        const currentRunning = getRunningCount(agentId)

        if (currentRunning < maxParallel) {
          // Start immediately
          setTimeout(() => {
            startTasksForAgent(agentId, [task.id], agent)
          }, 100)
        } else {
          // Add to queue
          addToQueue(agentId, task.id)
        }
      }

      // Check if task needs triage (no agent_id, not_started)
      if (
        task.status === TaskStatus.NotStarted &&
        !task.agent_id &&
        !isSnoozed(task.snoozed_until) &&
        !sessions.has(task.id) &&
        !triagingRef.current.has(task.id) &&
        (triageAttemptsRef.current.get(task.id) || 0) < MAX_TRIAGE_ATTEMPTS
      ) {
        setTimeout(() => startTriage(task.id), 200)
      }
    })

    return unsubscribe
  }, [
    isEnabled,
    tasks,
    agents,
    sessions,
    isSnoozed,
    getRunningCount,
    addToQueue,
    startTasksForAgent,
    startTriage
  ])

  // Clear queues when disabled
  useEffect(() => {
    if (!isEnabled) {
      clearQueues()
    }
  }, [isEnabled, clearQueues])

  // Periodic check every minute to ensure no tasks are stuck
  useEffect(() => {
    if (!isEnabled) return

    console.log('[AutoStart] Starting periodic check (every 60s)')

    const intervalId = setInterval(() => {
      console.log('[AutoStart] Periodic check: scanning for eligible tasks...')

      // Check triage candidates
      const triageCandidates = selectTriageCandidates(tasks, sessions)
      if (triageCandidates.length > 0) {
        console.log(`[AutoStart] Periodic check: found ${triageCandidates.length} triage candidate(s)`)
        triageCandidates.forEach((taskId) => startTriage(taskId))
      }

      const tasksByAgent = selectEligibleTasks(tasks, sessions)

      if (tasksByAgent.size === 0) {
        console.log('[AutoStart] Periodic check: no eligible tasks found')
        return
      }

      console.log('[AutoStart] Periodic check: found eligible tasks for',
        tasksByAgent.size, 'agent(s)')

      tasksByAgent.forEach((taskIds, agentId) => {
        const agent = agents.find((a) => a.id === agentId)
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
  }, [isEnabled, tasks, agents, sessions, selectEligibleTasks, selectTriageCandidates, getRunningCount, startTasksForAgent, startTriage])
}
