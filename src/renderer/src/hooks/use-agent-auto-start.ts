import { useEffect, useRef, useCallback } from 'react'
import { useAgentSchedulerStore } from '@/stores/agent-scheduler-store'
import { useAgentSession } from './use-agent-session'
import { onAgentStatus, onTaskUpdated } from '@/lib/ipc-client'
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

  // Helper: Check if task is snoozed
  const isSnoozed = useCallback((snoozedUntil: string | null): boolean => {
    if (!snoozedUntil) return false
    return new Date(snoozedUntil) > new Date()
  }, [])

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
  }, [isEnabled, tasks, agents, sessions, selectEligibleTasks, startTasksForAgent])

  // Listen to agent status changes (task completions)
  useEffect(() => {
    if (!isEnabled) return

    const unsubscribe = onAgentStatus((event: AgentStatusEvent) => {
      // Only process when agent goes idle (task completed)
      if (event.status !== 'idle') return

      const agentId = event.agentId

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

  // Listen to task updates (new tasks or reassignments)
  useEffect(() => {
    if (!isEnabled) return

    const unsubscribe = onTaskUpdated((event) => {
      const updateKey = `${event.taskId}-${JSON.stringify(event.updates)}`

      // Debounce duplicate updates
      if (processedUpdatesRef.current.has(updateKey)) return
      processedUpdatesRef.current.add(updateKey)
      setTimeout(() => processedUpdatesRef.current.delete(updateKey), 1000)

      const task = tasks.find((t) => t.id === event.taskId)
      if (!task) return

      // Check if task is eligible for auto-start
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
    startTasksForAgent
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
  }, [isEnabled, tasks, agents, sessions, selectEligibleTasks, getRunningCount, startTasksForAgent])
}
